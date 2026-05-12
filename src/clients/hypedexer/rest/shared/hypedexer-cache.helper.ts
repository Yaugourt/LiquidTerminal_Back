import { redisService } from '../../../../core/redis.service';
import { logDeduplicator } from '../../../../utils/logDeduplicator';

/**
 * Cache-aside helper for HypeDexer REST pass-through routes.
 *
 * - Reads Redis first; on hit parses JSON and returns the cached value.
 * - On miss (or any Redis error) invokes the fetcher and writes the result
 *   to Redis with `ttlSeconds` TTL.
 * - Fail-open: Redis failures never block the user — they degrade to a
 *   direct fetcher call.
 */
export async function withRedisCache<T>(
  cacheKey: string,
  ttlSeconds: number,
  fetcher: () => Promise<T>,
): Promise<T> {
  // Read phase — fail-open on Redis errors.
  try {
    const cached = await redisService.get(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached) as T;
      } catch (parseErr) {
        logDeduplicator.warn('withRedisCache: failed to parse cached payload, refetching', {
          cacheKey,
          error: parseErr instanceof Error ? parseErr.message : String(parseErr),
        });
      }
    }
  } catch (err) {
    logDeduplicator.warn('withRedisCache: redis read failed, falling through to fetcher', {
      cacheKey,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const value = await fetcher();

  // Write phase — fire and forget but awaited so TTLs are honored deterministically
  // in tests. Failures are logged and swallowed.
  try {
    await redisService.set(cacheKey, JSON.stringify(value), ttlSeconds);
  } catch (err) {
    logDeduplicator.warn('withRedisCache: redis set failed', {
      cacheKey,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return value;
}

/**
 * Build a stable Redis cache key for HypeDexer pass-through routes.
 * Params are JSON.stringified with sorted keys to stay stable across call sites.
 */
export function buildHypedexerCacheKey(
  domain: string,
  method: string,
  params?: Record<string, unknown>,
): string {
  if (!params || Object.keys(params).length === 0) {
    return `hypedexer:${domain}:${method}`;
  }
  const sortedKeys = Object.keys(params).sort();
  const normalized: Record<string, unknown> = {};
  for (const k of sortedKeys) {
    const v = params[k];
    if (v === undefined || v === null || v === '') continue;
    normalized[k] = v;
  }
  return `hypedexer:${domain}:${method}:${JSON.stringify(normalized)}`;
}
