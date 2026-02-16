import Redis from 'ioredis';
import { logDeduplicator } from '../utils/logDeduplicator';

// Configuration Redis simple et propre
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  family: 0, // Dual stack IPv4/IPv6
  maxRetriesPerRequest: 3,
  enableReadyCheck: false,
  lazyConnect: false,
  connectTimeout: 30000,
  commandTimeout: 10000,
  enableOfflineQueue: true,
  keepAlive: 30000,
});

// ✅ Corriger le warning de MaxListeners sur l'instance principale
redis.setMaxListeners(20);

// ✅ Connexion Redis séparée pour les opérations normales (éviter le mode subscriber)
const redisNormal = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  family: 0,
  maxRetriesPerRequest: 3,
  enableReadyCheck: false,
  lazyConnect: false,
  connectTimeout: 30000,
  commandTimeout: 10000,
  enableOfflineQueue: true,
  keepAlive: 30000,
});

// ✅ Corriger le warning de MaxListeners
redisNormal.setMaxListeners(20);

// Configuration des listeners d'événements pour le diagnostic
redis.on('ready', () => {
  console.log('✅ Redis is ready');
  logDeduplicator.info('Redis is ready');
});

redis.on('connecting', () => {
  console.log('🔄 Connecting to Redis...');
  logDeduplicator.info('Connecting to Redis');
});

redis.on('connect', () => {
  console.log('✅ Redis connected successfully');
  logDeduplicator.info('Redis connected successfully');
});

redis.on('reconnecting', () => {
  console.log('🔄 Reconnecting to Redis...');
  logDeduplicator.info('Reconnecting to Redis');
});

redis.on('close', () => {
  console.log('❌ Redis connection closed');
  logDeduplicator.warn('Redis connection closed');
});

redis.on('error', (err) => {
  console.error('❌ Redis Error:', err);
  logDeduplicator.error('Redis Error', {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined
  });
});

// Test de connexion au démarrage
redis.ping().then(() => {
  console.log('✅ Redis PING successful');
  logDeduplicator.info('Redis PING successful');
}).catch((err) => {
  console.error('❌ Redis PING failed:', err);
  logDeduplicator.error('Redis PING failed', {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined
  });
});

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