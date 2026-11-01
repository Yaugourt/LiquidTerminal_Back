import * as cheerio from 'cheerio';
import { HypurrProject } from './hypurr-sync.types';

/**
 * Hypurr Collective ecosystem scraper.
 *
 * Sources, all public and verified by fetching (Nov 2026):
 * 1. Webflow CMS listing https://www.hypurr.co/ecosystem-projects, paginated with
 *    `?<listId>_page=N` (100 cards per page). Live CMS: slug, name, logo, X link,
 *    category tags, bio. This is the authoritative list of projects.
 * 2. https://hypurr-site.pages.dev/assets/data.json, the JSON the live ecosystem map
 *    (hypurr.co/ecosystem-map) loads. Same slugs, adds website, Telegram and token
 *    status, which the listing cards do not show. Joined by slug.
 * 3. Project page /ecosystem-projects/<slug>: website / X / Telegram buttons. Only
 *    fetched for slugs that data.json does not cover (fallback).
 *
 * Parsers are pure (HTML/JSON in, records out) so they are testable on fixtures.
 */

export const HYPURR_ORIGIN = 'https://www.hypurr.co';
export const HYPURR_LISTING_PATH = '/ecosystem-projects';
export const HYPURR_DATA_JSON_URL = 'https://hypurr-site.pages.dev/assets/data.json';

const USER_AGENT = 'LiquidTerminal-HypurrSync/1.0 (+https://liquidterminal.xyz)';
const FETCH_TIMEOUT_MS = 20_000;
const MAX_LISTING_PAGES = 20;
const DETAIL_CONCURRENCY = 4;

/** Card data from the Webflow listing (no website/telegram there). */
export interface HypurrListingCard {
  slug: string;
  name: string;
  logo: string | null;
  twitter: string | null;
  categories: string[];
  description: string | null;
}

export interface HypurrListingPage {
  cards: HypurrListingCard[];
  /** `?xxx_page=N` query for the next page, null on the last page */
  nextPageQuery: string | null;
}

/** Subset of one data.json project record (fields we use). */
export interface HypurrDataRecord {
  slug: string;
  name: string | null;
  site: string | null;
  x: string | null;
  tg: string | null;
  token: string | null;
  ticker: string | null;
  tags: string[];
  bio: string | null;
}

export interface HypurrDetail {
  website: string | null;
  twitter: string | null;
  telegram: string | null;
}

function clean(value: string | null | undefined): string | null {
  if (value == null) return null;
  const v = value.replace(/\s+/g, ' ').trim();
  return v.length > 0 ? v : null;
}

