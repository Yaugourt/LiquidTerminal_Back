import { Request, Response, NextFunction } from 'express';
import { redisService } from '../core/redis.service';
import { logDeduplicator } from '../utils/logDeduplicator';
import { positiveIntEnv } from '../utils/env';
import { rateLimitKeyForIp } from '../utils/client-ip';
import { runWithUpstreamCaller, type UpstreamBudgetState } from '../utils/request-context';

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
 */
async function countRequest(prefix: string, windows: readonly RateWindow[]): Promise<number[]> {
  // Circuit open: don't queue on a wedged connection, use the fallback now.
  if (!redisService.isHealthy()) throw new Error('Redis circuit open');
  const now = Math.floor(Date.now() / 1000);
  const pipeline = redisService.getClient().pipeline();
  for (const window of windows) {
    const key = windowKey(prefix, window, now);
    pipeline.incr(key);
    pipeline.expire(key, window.seconds * 2);
  }

  const results = await pipeline.exec();
  if (!results) {
    throw new Error('Rate limiter pipeline aborted');
  }
  return windows.map((_, i) => {
    const [error, count] = results[i * 2];
    if (error) throw error;
    return Number(count);
  });
}

// In-memory fallback when Redis is down (fail-secure)
const inMemoryCounters = new Map<string, { count: number; resetAt: number }>();
// Was 10 — below the 15 req/s a single page load actually makes, so a Redis
// outage would have 429'd every normal user. Aligned with the burst limit.
const FALLBACK_MAX_PER_SECOND = RATE_LIMITS.BURST_LIMIT.MAX_REQUESTS;
const FALLBACK_MAX_IPS = 10000;

/** One-second window per key; `maxPerSecond` is the limiter's own burst. */
function checkInMemoryFallback(ip: string, maxPerSecond: number = FALLBACK_MAX_PER_SECOND): boolean {
  const now = Date.now();
  const counter = inMemoryCounters.get(ip);

  if (!counter || now > counter.resetAt) {
    // Evict oldest if at capacity
    if (!inMemoryCounters.has(ip) && inMemoryCounters.size >= FALLBACK_MAX_IPS) {
      const firstKey = inMemoryCounters.keys().next().value;
      if (firstKey) inMemoryCounters.delete(firstKey);
    }
    inMemoryCounters.set(ip, { count: 1, resetAt: now + 1000 });
    return true;
  }

  if (counter.count >= maxPerSecond) {
    return false;
  }

  counter.count++;
  return true;
}

// Periodic cleanup of stale entries (every 60s)
setInterval(() => {
  const now = Date.now();
  for (const [ip, counter] of inMemoryCounters) {
    if (now > counter.resetAt) {
      inMemoryCounters.delete(ip);
    }
  }
}, 60000).unref();

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
  // budget is per /64 (IPv4 stays per address).
  const key = rateLimitKeyForIp(ip);

  try {
    // Vérification multi-niveaux avec Redis
    const [burstCount, minuteCount, hourCount] = await countRequest(`ratelimit:${key}`, MARKET_WINDOWS);

    // Vérification des limites
    if (burstCount > RATE_LIMITS.BURST_LIMIT.MAX_REQUESTS) {
      return sendLimitExceededResponse(res, 'Too many requests per second', RATE_LIMITS.BURST_LIMIT.WINDOW);
    }

    if (minuteCount > RATE_LIMITS.MINUTE_LIMIT.MAX_REQUESTS) {
      return sendLimitExceededResponse(res, 'Too many requests per minute', RATE_LIMITS.MINUTE_LIMIT.WINDOW);
    }

    if (hourCount > RATE_LIMITS.HOUR_LIMIT.MAX_REQUESTS) {
      return sendLimitExceededResponse(res, 'Too many requests per hour', RATE_LIMITS.HOUR_LIMIT.WINDOW);
    }

    next();
  } catch (error) {
    logDeduplicator.error('Rate limiter Redis error, using in-memory fallback', {
      error: error instanceof Error ? error.message : String(error),
      path: req.path,
      ip: req.ip
    });
    // Fail-secure: use in-memory fallback instead of letting everything through
    if (checkInMemoryFallback(key)) {
      next();
    } else {
      // The fallback counts one-second windows.
      sendLimitExceededResponse(res, 'Too many requests (fallback mode)', 1);
    }
  }
};

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
 * and counted by the client gate (countUpstreamCall). Both paths below admit,
 * so the Redis-down fallback keeps the budget too.
 */
