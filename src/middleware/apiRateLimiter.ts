import { Request, Response, NextFunction } from 'express';
import { redisService } from '../core/redis.service';
import { logDeduplicator } from '../utils/logDeduplicator';
import { positiveIntEnv } from '../utils/env';
import { rateLimitKeyForIp, siteKeyForIp } from '../utils/client-ip';
import { runWithUpstreamCaller, type UpstreamBudgetState } from '../utils/request-context';
import { elysiumRpcRequestWeight } from '../schemas/elysium-rpc.schema';

// Configuration des limites
//
// Per IP, and many visitors share one: mobile carriers (CGNAT), offices and
// universities put dozens of people behind a single address. A single tab
// makes ~15 requests in its first second and 20-40 a minute while polling, so
// the old 1,200 a minute 429'd every widget for everyone behind an IP once
// 30-50 tabs were open there. These routes are Redis/memory reads; what costs
// upstream has its own budget (passthrough limiter, Hyperfolio misses,
// token-details reads). The limits only stop floods.
const RATE_LIMITS = {
  // Limites par seconde pour prévenir les bursts
  BURST_LIMIT: {
    WINDOW: 1,
    // A page load fires ~15 requests in its first second (measured
    // 2026-07-26): 200 lets a dozen people behind one IP open pages together,
    // while a scripted flood runs in the hundreds or thousands per second.
    MAX_REQUESTS: positiveIntEnv('RATE_LIMIT_BURST', 200)
  },
  // Limites par minute pour le moyen terme
  MINUTE_LIMIT: {
    WINDOW: 60,       // 60 secondes
    MAX_REQUESTS: positiveIntEnv('RATE_LIMIT_MINUTE', 6000) // ~150-300 tabs behind one IP
  },
  // Limites par heure pour détecter les abus
  HOUR_LIMIT: {
    WINDOW: 3600,      // 3600 secondes
    MAX_REQUESTS: positiveIntEnv('RATE_LIMIT_HOUR', 300000) // ~83 req/s sustained for an hour
  }
};

interface RateWindow {
  name: string;
  seconds: number;
}

/**
 * Seconds until the fixed window that refused a request rolls over: what a
 * limited client is told to wait (Retry-After). A fixed 5 s let a client
 * over its minute or hour budget retry every 5 s and stay refused (refused
 * requests are counted too) until the window rolled over anyway.
 */
function secondsUntilRollover(windowSeconds: number): number {
  const now = Math.floor(Date.now() / 1000);
  return Math.max(1, windowSeconds - (now % windowSeconds));
}

// Fenêtres de temps, dans l'ordre des compteurs renvoyés par countRequest
const MARKET_WINDOWS: readonly RateWindow[] = [
  { name: 'burst', seconds: RATE_LIMITS.BURST_LIMIT.WINDOW },
  { name: 'minute', seconds: RATE_LIMITS.MINUTE_LIMIT.WINDOW },
  { name: 'hour', seconds: RATE_LIMITS.HOUR_LIMIT.WINDOW },
];

/** Redis key of the fixed window of `window` that `nowS` (epoch seconds) falls in. */
function windowKey(prefix: string, window: RateWindow, nowS: number): string {
  return `${prefix}:${window.name}:${Math.floor(nowS / window.seconds)}`;
}

/**
 * Counts this request in one fixed window per entry of `windows` and returns
 * the counts, in a single round trip (INCR + EXPIRE per window).
 *
 * The sorted sets this replaces kept every request as a member for the whole
 * window — up to 72k per IP for the hour — at twelve commands per request. A
 * fixed window counts a subset of what the sliding one counted, so it never
 * rejects a request the old limiter accepted; across a boundary it can admit
 * up to twice a limit, which these ceilings tolerate. (The 1 s burst window was
 * already a fixed second: members were scored in whole seconds.)
 *
 * Throws on any Redis failure so callers switch to the in-memory fallback —
 * swallowing it returned a count of 0, which let everything through.
 *
 * `cost` is what this request weighs in every window (1 unless the limiter
 * counts something else than requests, see `createIpLimiter`), or one weight
 * per window, in the order of `windows`.
 */
