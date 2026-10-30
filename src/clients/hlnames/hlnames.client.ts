import https from 'node:https';
import { redisService } from '../../core/redis.service';
import { logDeduplicator } from '../../utils/logDeduplicator';
import pkg from '../../../package.json';
import { currentRegistrator, expiries, fullRecord } from './hlnames.chain';
import { HlNamesDirectory, ListPageFetcher } from './hlnames.directory';

/**
 * Hyperliquid Names (.hl) resolution.
 *
 * Primary names come from an in-memory copy of their full list (see
 * HlNamesDirectory: a few conditional calls every 10 minutes), expiries and
 * profiles from HyperEVM (see hlnames.chain), so page views and alerts cost
 * their REST API (https://api.hlnames.xyz/api) nothing. The REST path below
 * stays as the fallback while the copy is loading, and for forward lookups of
 * names nobody uses as primary, owned names and mint passes.
 *
 * Every REST call goes through a shared budget and a circuit breaker, and is
 * counted in a log line every 10 minutes. Lookups are cached in Redis: names
 * 6 h, "no name" 5 min, failures are not cached. Batch reverse lookups go in
 * chunks of 150 (their endpoint fails past ~200).
 */

const BASE = process.env.HLNAMES_API_URL || 'https://api.hlnames.xyz/api';
// Public key published in their integration docs; override with a partner key.
const KEY = process.env.HLNAMES_API_KEY || 'CPEPKMI-HUSUX6I-SE2DHEA-YYWFG5Y';
const TTL_S = 6 * 3600;
/**
 * "No name" answers live far shorter than names. Any visitor can ask about any
 * address, and almost every random address has no name, so a 6 h negative entry
 * would let one caller park 500 six-hour keys per request in Redis. Five
 * minutes still absorbs the repeated lookups of a page being browsed.
 */
