import Redis from 'ioredis';
import { logDeduplicator } from '../utils/logDeduplicator';

// Shared Redis config optimized for production
const REDIS_CONFIG = {
  family: 0, // Dual stack IPv4/IPv6
  maxRetriesPerRequest: 1, // Fail fast; the circuit breaker below absorbs bursts instead of retries piling up
  enableReadyCheck: true, // Wait for Redis to be ready before accepting commands
  lazyConnect: false,
  connectTimeout: 10000, // 10s connect (was 30s - fail faster on real connection issues)
  commandTimeout: 3000, // 3s per command. Lower than before on purpose: a wedged half-open socket must fail fast, and the circuit breaker (below) now prevents the "Command timed out" cascade that made 5s unsafe before.
  enableOfflineQueue: false, // Fail-fast instead of silently queuing when disconnected
  keepAlive: 10000, // 10s keepalive (was 30s - detect dead connections faster)
  retryStrategy: (times: number) => {
    // Exponential backoff: 200ms, 400ms, 800ms... max 3s
    return Math.min(times * 200, 3000);
  },
};

// Subscriber instance (for pub/sub - cannot do normal commands while subscribed)
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', REDIS_CONFIG);
redis.setMaxListeners(50);

// Normal operations instance (GET, SET, pipeline, etc.)
const redisNormal = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', REDIS_CONFIG);
redisNormal.setMaxListeners(20);

// Configuration des listeners d'événements pour le diagnostic
redis.on('ready', () => {
  logDeduplicator.info('Redis is ready');
});

redis.on('connecting', () => {
  logDeduplicator.info('Connecting to Redis');
});

redis.on('connect', () => {
  logDeduplicator.info('Redis connected successfully');
});

redis.on('reconnecting', () => {
  logDeduplicator.info('Reconnecting to Redis');
});

redis.on('close', () => {
  logDeduplicator.warn('Redis connection closed');
});

redis.on('error', (err) => {
  logDeduplicator.error('Redis Error', {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined
  });
});

/**
 * With enableOfflineQueue: false, ioredis rejects commands until the TCP stream is writable.
 * Many services call subscribe() from constructors during module load; we must wait for "ready".
 */