async function countRequest(prefix: string, windows: readonly RateWindow[], cost: number | readonly number[] = 1): Promise<number[]> {
  return (await countRequests([prefix], windows, cost))[0];
}

/** countRequest for several prefixes (a client and the /48 it sits in), still in one round trip: the counts of each, in order. */
async function countRequests(prefixes: readonly string[], windows: readonly RateWindow[], cost: number | readonly number[] = 1): Promise<number[][]> {
  // Circuit open: don't queue on a wedged connection, use the fallback now.
  if (!redisService.isHealthy()) throw new Error('Redis circuit open');
  const now = Math.floor(Date.now() / 1000);
  const pipeline = redisService.getClient().pipeline();
  for (const prefix of prefixes) {
    windows.forEach((window, i) => {
      const key = windowKey(prefix, window, now);
      const weight = typeof cost === 'number' ? cost : cost[i];
      if (weight === 1) pipeline.incr(key);
      else pipeline.incrby(key, weight);
      pipeline.expire(key, window.seconds * 2);
    });
  }

  const results = await pipeline.exec();
  if (!results) {
    throw new Error('Rate limiter pipeline aborted');
  }
  return prefixes.map((_, p) =>
    windows.map((__, i) => {
      const [error, count] = results[(p * windows.length + i) * 2];
      if (error) throw error;
      return Number(count);
    })
  );
}

/**
 * How many times a client's limit the /48 it sits in may reach, for IPv6. An address is
 * counted under its /64 (one subnet) and under its /48 (one site, 65,536 subnets): without the
 * second count, whoever holds a /48 has 65,536 budgets. 16 leaves room for the many people a
 * carrier or a campus can put in one /48, and is 4,096 times less than before.
 */
const V6_SITE_FACTOR = positiveIntEnv('RATE_LIMIT_V6_SITE_FACTOR', 16);

/** The first window whose count is over its limit (times `factor`), or undefined. */
function exceeded(counts: readonly number[], windows: readonly RateWindow[], limits: readonly number[], factor = 1): RateWindow | undefined {
  return windows.find((_, i) => counts[i] > limits[i] * factor);
}

/** "second" for the one-second window, else the window's own name: what a refusal says. */
const windowWord = (window: RateWindow): string => (window.seconds === 1 ? 'second' : window.name);

// In-memory fallback when Redis is down (fail-secure).
//
// It used to keep the one-second window only: with Redis down a client was held to its burst
// and nothing else, 200 requests every second for as long as the outage lasted (12,000 a
// minute against a limit of 6,000, and the pass-through routes at 18,000 against 4,000). The
// fallback now counts the same fixed windows as Redis does, with the same limits, per process.
interface MemoryWindow {
  /** Index of the fixed window the count belongs to (epoch seconds / window length). */
  index: number;
  count: number;
}
interface MemoryEntry {
  slots: MemoryWindow[];
  /** Epoch second at which the longest window counted so far rolls over: the entry is of no use after it. */
  untilS: number;
}
const inMemoryCounters = new Map<string, MemoryEntry>();
const FALLBACK_MAX_IPS = 10000;

/** Counts `cost` under `key` in each of `windows`, in this process, and returns the counts (like countRequest). */
function countInMemory(
  key: string,
  windows: readonly RateWindow[],
  cost: number | readonly number[] = 1,
  counters: Map<string, MemoryEntry> = inMemoryCounters
): number[] {
  const nowS = Math.floor(Date.now() / 1000);
  let entry = counters.get(key);
  if (entry) {
    // Re-inserted: the entries stay in the order of their last request, the oldest leaves first.
    counters.delete(key);
  } else {
    if (counters.size >= FALLBACK_MAX_IPS) {
      const firstKey = counters.keys().next().value;
      if (firstKey !== undefined) counters.delete(firstKey);
    }
    entry = { slots: windows.map(() => ({ index: -1, count: 0 })), untilS: 0 };
  }
  counters.set(key, entry);
  const slots = entry.slots;
  return windows.map((window, i) => {
    const index = Math.floor(nowS / window.seconds);
    const slot = slots[i] ?? (slots[i] = { index: -1, count: 0 });
    if (slot.index !== index) {
      slot.index = index;
      slot.count = 0;
    }
    slot.count += typeof cost === 'number' ? cost : cost[i];
    entry.untilS = Math.max(entry.untilS, (index + 1) * window.seconds);
    return slot.count;
  });
}

