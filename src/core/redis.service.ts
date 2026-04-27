import Redis from 'ioredis';
import { logDeduplicator } from '../utils/logDeduplicator';

// Shared Redis config optimized for production
const REDIS_CONFIG = {
  family: 0, // Dual stack IPv4/IPv6
  maxRetriesPerRequest: 3,
  enableReadyCheck: true, // Wait for Redis to be ready before accepting commands
  lazyConnect: false,
  connectTimeout: 10000, // 10s connect (was 30s - fail faster on real connection issues)
  commandTimeout: 5000, // 5s per command (was 10s - avoid long hangs under load)
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

// Service wrapper simple
export class RedisService {
  public static getInstance(): RedisService {
    return new RedisService();
  }

  public async get(key: string): Promise<string | null> {
    try {
      return await redisNormal.get(key);
    } catch (error) {
      logDeduplicator.error('Redis get error', {
        key,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      return null;
    }
  }

  public async set(key: string, value: string, ttl?: number): Promise<void> {
    try {
      if (ttl) {
        await redisNormal.set(key, value, 'EX', ttl);
      } else {
        await redisNormal.set(key, value);
      }
    } catch (error) {
      logDeduplicator.error('Redis set error', {
        key,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
    }
  }

  public async delete(key: string): Promise<void> {
    try {
      await redisNormal.del(key);
    } catch (error) {
      logDeduplicator.error('Redis delete error', {
        key,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
    }
  }

  public async scan(pattern: string): Promise<string[]> {
    try {
      const keys: string[] = [];
      let cursor = '0';
      do {
        const [nextCursor, batch] = await redisNormal.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = nextCursor;
        keys.push(...batch);
      } while (cursor !== '0');
      return keys;
    } catch (error) {
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
    try {
      await redisNormal.publish(channel, message);
    } catch (error) {
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