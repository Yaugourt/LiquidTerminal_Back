import { randomUUID } from 'node:crypto';
import { Request, Response, NextFunction } from 'express';
import { redisService } from '../core/redis.service';
import { logDeduplicator } from '../utils/logDeduplicator';

// Configuration des limites
const RATE_LIMITS = {
  // Limites par seconde pour prévenir les bursts
  BURST_LIMIT: {
    WINDOW: 1,
    // Measured in a real browser on 2026-07-26: a single page load of
    // /dashboard/market fires 15 requests inside its first second, /dashboard
    // 13. The previous value of 20 was written while the counter was broken and
    // never enforced anything; switching it on at 20 would have thrown 429s at
    // anyone with two tabs open. 60 leaves ~4x headroom over a real page while
    // still stopping a scripted flood, which runs in the hundreds per second.
    MAX_REQUESTS: 60
  },
  // Limites par minute pour le moyen terme
  MINUTE_LIMIT: {
    WINDOW: 60,       // 60 secondes
    MAX_REQUESTS: 1200 // 20 req/sec en moyenne sur la minute
  },
  // Limites par heure pour détecter les abus
  HOUR_LIMIT: {
    WINDOW: 3600,      // 3600 secondes
    MAX_REQUESTS: 72000 // 20 req/sec en moyenne sur l'heure
  }
};

// Clés Redis pour les différentes fenêtres de temps
const getRedisKeys = (ip: string) => ({
  burstKey: `ratelimit:${ip}:burst`,
  minuteKey: `ratelimit:${ip}:minute`,
  hourKey: `ratelimit:${ip}:hour`
});

// In-memory fallback when Redis is down (fail-secure)
const inMemoryCounters = new Map<string, { count: number; resetAt: number }>();
// Was 10 — below the 15 req/s a single page load actually makes, so a Redis
// outage would have 429'd every normal user. Aligned with the burst limit.
const FALLBACK_MAX_PER_SECOND = 60;
const FALLBACK_MAX_IPS = 10000;