// Periodic cleanup: an entry leaves once its longest window has rolled over.
setInterval(() => {
  const nowS = Math.floor(Date.now() / 1000);
  for (const [key, entry] of inMemoryCounters) {
    if (entry.untilS <= nowS) inMemoryCounters.delete(key);
  }
}, 60000).unref();

const MARKET_LIMITS: readonly number[] = [
  RATE_LIMITS.BURST_LIMIT.MAX_REQUESTS,
  RATE_LIMITS.MINUTE_LIMIT.MAX_REQUESTS,
  RATE_LIMITS.HOUR_LIMIT.MAX_REQUESTS,
];

export const marketRateLimiter = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const ip = req.ip;
  
  if (!ip) {
    res.status(400).json({
      error: 'IP address not found',
      message: 'Could not determine client IP address'
    });
    return;
  }
  // An IPv6 host owns a whole /64 and can pick any address in it, so the
  // budget is per /64 (IPv4 stays per address); the /48 it sits in is counted too.
  const prefixes = limiterPrefixes('ratelimit', ip);

  let counts: number[][];
  let fallback = false;
  try {
    // Vérification multi-niveaux avec Redis
    counts = await countRequests(prefixes, MARKET_WINDOWS);
  } catch (error) {
    logDeduplicator.error('Rate limiter Redis error, using in-memory fallback', {
      error: error instanceof Error ? error.message : String(error),
      path: req.path,
      ip: req.ip
    });
    // Fail-secure: the same windows and limits, counted in this process.
    fallback = true;
    counts = prefixes.map((prefix) => countInMemory(prefix, MARKET_WINDOWS));
  }
  const refused = exceeded(counts[0], MARKET_WINDOWS, MARKET_LIMITS) ?? (counts[1] && exceeded(counts[1], MARKET_WINDOWS, MARKET_LIMITS, V6_SITE_FACTOR));
  if (refused) {
    return sendLimitExceededResponse(res, fallback ? 'Too many requests (fallback mode)' : `Too many requests per ${windowWord(refused)}`, refused.seconds);
  }
  next();
};

/** The counter prefix of a client under `namespace`, and for IPv6 the one of its /48. */
function limiterPrefixes(namespace: string, ip: string): string[] {
  const site = siteKeyForIp(ip);
  const client = `${namespace}:${rateLimitKeyForIp(ip)}`;
  return site ? [client, `${namespace}:site:${site}`] : [client];
}

/** 429 with Retry-After set to the rollover of the window that refused it. */
function sendLimitExceededResponse(res: Response, message: string, windowSeconds: number): void {
  const retryAfter = secondsUntilRollover(windowSeconds);
  res.setHeader('Retry-After', String(retryAfter));
  res.status(429).json({
    error: 'Rate limit exceeded',
    message,
    retryAfter
  });
}

// Tighter limits for the /indexer/* routes a request can make reach HypeDexer
// (uncached, or cached under a key the caller picks: address, coin, limit,
// time range). Each miss is a paid upstream call and holds an outbound slot.
// They count every request, cache hits included (a hit costs nothing
// upstream), so they are sized for several people behind one IP: a heavy page
// makes ~60 indexer requests in its first minute (sweep of 22 pages,
// 2026-09-25) and a settled HIP-4 question with 29 outcomes ~45 in its first
// second. An open HIP-4 page keeps making ~80 a minute (its volume fan-out
// alone is ~17 chunks every 15 s), a dashboard or market page ~50. 4,000 a
// minute is ~50 HIP-4 tabs or ~80 dashboard tabs behind one IP.
const PASSTHROUGH_LIMITS = {
  BURST: { WINDOW: 1, MAX_REQUESTS: positiveIntEnv('PASSTHROUGH_RATE_LIMIT_BURST', 300) },
  MINUTE: { WINDOW: 60, MAX_REQUESTS: positiveIntEnv('PASSTHROUGH_RATE_LIMIT_MINUTE', 4000) },
};

