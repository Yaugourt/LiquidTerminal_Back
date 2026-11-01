import { FieldDiff, HypurrProject, LtProject, MatchReason, MatchedProject, SyncDiff } from './hypurr-sync.types';

/**
 * Pure matcher between Hypurr Collective projects and Liquid Terminal projects.
 *
 * Match keys, strongest first (each project is matched at most once on each side):
 *   1. X/Twitter handle
 *   2. website registrable domain (shared hosts like linktr.ee / x.com are ignored)
 *   3. normalized name (case, accents, punctuation and spaces dropped)
 *   4. loose name (same, minus a trailing "protocol", "finance", "labs"... word)
 * A key shared by several LT projects is ambiguous: it is skipped and reported.
 */

export const DESC_MAX = 255;

/** Hosts that do not identify a project on their own. */
const GENERIC_HOSTS = new Set([
  'x.com', 'twitter.com', 't.me', 'telegram.me', 'discord.gg', 'discord.com', 'github.com',
  'linktr.ee', 'medium.com', 'mirror.xyz', 'notion.so', 'notion.site', 'gitbook.io', 'docs.google.com',
  'google.com', 'youtube.com', 'hyperliquid.xyz', 'app.hyperliquid.xyz', 'hypurr.co', 'substack.com',
  'apps.apple.com', 'play.google.com', 'testflight.apple.com',
]);

/** Hosting suffixes where the project lives on a subdomain (keep one more label). */
const SHARED_SUFFIXES = new Set([
  'vercel.app', 'github.io', 'gitbook.io', 'netlify.app', 'pages.dev', 'notion.site', 'substack.com',
  'medium.com', 'webflow.io', 'framer.website', 'framer.app', 'carrd.co', 'mirror.xyz',
]);

const TWITTER_RESERVED = new Set(['i', 'intent', 'home', 'search', 'messages', 'share', 'hashtag']);

const LOOSE_SUFFIXES = /(protocol|finance|fi|labs|lab|app|exchange|network|dao|xyz|io|official|hq)$/;

/** Hypurr tag -> LT category name, for tags whose normalized names differ. Keys are normalized. */
const CATEGORY_ALIASES: Record<string, string> = {
  defiyields: 'DEFI',
  funds: 'Fund',
  gamefi: 'Gaming',
};

export function normalizeName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

export function looseName(name: string): string {
  const n = normalizeName(name);
  const stripped = n.replace(LOOSE_SUFFIXES, '');
  return stripped.length >= 3 ? stripped : n;
}

function parseUrl(raw: string | null | undefined): URL | null {
  if (!raw) return null;
  const v = raw.trim();
  if (!v) return null;
  try {
    return new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
  } catch {
    return null;
  }
}

/** Registrable domain used as a match key, or null for generic/unparseable URLs. */
export function domainKey(raw: string | null | undefined): string | null {
  const u = parseUrl(raw);
  if (!u) return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (!host.includes('.') || GENERIC_HOSTS.has(host)) return null;
  const labels = host.split('.');
  const lastTwo = labels.slice(-2).join('.');
  if (GENERIC_HOSTS.has(lastTwo) && !SHARED_SUFFIXES.has(lastTwo)) return null;
  if (SHARED_SUFFIXES.has(lastTwo)) return labels.length >= 3 ? labels.slice(-3).join('.') : null;
  return lastTwo;
}

/** Lowercase X handle from a URL ("https://x.com/Foo/" -> "foo") or a bare "@foo". */
export function twitterHandle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim();
  const bare = v.match(/^@?([A-Za-z0-9_]{1,30})$/);
  if (bare) return bare[1].toLowerCase();
  const u = parseUrl(v);
  if (!u || !/^(www\.|mobile\.)?(x|twitter)\.com$/i.test(u.hostname)) return null;
  const first = u.pathname.split('/').filter(Boolean)[0];
  if (!first || TWITTER_RESERVED.has(first.toLowerCase()) || !/^[A-Za-z0-9_]{1,30}$/.test(first)) return null;
  return first.toLowerCase();
}