const NEGATIVE_TTL_S = 300;
const CHUNK = 150;
const TIMEOUT_MS = 6_000;
/** Same User-Agent as our other upstreams, so HL Names can attribute our traffic. */
const USER_AGENT = `liquidterminal-back/${pkg.version || '0.0.0'}`;
const NONE = '';

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
/** A .hl name: labels of letters, digits, hyphens, emoji, separated by dots, ending in .hl */
export const HL_NAME_RE = /^[^\s/?#.]+(\.[^\s/?#.]+)*\.hl$/i;

const keyPrimary = (a: string) => `hlnames:primary:${a}`;
const keyForward = (n: string) => `hlnames:fwd:${n}`;
const keyProfile = (a: string) => `hlnames:profile:${a}`;
const keyOwned = (a: string) => `hlnames:owned:${a}`;
const KEY_CARD = 'hlnames:card-template';

/** A registered name whose NFT card serves as the template for previews. */
const CARD_TEMPLATE_NAME = 'liquidterminal.hl';
const CARD_TTL_S = 24 * 3600;
/** At most this many names per owner get an expiry lookup. */
const OWNED_MAX = 20;

/** USDC on HyperEVM, the one ERC20 we offer for minting (their Minter prices it 1:1 in USD). */
export const HLNAMES_USDC = '0xb88339CB7199b77E23DB6E890353E22632Ba630f';

/** Signed arguments for one call to their Minter contract (valid about 60 seconds). */
export interface MintPass {
  label: string;
  sig: string;
  timestamp: number;
  /** "native" (HYPE) or the ERC20 address. */
  token: string;
  /** Price before any referral discount, in the token's smallest unit. */
  amountRequired: string;
}

/**
 * Shared budget for REST calls a visitor can trigger: a bucket of BUDGET_MAX
 * refilled at BUDGET_PER_S, and a breaker that stops calling for BREAKER_MS
 * after BREAKER_FAILURES failures in a row (5xx, 429, network). Mint passes
 * and the list refresh are "essential": they skip the bucket, not the breaker.
 */
const BUDGET_MAX = 60;
const BUDGET_PER_S = 1;
const BREAKER_FAILURES = 5;
const BREAKER_MS = 60_000;
const STATS_EVERY_MS = 10 * 60_000;
/** A page of 1,000 primary names is about 250 KB. */
const LIST_PAGE_MAX_BYTES = 2_000_000;

export class HlNamesBudgetError extends Error {
  constructor(reason: string) {
    super(`hlnames ${reason}`);
  }
}

const guard = {
  tokens: BUDGET_MAX,
  at: Date.now(),
  failures: 0,
  openUntil: 0,
  counts: {} as Record<string, number>,
  statsAt: Date.now(),
};

/** Test hook: a fresh budget and breaker. */
export function resetHlNamesGuard(now = Date.now()): void {
  Object.assign(guard, { tokens: BUDGET_MAX, at: now, failures: 0, openUntil: 0, counts: {}, statsAt: now });
}

function admit(kind: string, essential: boolean): void {
  const now = Date.now();
  if (now < guard.openUntil) throw new HlNamesBudgetError('circuit open');
  guard.tokens = Math.min(BUDGET_MAX, guard.tokens + ((now - guard.at) / 1000) * BUDGET_PER_S);
  guard.at = now;
  if (!essential) {
    if (guard.tokens < 1) throw new HlNamesBudgetError('budget exhausted');
    guard.tokens -= 1;
  }
  guard.counts[kind] = (guard.counts[kind] ?? 0) + 1;
  if (now - guard.statsAt >= STATS_EVERY_MS) {
    logDeduplicator.info('HlNames upstream calls', { windowMin: Math.round((now - guard.statsAt) / 60_000), ...guard.counts });
    guard.counts = {};
    guard.statsAt = now;
  }
}

function settle(ok: boolean): void {
  if (ok) {
    guard.failures = 0;
    return;
  }
  guard.failures += 1;
  if (guard.failures >= BREAKER_FAILURES) {
    guard.openUntil = Date.now() + BREAKER_MS;
    guard.failures = 0;
  }
}

/** Kind of call for the counters: the first two path segments (no addresses or names). */
const kindOf = (path: string): string => path.split('?')[0].split('/').slice(1, 3).join('/');

async function call<T>(
  path: string,
  init?: RequestInit & { essential?: boolean }
): Promise<{ status: number; body: T | null }> {
  const { essential = false, ...rest } = init ?? {};
  admit(kindOf(path), essential);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${path}`, {
      ...rest,
      headers: { 'X-API-Key': KEY, 'Content-Type': 'application/json', 'User-Agent': USER_AGENT, ...(rest.headers ?? {}) },
      signal: ctrl.signal,
    });
    settle(res.status < 500 && res.status !== 429);
    const body = res.headers.get('content-type')?.includes('json') ? ((await res.json()) as T) : null;
    return { status: res.status, body };
  } catch (error) {
    settle(false);
    throw error;
  } finally {
    clearTimeout(t);
  }
}

/**
 * One page of their primary-name list, conditional on the ETag we hold.
 * Plain node:https, not fetch: fetch adds "Cache-Control: no-cache" to any
 * request carrying If-None-Match, and their server then never answers 304.
 */
const fetchPrimaryPage: ListPageFetcher = async (begin, end, etag) => {
  const path = `/utils/all_primary_names?begin=${begin}&end=${end}`;
  admit(kindOf(path), true);
  let answered = false;
  try {
    const res = await new Promise<{ status: number; etag: string | null; text: string }>((resolve, reject) => {
      const req = https.get(
        `${BASE}${path}`,
        {
          headers: { 'X-API-Key': KEY, 'User-Agent': USER_AGENT, Accept: 'application/json', ...(etag ? { 'If-None-Match': etag } : {}) },
          timeout: TIMEOUT_MS,
        },
        (r) => {
          const chunks: Buffer[] = [];
          let size = 0;
          r.on('data', (c: Buffer) => {
            size += c.length;
            if (size > LIST_PAGE_MAX_BYTES) req.destroy(new Error('list page too large'));
            else chunks.push(c);
          });
          r.on('end', () => {
            const tag = r.headers.etag;
            resolve({ status: r.statusCode ?? 0, etag: typeof tag === 'string' ? tag : null, text: Buffer.concat(chunks).toString('utf8') });
          });
          r.on('error', reject);
        }
      );
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
    });
    answered = true;
    settle(res.status < 500 && res.status !== 429);
    if (res.status === 304) return { status: 304 };
    const rows = res.status === 200 ? (JSON.parse(res.text) as unknown) : null;
    if (!Array.isArray(rows)) throw new Error(`all_primary_names status ${res.status}`);
    return { status: 200, etag: res.etag, rows };
  } catch (error) {
    if (!answered) settle(false);
    throw error;
  }
};

/** A name an address holds, with its expiry (Unix seconds, null when unknown). */
export interface OwnedName {
  name: string;
  expiry: number | null;
}

/**
 * The NFT card is an SVG from their API, shown in an <img> on the front. It
 * is still checked here: no script, no event handler, no external reference,
 * and exactly one name text element (id "dt") for the preview to fill.
 */
/**
 * Their card carries a script that sizes the name (font-size = min(795 / length, 50) px);
 * it never runs in an <img>, and the front applies the same rule. Dropped before the check.
 */
export function stripCardScripts(svg: string): string {
  return svg.replace(/<script\b[\s\S]*?<\/script>/gi, '');
}

export function isSafeCardSvg(svg: string): boolean {
  if (svg.length > 50_000 || !svg.includes('<svg')) return false;
  if (/<script|<foreignObject|\son[a-z]+\s*=|javascript:|(?:xlink:)?href\s*=\s*["'](?!#)/i.test(svg)) return false;
  return (svg.match(/<text[^>]*id="dt"[^>]*>[^<]*<\/text>/g) ?? []).length === 1;
}

export interface HlProfile {
  address: string;
  name: string | null;
  avatar: string | null;
  /** Public text records (Twitter, Discord, Bio...), only for names that have them. */
  records: Record<string, string>;
}

/** Records are free text set by the name owner: keep known keys, https links only, short text. */
const LINK_KEYS: Record<string, string> = { twitter: 'Twitter', x: 'Twitter', discord: 'Discord', telegram: 'Telegram', github: 'GitHub', website: 'Website', url: 'Website' };
const TEXT_KEYS: Record<string, string> = { bio: 'Bio' };

function safeUrl(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 300) return null;
  try {
    const u = new URL(v.trim());
    return u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

function sanitizeRecords(records: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(records)) {
    const key = k.toLowerCase();
    if (LINK_KEYS[key]) {
      const url = safeUrl(v);
      if (url) out[LINK_KEYS[key]] = url;
    } else if (TEXT_KEYS[key] && typeof v === 'string') {
      out[TEXT_KEYS[key]] = v.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 160);
    }
  }
  return out;
}

export class HlNamesClient {
  private static instance: HlNamesClient;

  public static getInstance(): HlNamesClient {
    if (!HlNamesClient.instance) {
      HlNamesClient.instance = new HlNamesClient();
      if (process.env.NODE_ENV !== 'test') HlNamesClient.instance.directory.start();
    }
    return HlNamesClient.instance;
  }

  /** Local copy of every primary name (see HlNamesDirectory). */
  readonly directory = new HlNamesDirectory(fetchPrimaryPage);

  /**
   * Primary .hl name for each address (lowercase in, lowercase keys out).
   * Addresses without a name map to null. Upstream failures leave the
   * address out (unknown), so callers can retry later.
   */
  async primaryNames(addresses: string[]): Promise<Record<string, string | null>> {
    const wanted = [...new Set(addresses.map((a) => a.toLowerCase()).filter((a) => ADDRESS_RE.test(a)))];
    const out: Record<string, string | null> = {};
    if (!wanted.length) return out;

    // Served from the local copy once it is loaded: no Redis, no upstream call.
    if (this.directory.ready) {
      for (const a of wanted) out[a] = this.directory.primaryName(a) ?? null;
      return out;
    }

    const cached = await redisService.mget(wanted.map(keyPrimary));
    const misses: string[] = [];
    wanted.forEach((a, i) => {
      const v = cached?.[i];
      if (v === null || v === undefined) misses.push(a);
      else out[a] = v === NONE ? null : v;
    });

    for (let i = 0; i < misses.length; i += CHUNK) {
      const chunk = misses.slice(i, i + CHUNK);
      try {
        const { status, body } = await call<{ address: string; primaryName: string }[]>('/utils/all_primary_names', {
          method: 'POST',
          body: JSON.stringify({ addresses: chunk }),
        });
        if (status !== 200 || !Array.isArray(body)) throw new Error(`status ${status}`);
        const found = new Map(body.map((r) => [r.address.toLowerCase(), r.primaryName || null]));
        const named: [string, string][] = [];
        const unnamed: [string, string][] = [];
        for (const a of chunk) {
          const name = found.get(a) ?? null; // left out of the response = no name
          out[a] = name;
          if (name) named.push([keyPrimary(a), name]);
          else unnamed.push([keyPrimary(a), NONE]);
        }
        await Promise.all([
          redisService.msetEx(named, TTL_S),
          redisService.msetEx(unnamed, NEGATIVE_TTL_S),
        ]);
      } catch (error) {
        logDeduplicator.warn('HlNames: batch reverse lookup failed', {
          count: chunk.length,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return out;
  }

  /** Address a .hl name resolves to, or null when it isn't registered. Throws on upstream failure. */
  async resolve(name: string): Promise<string | null> {
    const n = name.trim().toLowerCase();
    if (!HL_NAME_RE.test(n)) return null;
    const local = this.directory.addressOf(n);
    if (local) return local;
    const hit = await redisService.get(keyForward(n));
    if (hit !== null) return hit === NONE ? null : hit;
    const { status, body } = await call<{ address?: string }>(`/resolve/address/${encodeURIComponent(n)}`);
    if (status === 404 || status === 422) {
      await redisService.set(keyForward(n), NONE, NEGATIVE_TTL_S);
      return null;
    }
    if (status !== 200 || !body?.address) throw new Error(`hlnames resolve status ${status}`);
    const address = body.address.toLowerCase();
    await redisService.set(keyForward(n), address, TTL_S);
    return address;
  }

  /** Name, avatar and public records of an address (for profile headers). */
  async profile(address: string): Promise<HlProfile> {
    const a = address.toLowerCase();
    const empty: HlProfile = { address: a, name: null, avatar: null, records: {} };
    if (!ADDRESS_RE.test(a)) return empty;
    const hit = await redisService.get(keyProfile(a));
    if (hit) return JSON.parse(hit) as HlProfile;

    // Once the local copy is loaded: no live primary name means an empty
    // profile at no cost, and records are read on chain.
    const entry = this.directory.entry(a);
    if (entry === null) return empty;
    const registrator = this.directory.registratorAddress();
    if (entry && registrator) {
      try {
        const { records } = await fullRecord(registrator, entry.namehash);
        const avatarKey = Object.keys(records).find((k) => k.toLowerCase() === 'avatar');
        const profile: HlProfile = {
          address: a,
          name: entry.name,
          avatar: avatarKey ? safeUrl(records[avatarKey]) : null,
          records: sanitizeRecords(records),
        };
        await redisService.set(keyProfile(a), JSON.stringify(profile), TTL_S);
        return profile;
      } catch (error) {
        logDeduplicator.warn('HlNames: on-chain profile failed, using the API', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const { status, body } = await call<{ primaryName: string | null; avatar: string | null }>(`/resolve/profile/${a}`);
    if (status !== 200 || !body) throw new Error(`hlnames profile status ${status}`);
    let records: Record<string, string> = {};
    if (body.primaryName) {
      const nh = await call<{ nameHash: string }>(`/utils/namehash/${encodeURIComponent(body.primaryName)}`);
      if (nh.body?.nameHash) {
        const full = await call<{ data?: { records?: Record<string, string> } }>(`/records/full_record/${nh.body.nameHash}`);
        records = full.body?.data?.records ?? {};
      }
    }
    const profile: HlProfile = {
      address: a,
      name: body.primaryName || null,
      avatar: safeUrl(body.avatar),
      records: sanitizeRecords(records),
    };
    // An address without a name gets the short negative TTL, like primaryNames().
    await redisService.set(keyProfile(a), JSON.stringify(profile), profile.name ? TTL_S : NEGATIVE_TTL_S);
    return profile;
  }

  /**
   * Signed mint pass for `label` (no ".hl"), priced in HYPE or USDC
   * (Builder Program, github.com/HLnames/hln_api_minting). Never cached: the
   * signature expires within a minute. It does not tell whether the name is
   * free; the caller checks ownership on chain.
   */
  async mintPass(label: string, token: 'native' | 'usdc'): Promise<MintPass> {
    const { status, body } = await call<MintPass>(`/sign_mintpass/${encodeURIComponent(label)}`, {
      method: 'POST',
      essential: true,
      body: JSON.stringify(token === 'usdc' ? { token: HLNAMES_USDC } : {}),
    });
    if (status !== 200 || !body) throw new Error(`hlnames mint pass status ${status}`);
    // The pass goes straight into a user's wallet: forward only a well-formed
    // one, for the label and the token that were asked for.
    const expectedToken = token === 'usdc' ? HLNAMES_USDC.toLowerCase() : 'native';
    const wellFormed =
      body.label === label &&
      typeof body.token === 'string' &&
      body.token.toLowerCase() === expectedToken &&
      typeof body.sig === 'string' &&
      /^0x[0-9a-fA-F]{2,1024}$/.test(body.sig) &&
      Number.isSafeInteger(body.timestamp) &&
      typeof body.amountRequired === 'string' &&
      /^[1-9][0-9]{0,29}$/.test(body.amountRequired);
    if (!wellFormed) throw new Error('hlnames mint pass malformed');
    return {
      label: body.label,
      sig: body.sig,
      timestamp: body.timestamp,
      token: body.token,
      amountRequired: body.amountRequired,
    };
  }

  /** Drops the cached name, profile and owned names of an address (after a mint, so the new name shows up). */
  async forget(address: string): Promise<void> {
    const a = address.toLowerCase();
    if (!ADDRESS_RE.test(a)) return;
    await Promise.all([redisService.delete(keyPrimary(a)), redisService.delete(keyProfile(a)), redisService.delete(keyOwned(a))]);
    this.directory.refreshSoon();
  }

  /**
   * SVG of a registered name's NFT card, the template the mint page fills with
   * the name being typed. Their API only draws registered names. Cached 24 h.
   */
  async cardTemplate(): Promise<string> {
    const hit = await redisService.get(KEY_CARD);
    if (hit) return hit;
    const nh = await call<{ nameHash: string }>(`/utils/namehash/${encodeURIComponent(CARD_TEMPLATE_NAME)}`);
    if (nh.status !== 200 || !nh.body?.nameHash) throw new Error(`hlnames namehash status ${nh.status}`);
    const tokenId = BigInt(nh.body.nameHash).toString();
    const { status, body } = await call<{ image?: string }>(`/records/image/${tokenId}`);
    const prefix = 'data:image/svg+xml;base64,';
    if (status !== 200 || !body?.image?.startsWith(prefix)) throw new Error(`hlnames card status ${status}`);
    const svg = stripCardScripts(Buffer.from(body.image.slice(prefix.length), 'base64').toString('utf8'));
    if (!isSafeCardSvg(svg)) throw new Error('hlnames card rejected');
    await redisService.set(KEY_CARD, svg, CARD_TTL_S);
    return svg;
  }

  /** Names an address holds, soonest expiry first. Cached 5 min (any visitor can ask about any address). */
  async ownedNames(address: string): Promise<OwnedName[]> {
    const a = address.toLowerCase();
    if (!ADDRESS_RE.test(a)) return [];
    const hit = await redisService.get(keyOwned(a));
    if (hit) return JSON.parse(hit) as OwnedName[];
    const { status, body } = await call<{ name: string; namehash: string }[]>(`/utils/names_owner/${a}`);
    if (status !== 200 || !Array.isArray(body)) throw new Error(`hlnames names_owner status ${status}`);
    const rows = body.filter((r) => typeof r?.name === 'string' && HL_NAME_RE.test(r.name) && /^0x[0-9a-f]{64}$/i.test(r.namehash)).slice(0, OWNED_MAX);
    // Expiries from HyperEVM in one Multicall3 call instead of one REST call per name.
    const registrator = this.directory.registratorAddress() ?? (await currentRegistrator().catch(() => null));
    const exp = registrator ? await expiries(registrator, rows.map((r) => r.namehash)).catch(() => null) : null;
    const owned = rows.map((r, i): OwnedName => ({ name: r.name, expiry: exp?.[i] ?? null }));
    owned.sort((x, y) => (x.expiry ?? Infinity) - (y.expiry ?? Infinity));
    await redisService.set(keyOwned(a), JSON.stringify(owned), NEGATIVE_TTL_S);
    return owned;
  }
}