interface IpLimits {
  BURST: { WINDOW: number; MAX_REQUESTS: number };
  MINUTE: { WINDOW: number; MAX_REQUESTS: number };
}

/**
 * Per-IP limiter with its own Redis namespace (so it stacks on top of the
 * general limiter instead of sharing its counters), in-memory fallback when
 * Redis cannot answer.
 *
 * `upstreamCaller` marks the routes whose cache keys the caller picks: the
 * admitted request then runs with its client as the upstream caller, whose
 * budget of billed HypeDexer calls is read once on entry (peekUpstreamBudget)
 * and counted by the client gate (countUpstreamCredits). Both paths below admit,
 * so the Redis-down fallback keeps the budget too.
 *
 * `cost` makes one request weigh more than 1 in both windows, for a route
 * where a single request carries several units of work (a JSON-RPC batch). It
 * is read after the body was validated; anything below 1 counts as 1, and in
 * each window a request never weighs more than the window's whole budget (it
 * would be refused for good): the heaviest valid request takes the second, and
 * weighs its full weight in the minute, up to the whole minute.
 */
function createIpLimiter(
  namespace: string,
  limits: IpLimits,
  what: string,
  options: { upstreamCaller?: boolean; cost?: (req: Request) => number } = {}
) {
  const windows: readonly RateWindow[] = [
    { name: 'burst', seconds: limits.BURST.WINDOW },
    { name: 'minute', seconds: limits.MINUTE.WINDOW },
  ];
  const maxes: readonly number[] = [limits.BURST.MAX_REQUESTS, limits.MINUTE.MAX_REQUESTS];
  const admit = (req: Request, res: Response, next: NextFunction): Promise<void> | void =>
    options.upstreamCaller ? runWithUpstreamCaller(req, res, next, peekUpstreamBudget) : next();
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const ip = req.ip;
    if (!ip) {
      res.status(400).json({ error: 'IP address not found', message: 'Could not determine client IP address' });
      return;
    }
    // Per /64 for IPv6 (see marketRateLimiter), per address for IPv4; the /48 is counted too.
    const prefixes = limiterPrefixes(`ratelimit:${namespace}`, ip);
    const weight = options.cost ? Math.max(1, Math.trunc(options.cost(req)) || 1) : 1;
    const costs = [Math.min(limits.BURST.MAX_REQUESTS, weight), Math.min(limits.MINUTE.MAX_REQUESTS, weight)];
    let counts: number[][];
    let fallback = false;
    try {
      counts = await countRequests(prefixes, windows, costs);
    } catch (error) {
      logDeduplicator.error('IP rate limiter Redis error, using in-memory fallback', {
        namespace,
        error: error instanceof Error ? error.message : String(error),
        path: req.path,
        ip,
      });
      // Fail-secure, same as the general limiter: this limiter's own windows and limits, in this process.
      fallback = true;
      counts = prefixes.map((prefix) => countInMemory(prefix, windows, costs));
    }
    const refused = exceeded(counts[0], windows, maxes) ?? (counts[1] && exceeded(counts[1], windows, maxes, V6_SITE_FACTOR));
    if (refused) {
      return sendLimitExceededResponse(res, fallback ? 'Too many requests (fallback mode)' : `Too many ${what} requests per ${windowWord(refused)}`, refused.seconds);
    }
    await admit(req, res, next);
  };
}

export const passthroughRateLimiter = createIpLimiter('pt', PASSTHROUGH_LIMITS, 'indexer', { upstreamCaller: true });

/**
 * Per-address lookups (Elysium address / contract profiles; the paid indexer's
 * per-address routes have their own, wider limiter below). Any valid address is a fresh cache key, so each request can
 * run a batch of SQL or a paid upstream call: a page view makes 1-4 of them.
 * 300 a minute per IP (20 a second) lets dozens of people behind one address
 * browse profiles and still caps a scripted sweep.
 */
export const addressLookupRateLimiter = createIpLimiter(
  'addr',
  {
    BURST: { WINDOW: 1, MAX_REQUESTS: positiveIntEnv('ADDRESS_LOOKUP_RATE_LIMIT_BURST', 20) },
    MINUTE: { WINDOW: 60, MAX_REQUESTS: positiveIntEnv('ADDRESS_LOOKUP_RATE_LIMIT_MINUTE', 300) },
  },
  'address lookup',
  { upstreamCaller: true }
);

