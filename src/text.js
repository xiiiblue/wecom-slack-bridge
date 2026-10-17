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
  for (const block of event.blocks) {
    if (block?.type !== 'rich_text' || !Array.isArray(block.elements) || !block.elements.length) return fallback;
    for (const section of block.elements) {
      if (section?.type !== 'rich_text_section' || !Array.isArray(section.elements)) return fallback;
      const inline = [];
      for (const node of section.elements) {
        if (node?.type !== 'text' || typeof node.text !== 'string') return fallback;
        bytes += Buffer.byteLength(node.text);
        if (bytes > 160000) return fallback;
        inline.push(node.text);
      }
      bytes += 1;
      if (bytes > 160000) return fallback;
      sections.push(inline.join(''));
    }
  }
  const rendered = sections.join('\n');
  const marker = /^\[wecom:([^\]]+)\]/.exec(rendered);
  if (marker && marker[1] !== route[1]) return null;
  const candidate = /^\[wecom:(owner|review|group)\]\s*([\s\S]+)$/.exec(rendered);
  if (!candidate) return fallback;
  const body = slackDecode(candidate[2]);
  const normalized = text => text.replace(/\s+/g, ' ').trim();
  return normalized(body) === normalized(fallback) ? body : fallback;
}

// Display only: fixed UTC+08:00, independent of the host TZ. Keep stored epoch unchanged.
export const formatDeadline = epoch => new Date(epoch + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
