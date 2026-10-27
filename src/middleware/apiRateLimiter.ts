import { Request, Response, NextFunction } from 'express';
import { redisService } from '../core/redis.service';
import { logDeduplicator } from '../utils/logDeduplicator';
import { positiveIntEnv } from '../utils/env';
import { rateLimitKeyForIp } from '../utils/client-ip';

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
    const key = `${prefix}:${window.name}:${Math.floor(now / window.seconds)}`;
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
 */
function createIpLimiter(namespace: string, limits: IpLimits, what: string) {
  const windows: readonly RateWindow[] = [
    { name: 'burst', seconds: limits.BURST.WINDOW },
    { name: 'minute', seconds: limits.MINUTE.WINDOW },
  ];
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
      next();
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
        next();
      } else {
        sendLimitExceededResponse(res, 'Too many requests (fallback mode)', 1);
      }
    }
  };
}

export const passthroughRateLimiter = createIpLimiter('pt', PASSTHROUGH_LIMITS, 'indexer');

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
  'address lookup'
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