/**
 * Launchpad token search (`GET /elysium/analytics/launchpads?q=`): every new
 * text is a read of the launches that no cache has (a scan when the text is one
 * or two letters). The page asks again 150 ms after the last keystroke, so one
 * person typing makes at most ~7 requests a second; 20 a second and 300 a
 * minute per IP leave room for several, and the service itself runs three
 * searches at a time.
 */
export const elysiumSearchRateLimiter = createIpLimiter(
  'elysearch',
  {
    BURST: { WINDOW: 1, MAX_REQUESTS: positiveIntEnv('ELYSIUM_SEARCH_RATE_LIMIT_BURST', 20) },
    MINUTE: { WINDOW: 60, MAX_REQUESTS: positiveIntEnv('ELYSIUM_SEARCH_RATE_LIMIT_MINUTE', 300) },
  },
  'launchpad search'
);

/**
 * Elysium mainnet RPC proxy (`POST /elysium/rpc`): every JSON-RPC call is one
 * call to the keyed archive node, so this counts calls, not requests, each at
 * its weight (elysiumRpcCallWeight: 1 for a plain read, more for the calls
 * whose parameters size the node's work): a batch of 20 plain reads weighs 20,
 * one `eth_simulateV1` of 40 calls weighs 40, and one of 256 calls takes its
 * second whole and 256 of the minute. The general limiter in front of
 * it counts requests, and at 6,000 a minute a client sending full batches
 * reached the node hundreds of thousands of times a minute.
 *
 * The builder tools send single calls: opening one makes about 7 to 15 of
 * them at once (network parameters, token check: counted in the front's code,
 * not measured in a browser), then a pending transaction is polled every 4 s.
 * 50 a second lets a few people behind one IP open a tool together, and 1,200
 * a minute is 20 calls a second sustained.
 */
const ELYSIUM_RPC_MINUTE = positiveIntEnv('ELYSIUM_RPC_RATE_LIMIT_MINUTE', 1200);
export const elysiumRpcRateLimiter = createIpLimiter(
  'elyrpc',
  {
    BURST: { WINDOW: 1, MAX_REQUESTS: positiveIntEnv('ELYSIUM_RPC_RATE_LIMIT_BURST', 50) },
    MINUTE: { WINDOW: 60, MAX_REQUESTS: ELYSIUM_RPC_MINUTE },
  },
  'Elysium RPC',
  { cost: (req) => elysiumRpcRequestWeight(req.body) }
);

/** The same weight, capped like the limiter caps it in its minute: what the proxy counts against its own minute. */
export function elysiumRpcWeightOf(body: unknown): number {
  return Math.min(ELYSIUM_RPC_MINUTE, Math.max(1, elysiumRpcRequestWeight(body)));
}

/**
 * Per-address passthrough to the paid indexer (wallet fills, funding, TWAPs,
 * profile aggregates). Any address is a fresh cache key and a billed upstream
 * call, so these get a counter of their own on top of the general passthrough
 * one. addressLookupRateLimiter (20 a second) is too tight for them: opening
 * one wallet page makes 6 of these calls in its first second (overview,
 * performance, coins, coin distribution, funding summary, round-trips) and
 * ~5 a minute while it stays open, so four people opening a wallet in the same
 * second behind one IP would hit it. 60 a second fits ten simultaneous
 * openings; 1,200 a minute is ~200 wallet openings or ~230 open wallet pages
 * per IP, far above browsing, well below a scripted address sweep.
 */
export const indexerAddressRateLimiter = createIpLimiter(
  'iaddr',
  {
    BURST: { WINDOW: 1, MAX_REQUESTS: positiveIntEnv('INDEXER_ADDRESS_RATE_LIMIT_BURST', 60) },
    MINUTE: { WINDOW: 60, MAX_REQUESTS: positiveIntEnv('INDEXER_ADDRESS_RATE_LIMIT_MINUTE', 1200) },
  },
  'indexer address'
);

