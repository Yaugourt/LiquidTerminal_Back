/**
 * Titles for X (Twitter) posts.
 *
 * X serves `<Name> (@<handle>) on X` as og:title and the post body as
 * og:description. A card title must be a headline, not a 255-character body
 * with line breaks, so the stored preview is:
 *   title       = the post's headline (its first non-empty line, URLs removed)
 *   description = `<Name> (@<handle>) on X` (who wrote it)
 * X articles expose their own title in og:title instead of the author line;
 * that title is kept as it is.
 */

const MAX_HEADLINE = 140;

/** True for x.com / twitter.com and their subdomains. */
export function isXHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'x.com' || h === 'twitter.com' || h.endsWith('.x.com') || h.endsWith('.twitter.com');
}

/** `<Name> (@<handle>) on X`, the author line X puts in og:title. */
const AUTHOR_LINE = /^(.+) \(@([A-Za-z0-9_]{1,15})\) on (X|Twitter)$/;

export function parseXAuthor(line: string | null | undefined): { name: string; handle: string } | null {
  const m = line?.trim().match(AUTHOR_LINE);
  return m ? { name: m[1].trim(), handle: m[2] } : null;
}

/** First non-empty line of a post, without links, cut at a word boundary. */
export function xHeadline(text: string | null | undefined): string | null {
  if (!text) return null;
  const line = text
    .split('\n')
    .map((l) => l.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim())
    .find((l) => l.length > 0);
  if (!line) return null;
  if (line.length <= MAX_HEADLINE) return line;
  const cut = line.slice(0, MAX_HEADLINE);
  const space = cut.lastIndexOf(' ');
  return `${(space > 40 ? cut.slice(0, space) : cut).replace(/[\s,;:-]+$/, '')}…`;
}

/**
 * og:title / og:description of an X page -> stored title / description.
 * Posts: og:title is the author line, og:description the body.
 * Articles: og:title is the article title, kept as the title.
 */
export function xPreviewText(
  ogTitle: string | null,
  ogDescription: string | null,
): { title: string | null; description: string | null } {
  if (parseXAuthor(ogTitle)) {
    return { title: xHeadline(ogDescription) ?? ogTitle, description: ogTitle };
  }
  return { title: ogTitle, description: ogDescription };
}
