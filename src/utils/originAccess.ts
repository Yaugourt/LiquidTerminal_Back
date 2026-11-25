import { SECURITY_CONSTANTS } from '../constants/security.constants';

/**
 * What a browser page may do with this API, by the origin it was served from.
 *
 * - `full`: our own pages (ALLOWED_ORIGINS).
 * - `read`: a preview deployment of the front. It reads, and never changes anything.
 * - `none`: any other site.
 */
export type OriginAccess = 'full' | 'read' | 'none';

/** A Vercel team's slug. */
const VERCEL_SCOPE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The addresses Vercel gives the preview deployments of `project` in the team `scope`
 * (https://vercel.com/docs/deployments/generated-urls):
 *
 *   https://<project>-<9 letters or digits>-<scope>.vercel.app   one commit
 *   https://<project>-git-<branch>-<scope>.vercel.app            one branch
 *
 * Null when `scope` is not a team's slug (`false` switches previews off; a wildcard opens nothing).
 *
 * A match is not a proof of who serves the page: someone else can name a team so that an address
 * of theirs reads like one of ours. This is why a preview only reads: such a page gets public
 * data it could fetch from its own server. It holds no session of ours (the token lives in our
 * pages' storage and travels in a header; there is no cookie).
 */
export function previewOriginPattern(project: string, scope: string): RegExp | null {
  if (scope === 'false' || !VERCEL_SCOPE.test(scope)) return null;
  return new RegExp(`^https://${project}-(?:[a-z0-9]{9}|git-[a-z0-9-]{1,50})-${scope}\\.vercel\\.app$`);
}

const PREVIEW_ORIGIN = previewOriginPattern(SECURITY_CONSTANTS.PREVIEW_PROJECT, SECURITY_CONSTANTS.PREVIEW_SCOPE);

/** What a page served from `origin` (the request's `Origin` header) may do here. */
export function originAccess(origin: string): OriginAccess {
  if ((SECURITY_CONSTANTS.ALLOWED_ORIGINS as readonly string[]).includes(origin)) return 'full';
  if (PREVIEW_ORIGIN?.test(origin)) return 'read';
  return 'none';
}
