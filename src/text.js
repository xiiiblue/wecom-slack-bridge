// Iterate Unicode code points; never split a surrogate pair or UTF-8 sequence.
export function chunks(text, maxBytes) {
  if (maxBytes < 4) throw new Error('Chunk budget too small');
  const result = []; let part = ''; let size = 0;
  for (const char of text) {
    const bytes = Buffer.byteLength(char);
    if (size + bytes > maxBytes) { result.push(part); part = ''; size = 0; }
    part += char; size += bytes;
  }
  if (part) result.push(part);
  return result;
}
export const slackEscape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
// Do not resolve Slack mentions or fetch URLs/files; preserve their visible syntax.
export const slackDecode = text => text.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');

// Only unwrap Slack's unlabeled HTTP(S) autolinks for comparison. Labeled
// links must match their complete URL/label syntax or the visible projection.
const comparable = text => text.replace(/<(https?:\/\/[^<>\s|]+)>/g, '$1').replace(/\s+/g, ' ').trim();

// Add only missing line boundaries. Keep existing CR/LF, horizontal spacing,
// visible text and Slack URL syntax byte-for-byte wherever no break is added.
function enrichBreaks(original, candidate) {
  const source = original.match(/\s+|\S+/g) || [];
  const target = candidate.match(/\s+|\S+/g) || [];
  const gaps = []; let gap = '';
  for (const token of target) {
    if (/^\s+$/.test(token)) gap += token;
    else { gaps.push(gap); gap = ''; }
  }
  let word = 0;
  return source.map((token, index) => {
    if (!/^\s+$/.test(token)) { word++; return token; }
    // Leading/trailing whitespace and already-present breaks are authoritative.
    if (!word || index === source.length - 1 || /[\r\n]/.test(token)) return token;
    return /[\r\n]/.test(gaps[word] || '') ? gaps[word] : token;
  }).join('');
}

// Slack may flatten rich-text newlines in event.text. Restore layout only when
// every node is supported and the body still matches the authorized plain text.
// Never use blocks to authorize routing or to replace differing message content.
export function slackReplyBody(event, route) {
  const fallback = slackDecode(route[2]);
  if (!Array.isArray(event.blocks) || !event.blocks.length) return fallback;
  // Different messages expose links as visible labels, URLs or Slack markup.
  // Match and emit the SAME projection so a label cannot authorize a new URL.
  for (const linkMode of ['visible', 'url', 'markup']) {
    const sections = []; let bytes = 0;
    const readSection = section => {
      if (section?.type !== 'rich_text_section' || !Array.isArray(section.elements)) return null;
      if (++bytes > 160000) return null;
      const inline = [];
      for (const node of section.elements) {
        let text;
        if (node?.type === 'text' && typeof node.text === 'string') text = node.text;
        else if (node?.type === 'link' && typeof node.url === 'string' && /^https?:\/\/[^<>\s|]+$/.test(node.url) &&
            (node.text === undefined || typeof node.text === 'string')) {
          bytes += Buffer.byteLength(node.url) + Buffer.byteLength(node.text || '');
          text = linkMode === 'visible' ? (node.text || node.url) : linkMode === 'url' ? node.url :
            node.text ? `<${node.url}|${node.text}>` : `<${node.url}>`;
        } else return null;
        bytes += Buffer.byteLength(text) + 1;
        if (bytes > 160000) return null;
        inline.push(text);
      }
      return inline.join('');
    };
    for (const block of event.blocks) {
      if (block?.type !== 'rich_text' || !Array.isArray(block.elements) || !block.elements.length) return fallback;
      for (const section of block.elements) {
        if (section?.type === 'rich_text_section') {
          const text = readSection(section);
          if (text === null) return fallback;
          sections.push([text]);
        } else if (section?.type === 'rich_text_list') {
          const { style, elements, indent = 0, offset = 0 } = section;
          if (!['bullet', 'ordered'].includes(style) || !Array.isArray(elements) || !elements.length || elements.length > 1000 ||
              !Number.isSafeInteger(indent) || indent < 0 || indent > 8 || !Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) return fallback;
          const items = elements.map(readSection);
          if (items.some(item => item === null || !item.trim())) return fallback;
          // Compare markers only at actual list positions, independently per list.
          sections.push([0, 1, 2, 3].map(variant => items.map((item, i) => {
            const prefixes = style === 'bullet' ? ['• ', '- ', '* ', ''] : [`${offset + i + 1}. `, `${offset + i + 1}) `, `${offset + i + 1}. `, ''];
            return '  '.repeat(indent) + prefixes[variant] + item;
          }).join('\n')));
        } else return fallback;
      }
    }
    const rendered = sections.map(section => section[0]).join('\n');
    if (Buffer.byteLength(rendered) > 160000) return fallback;
    const marker = /^\[wecom:([^\]]+)\]/.exec(rendered);
    if (marker && marker[1] !== route[1]) return null;
    const candidate = /^\[wecom:(owner|review|group)\]\s*([\s\S]+)$/.exec(rendered);
    if (!candidate) continue;
    // Prefix matching bounds the search instead of expanding 4^N layouts.
    // Each state records an exact normalized prefix of the authorized body.
    const expected = comparable(fallback);
    let states = new Map([[0, null]]);
    for (const [index, options] of sections.entries()) {
      const next = new Map();
      for (const option of options) {
        const body = index === 0 ? option.replace(/^\[wecom:(owner|review|group)\]\s*/, '') : option;
        const normalized = comparable(slackDecode(body));
        for (const [position, chosen] of states) {
          const part = normalized ? (position ? ' ' : '') + normalized : '';
          if (expected.startsWith(part, position)) next.set(position + part.length, { previous: chosen, body });
        }
      }
      if (next.size > 256) return fallback;
      states = next;
      if (!states.size) break;
    }
    const matched = states.get(expected.length);
    if (!matched) continue;
    const chosen = [];
    for (let entry = matched; entry; entry = entry.previous) chosen.push(entry.body);
    const body = slackDecode(candidate[2]);
    if (!/[\r\n]/.test(body)) return fallback;
    return /[\r\n]/.test(fallback) ? enrichBreaks(fallback, slackDecode(chosen.reverse().join('\n')).trimStart()) : body;
  }
  return fallback;
}

// Display only: fixed UTC+08:00, independent of the host TZ. Keep stored epoch unchanged.
export const formatDeadline = epoch => new Date(epoch + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
