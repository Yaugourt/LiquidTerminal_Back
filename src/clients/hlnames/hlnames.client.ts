import { redisService } from '../../core/redis.service';
import { logDeduplicator } from '../../utils/logDeduplicator';

/**
 * Hyperliquid Names (.hl) resolution, through their public REST API
 * (https://api.hlnames.xyz/api, documented at
 * hyperliquid-names.gitbook.io/hyperliquid-names/dapp-integration).
 *
 * Every lookup is cached in Redis so the whole site costs their API a few
 * calls per address per day: names 6h, "no name" 5 min, failures are not cached.
 * Batch reverse lookups go in chunks of 150 (their endpoint fails past ~200).
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
const NONE = '';

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
/** A .hl name: labels of letters, digits, hyphens, emoji, separated by dots, ending in .hl */
export const HL_NAME_RE = /^[^\s/?#.]+(\.[^\s/?#.]+)*\.hl$/i;

const keyPrimary = (a: string) => `hlnames:primary:${a}`;
const keyForward = (n: string) => `hlnames:fwd:${n}`;
const keyProfile = (a: string) => `hlnames:profile:${a}`;

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

async function call<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T | null }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { 'X-API-Key': KEY, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
      signal: ctrl.signal,
    });
    const body = res.headers.get('content-type')?.includes('json') ? ((await res.json()) as T) : null;
    return { status: res.status, body };
  } finally {
    clearTimeout(t);
  }
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
    if (!HlNamesClient.instance) HlNamesClient.instance = new HlNamesClient();
    return HlNamesClient.instance;
  }

  /**
   * Primary .hl name for each address (lowercase in, lowercase keys out).
   * Addresses without a name map to null. Upstream failures leave the
   * address out (unknown), so callers can retry later.
   */
  async primaryNames(addresses: string[]): Promise<Record<string, string | null>> {
    const wanted = [...new Set(addresses.map((a) => a.toLowerCase()).filter((a) => ADDRESS_RE.test(a)))];
    const out: Record<string, string | null> = {};
    if (!wanted.length) return out;

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
      body: JSON.stringify(token === 'usdc' ? { token: HLNAMES_USDC } : {}),
    });
    if (status !== 200 || !body?.sig || !body.amountRequired) throw new Error(`hlnames mint pass status ${status}`);
    return body;
  }

  /** Drops the cached name and profile of an address (after a mint, so the new name shows up). */
  async forget(address: string): Promise<void> {
    const a = address.toLowerCase();
    if (!ADDRESS_RE.test(a)) return;
    await Promise.all([redisService.delete(keyPrimary(a)), redisService.delete(keyProfile(a))]);
  }
}
