/**
 * Longest prefix of `text` made of whole code points whose UTF-16 length is at most
 * `maxLength`. A plain `slice` can cut an emoji (surrogate pair) in two and leave a
 * lone surrogate, which the database stores as U+FFFD. The length is `string.length`
 * (UTF-16 units) because that is what the zod `.max()` checks count.
 */
export function truncateToLength(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  let end = 0;
  for (const char of text) {
    if (end + char.length > maxLength) break;
    end += char.length;
  }
  return text.slice(0, end);
}