/**
 * Same budget for list routes whose address is an optional `user` query param:
 * only requests that name one are counted, so market-wide polls of the same
 * route (biggest trades, live fills) never spend it.
 */
export const indexerAddressQueryRateLimiter = (req: Request, res: Response, next: NextFunction): Promise<void> | void => {
  const user = req.query.user;
  if (typeof user !== 'string' || user === '') return next();
  return indexerAddressRateLimiter(req, res, next);
};

/**
 * Account and write routes (auth, CSV uploads): stacked on the general
 * limiter, whose ceilings are sized for read traffic. These are the limits
 * the general limiter used to apply to them (60 a second, 1,200 a minute per
 * IP), in their own counters so browsing never spends them.
 */
export const accountRateLimiter = createIpLimiter(
  'acct',
  { BURST: { WINDOW: 1, MAX_REQUESTS: 60 }, MINUTE: { WINDOW: 60, MAX_REQUESTS: 1200 } },
  'account'
);

/**
 * Hyperliquid Names writes: mint passes (each one spends a signature from our
 * Builder Program key) and cache purges (each one makes the next profile view
 * cost 3 upstream calls). A mint takes 1 or 2 passes and 1 purge, so 3 a
 * second and 20 a minute per IP cover a user retrying a few mints and stop a
 * script from farming either.
 */
export const namesWriteRateLimiter = createIpLimiter(
  'hln',
  { BURST: { WINDOW: 1, MAX_REQUESTS: 3 }, MINUTE: { WINDOW: 60, MAX_REQUESTS: 20 } },
  'name write'
);

// Budget of what HypeDexer bills for a client's requests (cache misses only: a hit
// costs nothing upstream and is never counted), in the unit that is billed: credits.
//
// It used to count calls: 600 a minute and 15,000 an hour per client, whatever
// they cost. A call is billed 2 credits plus 1 per 10 rows it returns (3 flat on
// /info), so the same 15,000 calls were 45,000 credits of small reads or 1.5
// million of 1,000-row pages, and nothing bounded what all clients spent together.
//
// Per client (IP, /64 for IPv6): 6,000 credits a minute and 150,000 an hour, which
// is the old budget at 10 credits a call. Measured costs: a wallet page makes ~6
// misses when it opens (3 to 12 credits each for an ordinary wallet) and ~5 a
// minute while it stays open; a cold settled HIP-4 question ~45 reads of 3 to 7
// credits in its first second. 6,000 a minute is ~19 cold HIP-4 questions or ~150
// cold wallets a minute behind one IP; 150,000 an hour is ~50 wallet pages kept
// open behind one IP. Only floods and scripts get near them.
//
// Per /48 for IPv6 (a site: 65,536 subnets, each of which had a budget of its
// own): 8 clients' worth.
//
// For all clients together: 120,000 credits a minute. Past it, a client that has
// spent less than its reserve this minute (600 credits: a few cold pages) still
// goes on, so that a flood from many addresses cannot leave an ordinary visitor
// with nothing; past twice it, nobody starts new billed work until the minute
// rolls over. What every visitor together can spend is bounded either way.
//
// The budget covers the routes whose cache keys the caller picks (the limiters
// above that set the upstream caller). Shared aggregates are not charged to
// whichever visitor happens to trigger them: the HIP-4 resolutions and live
// volumes and the TWAP source sit behind marketRateLimiter only, run without a
// caller and are never counted or refused.
//
// The budget is decided once per request, on entry (peekUpstreamBudget); what is
// billed is counted as it is known (countUpstreamCredits: the price every call
// has when it starts, the rest when its answer says what it cost) and never
// refused while it is counted: a request that started within budget is served
// whole, and the client's next request finds the counters where they ended.
const CREDIT_BUDGET = {
  MINUTE: { WINDOW: 60, MAX: positiveIntEnv('HYPEDEXER_CREDIT_BUDGET_MINUTE', 6_000) },
  HOUR: { WINDOW: 3600, MAX: positiveIntEnv('HYPEDEXER_CREDIT_BUDGET_HOUR', 150_000) },
};
/** How many clients' budgets the /48 of an IPv6 client may spend. */
const CREDIT_SITE_FACTOR = positiveIntEnv('HYPEDEXER_CREDIT_BUDGET_V6_SITE_FACTOR', 8);
/** What all clients together may spend in a minute before the big spenders are held back. */
const CREDIT_GLOBAL_MINUTE = positiveIntEnv('HYPEDEXER_CREDIT_BUDGET_GLOBAL_MINUTE', 120_000);
/** Past this many times the common ceiling, nobody starts new billed work. */
const CREDIT_GLOBAL_HARD_FACTOR = 2;
/** What a client can spend in a minute and still go on once the common ceiling is passed. */
const CREDIT_RESERVE_MINUTE = positiveIntEnv('HYPEDEXER_CREDIT_RESERVE_MINUTE', 600);