function telegramKey(raw: string | null | undefined): string | null {
  const u = parseUrl(raw);
  if (!u || !/^(www\.)?(t\.me|telegram\.me)$/i.test(u.hostname)) return raw ? raw.trim().toLowerCase() : null;
  return u.pathname.replace(/\/+$/, '').toLowerCase() || null;
}

/** Discord invite code ("discord.gg/abc" and "discord.com/invite/abc" -> "abc"). */
function discordKey(raw: string | null | undefined): string | null {
  const u = parseUrl(raw);
  if (!u) return raw ? raw.trim().toLowerCase() : null;
  const last = u.pathname.split('/').filter(Boolean).pop();
  return last ? last.toLowerCase() : u.hostname.toLowerCase();
}

function normText(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Truncate to the DB column size on a word boundary. */
export function truncateDesc(text: string, max: number = DESC_MAX): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s.,;:-]+$/, '')}…`;
}

/** LT logo considered empty: blank or the CSV importer placeholder. */
export function isPlaceholderLogo(logo: string | null | undefined): boolean {
  return !logo || !logo.trim() || /placeholder/i.test(logo);
}

/** LT description considered empty: blank or equal to the title (importer fallback). */
export function isPlaceholderDesc(desc: string | null | undefined, title: string): boolean {
  const d = normText(desc);
  return d.length === 0 || d === normText(title);
}

/**
 * Resolve Hypurr tags to LT category names. Returns the existing LT name when one
 * matches (by normalized name or alias), else the Hypurr tag as-is (to be created).
 */
export function mapCategories(tags: string[], ltCategoryNames: string[]): { name: string; exists: boolean }[] {
  const byNorm = new Map(ltCategoryNames.map((n) => [normalizeName(n), n]));
  const out = new Map<string, { name: string; exists: boolean }>();
  for (const tag of tags) {
    const norm = normalizeName(tag);
    const alias = CATEGORY_ALIASES[norm];
    const existing = byNorm.get(norm) ?? (alias ? byNorm.get(normalizeName(alias)) : undefined);
    const resolved = existing ? { name: existing, exists: true } : { name: tag, exists: false };
    out.set(normalizeName(resolved.name), resolved);
  }
  return [...out.values()];
}

/** Field differences for one matched pair. Only listed when Hypurr has a value. */
export function diffFields(h: HypurrProject, lt: LtProject, ltCategoryNames: string[]): FieldDiff[] {
  const diffs: FieldDiff[] = [];

  if (h.website) {
    if (!lt.website?.trim()) diffs.push({ field: 'website', lt: null, hypurr: h.website, fillable: true });
    else if (domainKey(lt.website) !== domainKey(h.website)) {
      diffs.push({ field: 'website', lt: lt.website, hypurr: h.website, fillable: false });
    }
  }

  const hHandle = twitterHandle(h.twitter);
  if (h.twitter && hHandle) {
    if (!lt.twitter?.trim()) diffs.push({ field: 'twitter', lt: null, hypurr: h.twitter, fillable: true });
    else if (twitterHandle(lt.twitter) !== hHandle) {
      diffs.push({ field: 'twitter', lt: lt.twitter, hypurr: h.twitter, fillable: false });
    }
  }

  if (h.telegram) {
    if (!lt.telegram?.trim()) diffs.push({ field: 'telegram', lt: null, hypurr: h.telegram, fillable: true });
    else if (telegramKey(lt.telegram) !== telegramKey(h.telegram)) {
      diffs.push({ field: 'telegram', lt: lt.telegram, hypurr: h.telegram, fillable: false });
    }
  }

  if (h.discord) {
    if (!lt.discord?.trim()) diffs.push({ field: 'discord', lt: null, hypurr: h.discord, fillable: true });
    else if (discordKey(lt.discord) !== discordKey(h.discord)) {
      diffs.push({ field: 'discord', lt: lt.discord, hypurr: h.discord, fillable: false });
    }
  }

  // LT re-hosts logos on R2, so URLs always differ: only an empty LT logo is a diff.
  if (h.logo && isPlaceholderLogo(lt.logo)) {
    diffs.push({ field: 'logo', lt: lt.logo || null, hypurr: h.logo, fillable: true });
  }

  if (h.description) {
    const hd = normText(h.description);
    const ld = normText(lt.desc);
    if (isPlaceholderDesc(lt.desc, lt.title)) {
      diffs.push({ field: 'description', lt: lt.desc || null, hypurr: h.description, fillable: true });
    } else if (hd !== ld && !hd.startsWith(ld.replace(/…$/, '')) && !ld.startsWith(hd)) {
      diffs.push({ field: 'description', lt: lt.desc, hypurr: h.description, fillable: false });
    }
  }

  if (h.ticker) {
    if (!lt.token?.trim()) diffs.push({ field: 'token', lt: null, hypurr: h.ticker, fillable: true });
    else if (lt.token.replace(/^\$/, '').trim().toUpperCase() !== h.ticker.toUpperCase()) {
      diffs.push({ field: 'token', lt: lt.token, hypurr: h.ticker, fillable: false });
    }
  }

  if (h.categories.length > 0) {
    const mapped = mapCategories(h.categories, ltCategoryNames).map((c) => c.name);
    const ltNorm = new Set(lt.categories.map(normalizeName));
    const missingOnLt = mapped.filter((c) => !ltNorm.has(normalizeName(c)));
    if (missingOnLt.length > 0) {
      diffs.push({
        field: 'categories',
        lt: lt.categories.length > 0 ? lt.categories.join(', ') : null,
        hypurr: mapped.join(', '),
        fillable: lt.categories.length === 0,
      });
    }
  }

  return diffs;
}

type KeyFn = (name: string | null, website: string | null, twitter: string | null) => string | null;

const PASSES: { reason: MatchReason; key: KeyFn }[] = [
  { reason: 'twitter', key: (_n, _w, t) => twitterHandle(t) },
  { reason: 'website', key: (_n, w) => domainKey(w) },
  { reason: 'name', key: (n) => (n ? normalizeName(n) || null : null) },
  { reason: 'loose-name', key: (n) => (n ? looseName(n) || null : null) },
];

/** Match Hypurr projects against LT projects and compute the sync diff. */
export function matchProjects(hypurr: HypurrProject[], lt: LtProject[], ltCategoryNames: string[]): SyncDiff {
  const matched: MatchedProject[] = [];
  const usedLt = new Set<number>();
  const usedH = new Set<string>();
  const ambiguous = new Map<string, string[]>();

  for (const pass of PASSES) {
    // Index the still-unmatched LT projects by this pass's key.
    const index = new Map<string, LtProject[]>();
    for (const p of lt) {
      if (usedLt.has(p.id)) continue;
      const k = pass.key(p.title, p.website, p.twitter);
      if (!k) continue;
      const arr = index.get(k) ?? [];
      arr.push(p);
      index.set(k, arr);
    }
    // Hypurr side: a key shared by several Hypurr projects is not trusted either.
    const hCount = new Map<string, number>();
    for (const h of hypurr) {
      if (usedH.has(h.slug)) continue;
      const k = pass.key(h.name, h.website, h.twitter);
      if (k) hCount.set(k, (hCount.get(k) ?? 0) + 1);
    }

    for (const h of hypurr) {
      if (usedH.has(h.slug)) continue;
      const k = pass.key(h.name, h.website, h.twitter);
      if (!k) continue;
      const candidates = (index.get(k) ?? []).filter((p) => !usedLt.has(p.id));
      if (candidates.length === 0) continue;
      if (candidates.length > 1 || (hCount.get(k) ?? 0) > 1) {
        ambiguous.set(`${pass.reason}:${k}`, candidates.map((c) => c.title));
        continue;
      }
      const p = candidates[0];
      usedLt.add(p.id);
      usedH.add(h.slug);
      matched.push({ hypurr: h, lt: p, reason: pass.reason, diffs: diffFields(h, p, ltCategoryNames) });
    }
  }

  return {
    hypurrCount: hypurr.length,
    ltCount: lt.length,
    matched,
    missing: hypurr.filter((h) => !usedH.has(h.slug)),
    ltOnly: lt.filter((p) => !usedLt.has(p.id)),
    ambiguous: [...ambiguous.entries()].map(([key, ltTitles]) => ({ key, ltTitles })),
  };
}
