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

// Slack may flatten rich-text newlines in event.text. Restore layout only when
// every node is supported and the body still matches the authorized plain text.
// Never use blocks to authorize routing or to replace differing message content.
export function slackReplyBody(event, route) {
  const fallback = slackDecode(route[2]);
  if (!Array.isArray(event.blocks) || !event.blocks.length) return fallback;
  const sections = [];
  let bytes = 0;
  const readSection = section => {
    if (section?.type !== 'rich_text_section' || !Array.isArray(section.elements)) return null;
    if (++bytes > 160000) return null;
    const inline = [];
    for (const node of section.elements) {
      if (node?.type !== 'text' || typeof node.text !== 'string') return null;
      bytes += Buffer.byteLength(node.text) + 1;
      if (bytes > 160000) return null;
      inline.push(node.text);
    }
    return inline.join('');
  };
  for (const block of event.blocks) {
    if (block?.type !== 'rich_text' || !Array.isArray(block.elements) || !block.elements.length) return fallback;
    for (const section of block.elements) {
      if (section?.type === 'rich_text_section') {
        const text = readSection(section);
        if (text === null) return fallback;
        sections.push([text, text, text, text]);
      } else if (section?.type === 'rich_text_list') {
        const { style, elements, indent = 0, offset = 0 } = section;
        if (!['bullet', 'ordered'].includes(style) || !Array.isArray(elements) || !elements.length || elements.length > 1000 ||
            !Number.isSafeInteger(indent) || indent < 0 || indent > 8 || !Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) return fallback;
        const items = elements.map(readSection);
        if (items.some(item => item === null || !item.trim())) return fallback;
        // Compare only structural list-marker variants; never strip arbitrary body text.
        sections.push([0, 1, 2, 3].map(variant => items.map((item, i) => {
          const prefixes = style === 'bullet' ? ['• ', '- ', '* ', ''] : [`${offset + i + 1}. `, `${offset + i + 1}) `, `${offset + i + 1}. `, ''];
          return '  '.repeat(indent) + prefixes[variant] + item;
        }).join('\n')));
      } else return fallback;
    }
  }
  const layouts = [0, 1, 2, 3].map(variant => sections.map(section => section[variant]).join('\n'));
  const rendered = layouts[0];
  if (Buffer.byteLength(rendered) > 160000) return fallback;
  const marker = /^\[wecom:([^\]]+)\]/.exec(rendered);
  if (marker && marker[1] !== route[1]) return null;
  const candidate = /^\[wecom:(owner|review|group)\]\s*([\s\S]+)$/.exec(rendered);
  if (!candidate) return fallback;
  const body = slackDecode(candidate[2]);
  const normalized = text => text.replace(/\s+/g, ' ').trim();
  const equivalent = layouts.some(layout => {
    const variant = /^\[wecom:(owner|review|group)\]\s*([\s\S]+)$/.exec(layout);
    return variant?.[1] === route[1] && normalized(slackDecode(variant[2])) === normalized(fallback);
  });
  if (!equivalent) return fallback;
  // Preserve existing layout; blocks may only enrich a body with no line breaks.
  return /[\r\n]/.test(fallback) || !/[\r\n]/.test(body) ? fallback : body;
}

// Display only: fixed UTC+08:00, independent of the host TZ. Keep stored epoch unchanged.
export const formatDeadline = epoch => new Date(epoch + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
