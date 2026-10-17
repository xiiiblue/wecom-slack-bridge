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
