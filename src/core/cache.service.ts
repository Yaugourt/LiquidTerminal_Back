import { redisService } from './redis.service';
import { logDeduplicator } from '../utils/logDeduplicator';
import { CACHE_TTL } from '../constants/cache.constants';

/**
 * Service de gestion du cache
 * Encapsule la logique de cache utilisée dans les services
 */
export class CacheService {
  /**
   * Récupère une donnée du cache ou l'obtient via une fonction de récupération
   * @param key Clé de cache
   * @param fetchFn Fonction pour récupérer la donnée si elle n'est pas en cache
   * @param ttl Durée de vie du cache en secondes
   * @returns La donnée du cache ou celle récupérée par fetchFn
   */
  async getOrSet<T>(
    key: string, 
    fetchFn: () => Promise<T>, 
    ttl: number = CACHE_TTL.MEDIUM
  ): Promise<T> {
    try {
      const cachedData = await redisService.get(key);
      if (cachedData) {
        return JSON.parse(cachedData);
      }

      // Try to acquire lock to prevent cache stampede
      const lockKey = `lock:${key}`;
      const redis = redisService.getClient();
      const acquired = await redis.set(lockKey, '1', 'EX', 30, 'NX');

      if (acquired) {
        try {
          // Double-check cache (another request may have populated it)
          const freshCache = await redisService.get(key);
          if (freshCache) {
            await redisService.delete(lockKey);
            return JSON.parse(freshCache);
          }

          const data = await fetchFn();
          await redisService.set(key, JSON.stringify(data), ttl);
          await redisService.delete(lockKey);
          return data;
        } catch (error) {
          await redisService.delete(lockKey);
          throw error;
        }
      }

      // Lock not acquired — wait for the lock holder to populate cache
      for (let i = 0; i < 3; i++) {
        await new Promise(resolve => setTimeout(resolve, 200));
        const retryCache = await redisService.get(key);
        if (retryCache) {
          return JSON.parse(retryCache);
        }
      }

      // Lock holder may have failed, fetch directly
      return await fetchFn();
    } catch (error) {
      logDeduplicator.warn('Cache error, falling back to direct fetch', { 
        key,
        errorMessage: error instanceof Error ? error.message : 'Unknown error'
      });
      return fetchFn();
    }
  }
  
  /**
   * Invalide une clé de cache
   * @param key Clé de cache à invalider
   */
  async invalidate(key: string): Promise<void> {
    try {
      await redisService.delete(key);
      logDeduplicator.info('Cache invalidated', { key });
    } catch (error) {
      logDeduplicator.error('Error invalidating cache:', { 
        error, 
        key,
        errorMessage: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }
  
  /**
   * Invalide toutes les clés de cache correspondant à un pattern
   * @param pattern Pattern des clés à invalider
   */
  async invalidateByPattern(pattern: string): Promise<void> {
    try {
      const keys = await redisService.scan(pattern);
      if (keys && keys.length > 0) {
        await Promise.all(keys.map(key => redisService.delete(key)));
        logDeduplicator.info('Cache invalidated by pattern', { 
          pattern, 
          count: keys.length 
        });
      }
    } catch (error) {
      logDeduplicator.error('Error invalidating cache by pattern:', { 
        error, 
        pattern,
        errorMessage: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }
}

// Instance singleton du service de cache
export const cacheService = new CacheService(); 