/** What any HypeDexer call is billed at least: counted when the call starts, before its answer says the rest. */
export const UPSTREAM_CALL_BASE_CREDITS = 2;

const CREDIT_WINDOWS: readonly RateWindow[] = [
  { name: 'minute', seconds: CREDIT_BUDGET.MINUTE.WINDOW },
  { name: 'hour', seconds: CREDIT_BUDGET.HOUR.WINDOW },
];

const creditPrefix = (ipKey: string): string => `ratelimit:hdcr:${ipKey}`;
const creditSitePrefix = (siteKey: string): string => `ratelimit:hdcr:site:${siteKey}`;
const CREDIT_GLOBAL_PREFIX = 'ratelimit:hdcr:all';

/** The counters a client's credits are counted under: its own, its /48's when it has one, everyone's. */
function creditPrefixes(ipKey: string, siteKey?: string): string[] {
  return siteKey ? [creditPrefix(ipKey), CREDIT_GLOBAL_PREFIX, creditSitePrefix(siteKey)] : [creditPrefix(ipKey), CREDIT_GLOBAL_PREFIX];
}

/**
 * The longest a refused client is told to wait. The hour window can be
 * hundreds of seconds from rolling over, and the front backs its widgets off
 * for the whole Retry-After: a visitor sharing an IP with a flood would lose
 * live data for up to an hour. A refusal is cheap (an entry peek, no upstream
 * call, no counting), so the client just asks again within the minute and is
 * refused again until the window rolls over.
 */
const MAX_RETRY_AFTER_S = 60;

/**
 * Where a client stands, from the credits counted this minute and this hour under its own key,
 * its /48's (IPv6 only) and everyone's: at a limit counts as spent (the next call would pass it).
 */
function budgetState(
  counts: { client: readonly number[]; global: readonly number[]; site?: readonly number[] },
  minuteLeftS: number,
  hourLeftS: number
): UpstreamBudgetState {
  let retryAfterS = 0;
  const [minute, hour] = counts.client;
  if (minute >= CREDIT_BUDGET.MINUTE.MAX) retryAfterS = Math.max(retryAfterS, minuteLeftS);
  if (hour >= CREDIT_BUDGET.HOUR.MAX) retryAfterS = Math.max(retryAfterS, hourLeftS);
  if (counts.site) {
    if (counts.site[0] >= CREDIT_BUDGET.MINUTE.MAX * CREDIT_SITE_FACTOR) retryAfterS = Math.max(retryAfterS, minuteLeftS);
    if (counts.site[1] >= CREDIT_BUDGET.HOUR.MAX * CREDIT_SITE_FACTOR) retryAfterS = Math.max(retryAfterS, hourLeftS);
  }
  // The common ceiling. The reserve is per /48 for IPv6: a site's subnets share one, not 65,536.
  const everyone = counts.global[0];
  const mine = counts.site ? counts.site[0] : minute;
  if (everyone >= CREDIT_GLOBAL_MINUTE * CREDIT_GLOBAL_HARD_FACTOR || (everyone >= CREDIT_GLOBAL_MINUTE && mine >= CREDIT_RESERVE_MINUTE)) {
    retryAfterS = Math.max(retryAfterS, minuteLeftS);
  }
  return retryAfterS > 0
    ? { exhausted: true, retryAfterS: Math.min(MAX_RETRY_AFTER_S, Math.max(1, retryAfterS)) }
    : { exhausted: false, retryAfterS: 0 };
}