function checkInMemoryFallback(ip: string): boolean {
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

  if (counter.count >= FALLBACK_MAX_PER_SECOND) {
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

  const keys = getRedisKeys(ip);
  const now = Math.floor(Date.now() / 1000);

  try {
    // Vérification multi-niveaux avec Redis
    const [burstCount, minuteCount, hourCount] = await Promise.all([
      incrementAndGetCount(keys.burstKey, now, RATE_LIMITS.BURST_LIMIT.WINDOW),
      incrementAndGetCount(keys.minuteKey, now, RATE_LIMITS.MINUTE_LIMIT.WINDOW),
      incrementAndGetCount(keys.hourKey, now, RATE_LIMITS.HOUR_LIMIT.WINDOW)
    ]);

    // Vérification des limites
    if (burstCount > RATE_LIMITS.BURST_LIMIT.MAX_REQUESTS) {
      return sendLimitExceededResponse(res, 'Too many requests per second');
    }

    if (minuteCount > RATE_LIMITS.MINUTE_LIMIT.MAX_REQUESTS) {
      return sendLimitExceededResponse(res, 'Too many requests per minute');
    }

    if (hourCount > RATE_LIMITS.HOUR_LIMIT.MAX_REQUESTS) {
      return sendLimitExceededResponse(res, 'Too many requests per hour');
    }

    next();
  } catch (error) {
    logDeduplicator.error('Rate limiter Redis error, using in-memory fallback', {
      error: error instanceof Error ? error.message : String(error),
      path: req.path,
      ip: req.ip
    });
    // Fail-secure: use in-memory fallback instead of letting everything through
    if (checkInMemoryFallback(ip)) {
      next();
    } else {
      sendLimitExceededResponse(res, 'Too many requests (fallback mode)');
    }
  }
};

async function incrementAndGetCount(key: string, now: number, window: number): Promise<number> {
  try {
    // ✅ Utiliser un pipeline Redis pour grouper les 4 commandes en 1 seul round-trip
    const redis = redisService.getClient();
    const pipeline = redis.pipeline();
    // The member must be unique per request. It used to be `${now}` — the
    // timestamp itself — so every request landing in the same second wrote the
    // SAME member and ZADD merely updated its score. ZCARD then counted
    // distinct seconds, never requests: the 1s window could not exceed 2, the
    // minute window 61, the hour window 3601. All three thresholds (20 / 1200 /
    // 72000) were unreachable, so this middleware limited nothing at all.
    pipeline.zadd(key, now, `${now}:${randomUUID()}`);
    pipeline.zremrangebyscore(key, 0, now - window); // Nettoyer les anciennes entrées
    pipeline.zcard(key);                          // Compter les entrées restantes
    pipeline.expire(key, window * 2);             // Définir une expiration
    
    const results = await pipeline.exec();
    
    // Le résultat de zcard est à l'index 2 (3ème commande)
    // Format: [[err, result], [err, result], ...]
    const zcardResult = results?.[2];
    if (zcardResult && zcardResult[0] === null) {
      return zcardResult[1] as number;
    }
    
    return 0;
  } catch (error) {
    logDeduplicator.error('Rate limiter Redis error', {
      error: error instanceof Error ? error.message : String(error),
      key
    });
    return 0;
  }
}

function sendLimitExceededResponse(res: Response, message: string): void {
  res.status(429).json({
    error: 'Rate limit exceeded',
    message,
    retryAfter: 60 // Suggérer d'attendre 1 minute
  });
}

// Tighter limits for uncached HypeDexer passthrough routes. Each such request
// makes a paid upstream call and holds an outbound slot; the general limiter
// (1200/min) is far too loose to bound that cost. These endpoints are polled by
// the UI at most a few times per second, so 20/s burst + 300/min per IP leaves
// ample headroom while capping the amplification an attacker can drive against
// the HypeDexer key and the outbound pool.
const PASSTHROUGH_LIMITS = {
  BURST: { WINDOW: 1, MAX_REQUESTS: 20 },
  MINUTE: { WINDOW: 60, MAX_REQUESTS: 300 },
};

const getPassthroughKeys = (ip: string) => ({
  burstKey: `ratelimit:pt:${ip}:burst`,
  minuteKey: `ratelimit:pt:${ip}:minute`,
});

export const passthroughRateLimiter = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const ip = req.ip;
  if (!ip) {
    res.status(400).json({ error: 'IP address not found', message: 'Could not determine client IP address' });
    return;
  }

  const keys = getPassthroughKeys(ip);
  const now = Math.floor(Date.now() / 1000);

  try {
    const [burstCount, minuteCount] = await Promise.all([
      incrementAndGetCount(keys.burstKey, now, PASSTHROUGH_LIMITS.BURST.WINDOW),
      incrementAndGetCount(keys.minuteKey, now, PASSTHROUGH_LIMITS.MINUTE.WINDOW),
    ]);

    if (burstCount > PASSTHROUGH_LIMITS.BURST.MAX_REQUESTS) {
      return sendLimitExceededResponse(res, 'Too many indexer requests per second');
    }
    if (minuteCount > PASSTHROUGH_LIMITS.MINUTE.MAX_REQUESTS) {
      return sendLimitExceededResponse(res, 'Too many indexer requests per minute');
    }
    next();
  } catch (error) {
    logDeduplicator.error('Passthrough rate limiter Redis error, using in-memory fallback', {
      error: error instanceof Error ? error.message : String(error),
      path: req.path,
      ip,
    });
    // Fail-secure, same as the general limiter. Distinct key namespace so the
    // two fallbacks don't share a counter.
    if (checkInMemoryFallback(`pt:${ip}`)) {
      next();
    } else {
      sendLimitExceededResponse(res, 'Too many requests (fallback mode)');
    }
  }
};