function cleanUrl(value: string | null | undefined): string | null {
  const v = clean(value);
  if (!v || !/^https?:\/\//i.test(v)) return null;
  return v;
}

/**
 * Canonical X profile URL ("https://x.com/Handle"), or null when the link is not an
 * X/Twitter profile (Hypurr sometimes puts a Telegram link in the X field).
 */
export function canonicalTwitter(value: string | null | undefined): string | null {
  const v = clean(value);
  if (!v) return null;
  const m = v.match(/^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/@?([A-Za-z0-9_]{1,30})(?:[/?#]|$)/i);
  if (!m || /^(i|intent|home|search|messages|share|hashtag)$/i.test(m[1])) return null;
  return `https://x.com/${m[1]}`;
}

function slugFromHref(href: string | undefined): string | null {
  if (!href) return null;
  const m = href.match(/\/ecosystem-projects\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

/** Parse one page of the Webflow listing. */
export function parseListingPage(html: string): HypurrListingPage {
  const $ = cheerio.load(html);
  const cards: HypurrListingCard[] = [];

  $('.project-card').each((_, el) => {
    const card = $(el);
    const slug = slugFromHref(card.find('a.project-item-link').attr('href'));
    const name = clean(card.find('.project-item-title').first().text());
    if (!slug || !name) return;

    const xLink = card
      .find('.project-item-title-w a[href]')
      .map((__, a) => $(a).attr('href'))
      .get()
      .find((h) => /^https?:\/\/(www\.)?(x|twitter)\.com\//i.test(h));

    const categories = card
      .find('.project-tag-s [fs-cmsfilter-field="category"]')
      .map((__, t) => clean($(t).text()))
      .get()
      .filter((t): t is string => !!t);

    cards.push({
      slug,
      name,
      logo: cleanUrl(card.find('img.project-item-avatar').attr('src')),
      twitter: cleanUrl(xLink),
      categories: [...new Set(categories)],
      description: clean(card.find('[fs-cmsfilter-field="bio"]').first().text()),
    });
  });

  // Webflow pagination: the "next" link carries the list-specific page param.
  let nextPageQuery: string | null = null;
  const next = $('a.w-pagination-next[href]').attr('href');
  if (next && /_page=\d+/.test(next)) {
    nextPageQuery = next.startsWith('?') ? next : `?${next.split('?')[1] ?? ''}`;
  }

  return { cards, nextPageQuery };
}

/** Parse data.json (the ecosystem map dataset). Unknown shapes yield an empty list. */
export function parseDataJson(json: unknown): HypurrDataRecord[] {
  const projects = (json as { projects?: unknown })?.projects;
  if (!Array.isArray(projects)) return [];
  const str = (v: unknown): string | null => (typeof v === 'string' ? clean(v) : null);
  const out: HypurrDataRecord[] = [];
  for (const raw of projects) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const slug = str(r.slug);
    if (!slug) continue;
    out.push({
      slug,
      name: str(r.name),
      site: cleanUrl(str(r.site)),
      x: cleanUrl(str(r.x)),
      tg: cleanUrl(str(r.tg)),
      token: str(r.token),
      ticker: str(r.ticker),
      tags: Array.isArray(r.tags) ? r.tags.map((t) => str(t)).filter((t): t is string => !!t) : [],
      bio: str(r.bio),
    });
  }
  return out;
}

/** Parse the link buttons of a /ecosystem-projects/<slug> page. */
export function parseDetailPage(html: string): HypurrDetail {
  const $ = cheerio.load(html);
  return {
    website: cleanUrl($('.hc-pj-links a.hc-pj-site').attr('href')),
    twitter: cleanUrl($('.hc-pj-links a.hc-pj-x').attr('href')),
    telegram: cleanUrl($('.hc-pj-links a.hc-pj-tg').attr('href')),
  };
}

/**
 * Ticker only when Hypurr flags the token as live. Free text is reduced to its first
 * word ("PEAR (Not on HL, ERC-20)" -> "PEAR"); placeholders ("NA", "TBA", "NFT") are dropped.
 */
export function liveTicker(rec: HypurrDataRecord | undefined): string | null {
  if (!rec || rec.token?.toLowerCase() !== 'yes' || !rec.ticker) return null;
  const first = rec.ticker.trim().split(/\s+/)[0].replace(/^\$/, '');
  if (!/^[A-Za-z0-9]{1,12}$/.test(first) || /^(na|tba|tbd|none|nft|yes|no)$/i.test(first)) return null;
  return first;
}

type LinkKind = 'x' | 'telegram' | 'discord' | 'web';

function linkKind(url: string): LinkKind {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return 'web';
  }
  if (host === 'x.com' || host === 'twitter.com' || host === 'mobile.twitter.com') return 'x';
  if (host === 't.me' || host === 'telegram.me' || host === 'telegram.org') return 'telegram';
  if (host === 'discord.gg' || host === 'discord.com' || host.endsWith('.discord.com')) return 'discord';
  return 'web';
}

/**
 * Route the links Hypurr gives (in its site / X / Telegram fields, which are not always
 * used as labelled: a Discord invite in the Telegram field, an X profile as the site)
 * to the matching LT column. The first candidate of each kind wins.
 */
export function routeLinks(candidates: (string | null | undefined)[]): {
  website: string | null;
  twitter: string | null;
  telegram: string | null;
  discord: string | null;
} {
  const out = { website: null as string | null, twitter: null as string | null, telegram: null as string | null, discord: null as string | null };
  for (const raw of candidates) {
    const url = cleanUrl(raw);
    if (!url) continue;
    switch (linkKind(url)) {
      case 'x':
        out.twitter ??= canonicalTwitter(url);
        break;
      case 'telegram':
        out.telegram ??= url;
        break;
      case 'discord':
        out.discord ??= url;
        break;
      default:
        out.website ??= url;
    }
  }
  return out;
}

/**
 * Merge listing cards (authoritative list) with data.json and fallback detail pages.
 * When the listing could not be read at all, data.json alone is used (no logos).
 */
export function mergeSources(
  cards: HypurrListingCard[],
  data: HypurrDataRecord[],
  details: Map<string, HypurrDetail> = new Map()
): HypurrProject[] {
  const bySlug = new Map(data.map((d) => [d.slug, d]));
  const sourceUrl = (slug: string): string => `${HYPURR_ORIGIN}${HYPURR_LISTING_PATH}/${encodeURIComponent(slug)}`;

  if (cards.length === 0) {
    return data
      .filter((d) => d.name)
      .map((d) => ({
        slug: d.slug,
        name: d.name as string,
        ...routeLinks([d.site, d.x, d.tg]),
        logo: null,
        categories: d.tags,
        description: d.bio,
        ticker: liveTicker(d),
        sourceUrl: sourceUrl(d.slug),
      }));
  }

  const seen = new Set<string>();
  const out: HypurrProject[] = [];
  for (const c of cards) {
    if (seen.has(c.slug)) continue;
    seen.add(c.slug);
    const d = bySlug.get(c.slug);
    const det = details.get(c.slug);
    out.push({
      slug: c.slug,
      name: c.name,
      // Listing X link first, then data.json, then the project page.
      ...routeLinks([c.twitter, d?.site, d?.x, d?.tg, det?.website, det?.twitter, det?.telegram]),
      logo: c.logo,
      categories: c.categories.length > 0 ? c.categories : d?.tags ?? [],
      description: c.description ?? d?.bio ?? null,
      ticker: liveTicker(d),
      sourceUrl: sourceUrl(c.slug),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.text();
}

export interface ScrapeResult {
  projects: HypurrProject[];
  listingPages: number;
  listingCards: number;
  dataJsonRecords: number;
  detailFetches: number;
  warnings: string[];
}

/** Fetch every source and return normalized Hypurr projects. Throws when nothing could be read. */
export async function scrapeHypurrEcosystem(): Promise<ScrapeResult> {
  const warnings: string[] = [];

  // 1. Listing pages (walk the pagination until there is no next page).
  const cards: HypurrListingCard[] = [];
  let listingPages = 0;
  let query = '';
  const visited = new Set<string>();
  try {
    while (listingPages < MAX_LISTING_PAGES && !visited.has(query)) {
      visited.add(query);
      const page = parseListingPage(await fetchText(`${HYPURR_ORIGIN}${HYPURR_LISTING_PATH}${query}`));
      listingPages++;
      cards.push(...page.cards);
      if (!page.nextPageQuery || page.cards.length === 0) break;
      query = page.nextPageQuery;
    }
  } catch (e) {
    warnings.push(`listing: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 2. data.json (website / telegram / token)
  let data: HypurrDataRecord[] = [];
  try {
    data = parseDataJson(JSON.parse(await fetchText(HYPURR_DATA_JSON_URL)));
    if (data.length === 0) warnings.push('data.json: no projects in payload');
  } catch (e) {
    warnings.push(`data.json: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (cards.length === 0 && data.length === 0) {
    throw new Error(`Hypurr ecosystem unreadable (${warnings.join('; ')})`);
  }

  // 3. Detail pages for listing slugs data.json does not cover.
  const dataSlugs = new Set(data.map((d) => d.slug));
  const uncovered = [...new Set(cards.map((c) => c.slug))].filter((s) => !dataSlugs.has(s));
  const details = new Map<string, HypurrDetail>();
  for (let i = 0; i < uncovered.length; i += DETAIL_CONCURRENCY) {
    const batch = uncovered.slice(i, i + DETAIL_CONCURRENCY);
    await Promise.all(
      batch.map(async (slug) => {
        try {
          details.set(slug, parseDetailPage(await fetchText(`${HYPURR_ORIGIN}${HYPURR_LISTING_PATH}/${encodeURIComponent(slug)}`)));
        } catch (e) {
          warnings.push(`detail ${slug}: ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );
  }

  const listed = new Set(cards.map((c) => c.slug));
  const notListed = data.filter((d) => !listed.has(d.slug)).map((d) => d.slug);
  if (cards.length > 0 && notListed.length > 0) {
    warnings.push(`data.json has ${notListed.length} slug(s) absent from the CMS listing (ignored): ${notListed.join(', ')}`);
  }

  return {
    projects: mergeSources(cards, data, details),
    listingPages,
    listingCards: cards.length,
    dataJsonRecords: data.length,
    detailFetches: details.size,
    warnings,
  };
}