// The same counters in this process, for when Redis cannot answer (same windows, same limits).
const inMemoryCredits = new Map<string, MemoryEntry>();

/** The counts of `key` in `windows` in this process, without counting anything. */
function peekInMemory(counters: Map<string, MemoryEntry>, key: string, windows: readonly RateWindow[]): number[] {
  const nowS = Math.floor(Date.now() / 1000);
  const slots = counters.get(key)?.slots;
  return windows.map((window, i) => (slots?.[i]?.index === Math.floor(nowS / window.seconds) ? slots[i].count : 0));
}

setInterval(() => {
  const nowS = Math.floor(Date.now() / 1000);
  for (const [key, entry] of inMemoryCredits) {
    if (entry.untilS <= nowS) inMemoryCredits.delete(key);
  }
}, 60000).unref();

function peekInMemoryBudget(ipKey: string, siteKey?: string): UpstreamBudgetState {
  const [client, global, site] = creditPrefixes(ipKey, siteKey).map((prefix) => peekInMemory(inMemoryCredits, prefix, CREDIT_WINDOWS));
  return budgetState({ client, global, site }, secondsUntilRollover(CREDIT_BUDGET.MINUTE.WINDOW), secondsUntilRollover(CREDIT_BUDGET.HOUR.WINDOW));
}

/**
 * Where this client (IP, /64 for IPv6; `siteKey` is its /48) stands against the
 * budget, read without counting anything: one MGET of the current minute and
 * hour windows, the same keys countUpstreamCredits increments. Read once per
 * request, on entry. When Redis cannot answer, the in-memory counters (same
 * limits) answer instead.
 */
export async function peekUpstreamBudget(ipKey: string, siteKey?: string): Promise<UpstreamBudgetState> {
  try {
    // Circuit open: don't queue on a wedged connection, use the fallback now.
    if (!redisService.isHealthy()) throw new Error('Redis circuit open');
    const nowS = Math.floor(Date.now() / 1000);
    const prefixes = creditPrefixes(ipKey, siteKey);
    const values = (await redisService.getClient().mget(
      ...prefixes.flatMap((prefix) => CREDIT_WINDOWS.map((window) => windowKey(prefix, window, nowS)))
    )) as (string | null)[];
    const of = (p: number): number[] => CREDIT_WINDOWS.map((_, i) => Number(values[p * CREDIT_WINDOWS.length + i] ?? 0));
    return budgetState(
      { client: of(0), global: of(1), site: siteKey ? of(2) : undefined },
      secondsUntilRollover(CREDIT_BUDGET.MINUTE.WINDOW),
      secondsUntilRollover(CREDIT_BUDGET.HOUR.WINDOW)
    );
  } catch (error) {
    logDeduplicator.error('Upstream budget Redis error, using in-memory fallback', {
      error: error instanceof Error ? error.message : String(error),
      ip: ipKey,
    });
    return peekInMemoryBudget(ipKey, siteKey);
  }
}

/**
 * Counts `credits` billed by HypeDexer for this client against its minute and
 * hour windows, its /48's and everyone's (INCRBY + EXPIRE in one round trip).
 * Never refuses, never waits: the call goes ahead and the pipeline runs behind
 * it, so a Redis error is handled here (the in-memory counters take the
 * credits) and nothing is thrown at the caller.
 */
export function countUpstreamCredits(caller: { ipKey: string; siteKey?: string }, credits: number): void {
  const amount = Math.ceil(credits);
  if (!Number.isFinite(amount) || amount <= 0) return;
  const prefixes = creditPrefixes(caller.ipKey, caller.siteKey);
  const inMemory = (): void => {
    for (const prefix of prefixes) countInMemory(prefix, CREDIT_WINDOWS, amount, inMemoryCredits);
  };
  if (!redisService.isHealthy()) {
    inMemory();
    return;
  }
  countRequests(prefixes, CREDIT_WINDOWS, amount).catch((error: unknown) => {
    logDeduplicator.error('Upstream budget Redis error, using in-memory fallback', {
      error: error instanceof Error ? error.message : String(error),
      ip: caller.ipKey,
    });
    inMemory();
  });
}