function createIpLimiter(namespace: string, limits: IpLimits, what: string, options: { upstreamCaller?: boolean } = {}) {
  const windows: readonly RateWindow[] = [
    { name: 'burst', seconds: limits.BURST.WINDOW },
    { name: 'minute', seconds: limits.MINUTE.WINDOW },
  ];
  const admit = (req: Request, res: Response, next: NextFunction): Promise<void> | void =>
    options.upstreamCaller ? runWithUpstreamCaller(req, res, next, peekUpstreamBudget) : next();
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const ip = req.ip;
    if (!ip) {
      res.status(400).json({ error: 'IP address not found', message: 'Could not determine client IP address' });
      return;
    }
    // Per /64 for IPv6 (see marketRateLimiter), per address for IPv4.
    const key = rateLimitKeyForIp(ip);
    try {
      const [burstCount, minuteCount] = await countRequest(`ratelimit:${namespace}:${key}`, windows);
      if (burstCount > limits.BURST.MAX_REQUESTS) {
        return sendLimitExceededResponse(res, `Too many ${what} requests per second`, limits.BURST.WINDOW);
      }
      if (minuteCount > limits.MINUTE.MAX_REQUESTS) {
        return sendLimitExceededResponse(res, `Too many ${what} requests per minute`, limits.MINUTE.WINDOW);
      }
      await admit(req, res, next);
    } catch (error) {
      logDeduplicator.error('IP rate limiter Redis error, using in-memory fallback', {
        namespace,
        error: error instanceof Error ? error.message : String(error),
        path: req.path,
        ip,
      });
      // Fail-secure, same as the general limiter, at this limiter's own burst.
      // Distinct key namespace so the fallbacks don't share a counter.
      if (checkInMemoryFallback(`${namespace}:${key}`, limits.BURST.MAX_REQUESTS)) {
        await admit(req, res, next);
      } else {
        sendLimitExceededResponse(res, 'Too many requests (fallback mode)', 1);
      }
    }
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
 * Signed mint passes for Hyperliquid Names. Each request makes api.hlnames.xyz
 * sign with OUR partner key, for anyone, so a script could burn the partner
 * quota. A real mint asks for 1 pass (native) or 2 (USDC, one before and one
 * after the approval transaction), a wallet confirmation apart, so a person
 * makes a few a minute at most: 2 a second lets two people click together,
 * 20 a minute is ~10 USDC mints a minute behind one IP with room for retries.
 */
export const nameMintPassRateLimiter = createIpLimiter(
  'nmint',
  {
    BURST: { WINDOW: 1, MAX_REQUESTS: positiveIntEnv('NAME_MINT_PASS_RATE_LIMIT_BURST', 2) },
    MINUTE: { WINDOW: 60, MAX_REQUESTS: positiveIntEnv('NAME_MINT_PASS_RATE_LIMIT_MINUTE', 20) },
  },
  'name mint pass'
);

/**
 * Drops our cached name and profile of any address, so the next lookups go to
 * the provider again. The front sends exactly one after each successful mint,
 * so it follows the mint rate: 2 a second, 10 a minute per IP.
 */
export const nameCacheDropRateLimiter = createIpLimiter(
  'nforget',
  {
    BURST: { WINDOW: 1, MAX_REQUESTS: positiveIntEnv('NAME_CACHE_DROP_RATE_LIMIT_BURST', 2) },
    MINUTE: { WINDOW: 60, MAX_REQUESTS: positiveIntEnv('NAME_CACHE_DROP_RATE_LIMIT_MINUTE', 10) },
  },
  'name cache drop'
);

// Per-client budget of billed HypeDexer calls (cache misses only: a hit costs
// nothing upstream and is never counted). The passthrough limiter above counts
// every request, hits included, so on its own one IP could still make 4,000
// billed calls a minute with unique cache keys (credits = 2 + ceil(rows/10)
// each). Sizing, measured: a wallet page makes ~6 per-address misses when it
// opens and ~5 a minute while it stays open; a cold settled HIP-4 question
// ~45 in its first second; the HIP-4 resolutions recompute (~250 reads, once an
// hour for everyone) is charged to the visitor who triggers it. 600 a minute
// is ~13 cold HIP-4 questions or ~100 cold wallets a minute behind one IP;
// 15,000 an hour is ~50 wallet pages kept open behind one IP. Only floods and
// scripts get near them.
//
// The budget is decided once per request, on entry (peekUpstreamBudget); the
// calls are counted exactly (countUpstreamCall) and never refused while they
// are counted: a request that started within budget is served whole, and the
// client's next request finds the counter where it ended.
const UPSTREAM_BUDGET = {
  MINUTE: { WINDOW: 60, MAX_CALLS: positiveIntEnv('HYPEDEXER_MISS_BUDGET_MINUTE', 600) },
  HOUR: { WINDOW: 3600, MAX_CALLS: positiveIntEnv('HYPEDEXER_MISS_BUDGET_HOUR', 15000) },
};

const UPSTREAM_BUDGET_WINDOWS: readonly RateWindow[] = [
  { name: 'minute', seconds: UPSTREAM_BUDGET.MINUTE.WINDOW },
  { name: 'hour', seconds: UPSTREAM_BUDGET.HOUR.WINDOW },
];

const upstreamBudgetPrefix = (ipKey: string): string => `ratelimit:hdmiss:${ipKey}`;

/**
 * The longest a refused client is told to wait. The hour window can be
 * hundreds of seconds from rolling over, and the front backs its widgets off
 * for the whole Retry-After: a visitor sharing an IP with a flood would lose
 * live data for up to an hour. A refusal is cheap (an entry peek, no upstream
 * call, no counting), so the client just asks again within the minute and is
 * refused again until the window rolls over.
 */
const MAX_RETRY_AFTER_S = 60;

/** Where a client stands, from its minute and hour counts: at a limit counts as spent (the next call would pass it). */
function budgetState(minuteCount: number, hourCount: number, minuteLeftS: number, hourLeftS: number): UpstreamBudgetState {
  let retryAfterS = 0;
  if (minuteCount >= UPSTREAM_BUDGET.MINUTE.MAX_CALLS) retryAfterS = Math.max(retryAfterS, minuteLeftS);
  if (hourCount >= UPSTREAM_BUDGET.HOUR.MAX_CALLS) retryAfterS = Math.max(retryAfterS, hourLeftS);
  return retryAfterS > 0
    ? { exhausted: true, retryAfterS: Math.min(MAX_RETRY_AFTER_S, Math.max(1, retryAfterS)) }
    : { exhausted: false, retryAfterS: 0 };
}

// Same idea as inMemoryCounters, with the minute and hour windows of the budget.
type InMemoryBudget = { minute: { count: number; resetAt: number }; hour: { count: number; resetAt: number } };
const inMemoryBudgets = new Map<string, InMemoryBudget>();

/** The entry of `ipKey` with expired windows reset; undefined when it has none and `create` is false. */
function inMemoryBudgetOf(ipKey: string, create: boolean): InMemoryBudget | undefined {
  const now = Date.now();
  let entry = inMemoryBudgets.get(ipKey);
  if (!entry) {
    if (!create) return undefined;
    // Evict oldest if at capacity
    if (inMemoryBudgets.size >= FALLBACK_MAX_IPS) {
      const firstKey = inMemoryBudgets.keys().next().value;
      if (firstKey) inMemoryBudgets.delete(firstKey);
    }
    entry = {
      minute: { count: 0, resetAt: now + UPSTREAM_BUDGET.MINUTE.WINDOW * 1000 },
      hour: { count: 0, resetAt: now + UPSTREAM_BUDGET.HOUR.WINDOW * 1000 },
    };
    inMemoryBudgets.set(ipKey, entry);
  }
  if (now > entry.minute.resetAt) entry.minute = { count: 0, resetAt: now + UPSTREAM_BUDGET.MINUTE.WINDOW * 1000 };
  if (now > entry.hour.resetAt) entry.hour = { count: 0, resetAt: now + UPSTREAM_BUDGET.HOUR.WINDOW * 1000 };
  return entry;
}

function countInMemoryBudget(ipKey: string): void {
  const entry = inMemoryBudgetOf(ipKey, true);
  if (!entry) return;
  entry.minute.count++;
  entry.hour.count++;
}

function peekInMemoryBudget(ipKey: string): UpstreamBudgetState {
  const entry = inMemoryBudgetOf(ipKey, false);
  if (!entry) return { exhausted: false, retryAfterS: 0 };
  const now = Date.now();
  return budgetState(
    entry.minute.count,
    entry.hour.count,
    Math.ceil((entry.minute.resetAt - now) / 1000),
    Math.ceil((entry.hour.resetAt - now) / 1000)
  );
}

setInterval(() => {
  const now = Date.now();
  for (const [ipKey, entry] of inMemoryBudgets) {
    if (now > entry.hour.resetAt) inMemoryBudgets.delete(ipKey);
  }
}, 60000).unref();

/**
 * Where this client (IP, /64 for IPv6) stands against its budget, read without
 * counting anything: one MGET of the current minute and hour windows, the same
 * keys countUpstreamCall increments. Read once per request, on entry. When
 * Redis cannot answer, the in-memory counters (same limits) answer instead.
 */
export async function peekUpstreamBudget(ipKey: string): Promise<UpstreamBudgetState> {
  try {
    // Circuit open: don't queue on a wedged connection, use the fallback now.
    if (!redisService.isHealthy()) throw new Error('Redis circuit open');
    const nowS = Math.floor(Date.now() / 1000);
    const prefix = upstreamBudgetPrefix(ipKey);
    const [minute, hour] = (await redisService.getClient().mget(
      ...UPSTREAM_BUDGET_WINDOWS.map((window) => windowKey(prefix, window, nowS))
    )) as (string | null)[];
    return budgetState(
      Number(minute ?? 0),
      Number(hour ?? 0),
      secondsUntilRollover(UPSTREAM_BUDGET.MINUTE.WINDOW),
      secondsUntilRollover(UPSTREAM_BUDGET.HOUR.WINDOW)
    );
  } catch (error) {
    logDeduplicator.error('Upstream budget Redis error, using in-memory fallback', {
      error: error instanceof Error ? error.message : String(error),
      ip: ipKey,
    });
    return peekInMemoryBudget(ipKey);
  }
}

/**
 * Counts one billed HypeDexer call that really goes upstream against this
 * client's minute and hour windows (INCR + EXPIRE in one round trip). Never
 * refuses, never waits: the call goes ahead and the pipeline runs behind it,
 * so a Redis error is handled here (the in-memory counters take the call) and
 * nothing is thrown at the caller.
 */
export function countUpstreamCall(ipKey: string): void {
  if (!redisService.isHealthy()) {
    countInMemoryBudget(ipKey);
    return;
  }
  countRequest(upstreamBudgetPrefix(ipKey), UPSTREAM_BUDGET_WINDOWS).catch((error: unknown) => {
    logDeduplicator.error('Upstream budget Redis error, using in-memory fallback', {
      error: error instanceof Error ? error.message : String(error),
      ip: ipKey,
    });
    countInMemoryBudget(ipKey);
  });
}