function waitUntilRedisSubscriberReady(): Promise<void> {
  if (redis.status === 'ready') {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timeoutMs = REDIS_CONFIG.connectTimeout + 5000;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Redis subscriber did not become ready within ${timeoutMs}ms`));
    }, timeoutMs);

    const cleanup = (): void => {
      clearTimeout(timer);
      redis.removeListener('ready', onReady);
      redis.removeListener('end', onEnd);
    };

    const onReady = (): void => {
      cleanup();
      resolve();
    };

    const onEnd = (): void => {
      cleanup();
      reject(new Error('Redis subscriber connection ended before ready'));
    };

    redis.once('ready', onReady);
    redis.once('end', onEnd);
  });
}

// Smoke test after subscriber connection is usable (avoids race with module import / subscribe burst)
void (async (): Promise<void> => {
  try {
    await waitUntilRedisSubscriberReady();
    await redis.ping();
    logDeduplicator.info('Redis PING successful');
  } catch (err) {
    logDeduplicator.error('Redis PING failed', {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined
    });
  }
})();

/**
 * Circuit breaker for the command connection (`redisNormal`).
 *
 * A half-open TCP socket on Railway private networking makes every command hang
 * until `commandTimeout`, and the cache-aside path issues several commands per
 * request — so one wedged connection turns every HTTP request into a 15s+ stall
 * and the edge returns 502. The breaker trips after a few consecutive failures:
 * while open, the command wrappers short-circuit instantly (the app degrades to
 * "no cache", serving from source) and we force a reconnect to heal the dead
 * socket. It closes again on the first success once the cooldown has elapsed.
 */
const CB_FAILURE_THRESHOLD = 5;
const CB_COOLDOWN_MS = 15000;
let cbConsecutiveFailures = 0;
let cbOpenUntil = 0;
let cbReconnecting = false;

/** True while the command connection is considered usable. */
function redisAvailable(): boolean {
  return Date.now() >= cbOpenUntil;
}

function recordRedisSuccess(): void {
  cbConsecutiveFailures = 0;
  cbOpenUntil = 0;
}

function recordRedisFailure(): void {
  cbConsecutiveFailures += 1;
  if (cbConsecutiveFailures < CB_FAILURE_THRESHOLD || Date.now() < cbOpenUntil) {
    return;
  }
  cbOpenUntil = Date.now() + CB_COOLDOWN_MS;
  logDeduplicator.warn('Redis circuit opened — bypassing cache and forcing reconnect', {
    consecutiveFailures: cbConsecutiveFailures,
    cooldownMs: CB_COOLDOWN_MS,
  });
  forceRedisReconnect();
}

/**
 * Drop a possibly half-open command socket and reconnect. ioredis will not heal
 * a half-open socket on its own, so a manual disconnect + connect is required.
 * Best-effort and guarded against overlapping attempts.
 */
function forceRedisReconnect(): void {
  if (cbReconnecting) {
    return;
  }
  cbReconnecting = true;
  try {
    redisNormal.disconnect();
  } catch {
    // ignore — we reconnect below regardless
  }
  setTimeout(() => {
    redisNormal
      .connect()
      .catch((err: unknown) => {
        logDeduplicator.error('Redis reconnect failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        cbReconnecting = false;
      });
  }, 100);
}

// Service wrapper simple
export class RedisService {
  public static getInstance(): RedisService {
    return new RedisService();
  }

  /** Whether the command connection is currently usable (circuit closed). */
  public isHealthy(): boolean {
    return redisAvailable();
  }

  public async get(key: string): Promise<string | null> {
    if (!redisAvailable()) return null; // circuit open — treat as cache miss, no wait
    try {
      const value = await redisNormal.get(key);
      recordRedisSuccess();
      return value;
    } catch (error) {
      recordRedisFailure();
      logDeduplicator.error('Redis get error', {
        key,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      return null;
    }
  }

  /**
   * Atomically read and delete a key (GETDEL). For one-time credentials: two
   * concurrent callers can never both read the value. The key is not logged,
   * since callers use it for secrets.
   */
  public async getDel(key: string): Promise<string | null> {
    if (!redisAvailable()) return null;
    try {
      const value = await redisNormal.getdel(key);
      recordRedisSuccess();
      return value;
    } catch (error) {
      recordRedisFailure();
      logDeduplicator.error('Redis getdel error', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /** Read many keys in one round trip. Null entries for misses; null overall when Redis is unavailable. */
  public async mget(keys: string[]): Promise<(string | null)[] | null> {
    if (!keys.length) return [];
    if (!redisAvailable()) return null;
    try {
      const values = await redisNormal.mget(...keys);
      recordRedisSuccess();
      return values;
    } catch (error) {
      recordRedisFailure();
      logDeduplicator.error('Redis mget error', {
        count: keys.length,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /** Write many keys with one TTL in one round trip (best effort). */
  public async msetEx(entries: [string, string][], ttlSeconds: number): Promise<void> {
    if (!entries.length || !redisAvailable()) return;
    try {
      const pipeline = redisNormal.pipeline();
      for (const [k, v] of entries) pipeline.set(k, v, 'EX', ttlSeconds);
      await pipeline.exec();
      recordRedisSuccess();
    } catch (error) {
      recordRedisFailure();
      logDeduplicator.error('Redis msetEx error', {
        count: entries.length,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Claim many keys at once (SET NX EX, one pipeline round trip). Returns, per
   * key, true when this call created it (first claim) and false when it already
   * existed. Returns null when Redis is unavailable or any command failed, so callers
   * can fall back.
   */
  public async claimKeys(keys: string[], ttlSeconds: number): Promise<boolean[] | null> {
    if (!keys.length) return [];
    if (!redisAvailable()) return null;
    try {
      const pipeline = redisNormal.pipeline();
      for (const key of keys) pipeline.set(key, '1', 'EX', ttlSeconds, 'NX');
      const results = await pipeline.exec();
      // exec() resolves (does not reject) when the stream is down or a command times
      // out: the failure sits in each entry. That is not "key already exists".
      const failed = results?.find(([error]) => error)?.[0];
      if (failed) {
        recordRedisFailure();
        logDeduplicator.error('Redis claimKeys error', {
          count: keys.length,
          error: failed.message,
        });
        return null;
      }
      recordRedisSuccess();
      if (!results) return null;
      return results.map(([, reply]) => reply === 'OK');
    } catch (error) {
      recordRedisFailure();
      logDeduplicator.error('Redis claimKeys error', {
        count: keys.length,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  public async set(key: string, value: string, ttl?: number): Promise<void> {
    if (!redisAvailable()) return; // circuit open — skip write, no wait
    try {
      if (ttl) {
        await redisNormal.set(key, value, 'EX', ttl);
      } else {
        await redisNormal.set(key, value);
      }
      recordRedisSuccess();
    } catch (error) {
      recordRedisFailure();
      logDeduplicator.error('Redis set error', {
        key,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
    }
  }

  public async delete(key: string): Promise<void> {
    if (!redisAvailable()) return; // circuit open — skip, no wait
    try {
      await redisNormal.del(key);
      recordRedisSuccess();
    } catch (error) {
      recordRedisFailure();
      logDeduplicator.error('Redis delete error', {
        key,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
    }
  }

  public async scan(pattern: string): Promise<string[]> {
    if (!redisAvailable()) return []; // circuit open — no keys, no wait
    try {
      const keys: string[] = [];
      let cursor = '0';
      do {
        const [nextCursor, batch] = await redisNormal.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = nextCursor;
        keys.push(...batch);
      } while (cursor !== '0');
      recordRedisSuccess();
      return keys;
    } catch (error) {
      recordRedisFailure();
      logDeduplicator.error('Redis scan error', {
        pattern,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      return [];
    }
  }

  /** @deprecated Use scan() instead — KEYS blocks Redis in production */
  public async keys(pattern: string): Promise<string[]> {
    return this.scan(pattern);
  }

  public async publish(channel: string, message: string): Promise<void> {
    if (!redisAvailable()) return; // circuit open — skip publish, no wait
    try {
      await redisNormal.publish(channel, message);
      recordRedisSuccess();
    } catch (error) {
      recordRedisFailure();
      logDeduplicator.error('Redis publish error', {
        channel,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
    }
  }

  public async subscribe(channel: string, callback: (message: string) => void): Promise<void> {
    try {
      await waitUntilRedisSubscriberReady();
      await redis.subscribe(channel);
      redis.on('message', (receivedChannel, message) => {
        if (receivedChannel === channel) {
          callback(message);
        }
      });
    } catch (error) {
      logDeduplicator.error('Redis subscribe error', {
        channel,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
    }
  }

  public async unsubscribe(channel: string): Promise<void> {
    try {
      await waitUntilRedisSubscriberReady();
      await redis.unsubscribe(channel);
    } catch (error) {
      logDeduplicator.error('Redis unsubscribe error', {
        channel,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
    }
  }

  public async flushAll(): Promise<void> {
    try {
      await redisNormal.flushall();
    } catch (error) {
      logDeduplicator.error('Redis flushall error', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
    }
  }

  public async disconnect(): Promise<void> {
    try {
      redis.removeAllListeners();
      redisNormal.removeAllListeners();
      await redis.quit();
      await redisNormal.quit();
    } catch (error) {
      logDeduplicator.error('Redis disconnect error', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
    }
  }

  public multi() {
    return redisNormal.multi();
  }
  public getClient(): Redis {
    return redisNormal;
  }
}

export const redisService = RedisService.getInstance(); 