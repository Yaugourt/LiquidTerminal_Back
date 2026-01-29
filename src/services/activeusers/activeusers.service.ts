import { HLIndexerActiveUsersClient } from '../../clients/hlindexer/activeusers/activeusers.client';
import {
  ActiveUsersResponse,
  ActiveUsersQueryParams,
  ActiveUsersError,
  ActiveUser
} from '../../types/activeusers.types';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { redisService } from '../../core/redis.service';

/**
 * Service for Active Users business logic
 * Follows the Singleton pattern as per architecture
 * Background polling every 60 seconds
 */
export class ActiveUsersService {
  private static instance: ActiveUsersService;
  private readonly client: HLIndexerActiveUsersClient;

  // Cache configuration
  private static readonly CACHE_TTL = 55; // Just under 60s polling interval
  private static readonly CACHE_KEY_PREFIX = 'activeusers';

  // Background refresh configuration - 60 seconds
  private static readonly REFRESH_INTERVAL_MS = 60_000;
  private refreshTimer: NodeJS.Timeout | null = null;
  private isRefreshing = false;

  // Pre-fetch configurations (hours values to cache)
  private static readonly HOURS_TO_CACHE = [1, 4, 12, 24];

  private constructor() {
    this.client = HLIndexerActiveUsersClient.getInstance();
  }

  public static getInstance(): ActiveUsersService {
    if (!ActiveUsersService.instance) {
      ActiveUsersService.instance = new ActiveUsersService();
    }
    return ActiveUsersService.instance;
  }

  /**
   * Get cache key for a specific hours value
   */
  private getCacheKey(hours: number): string {
    return `${ActiveUsersService.CACHE_KEY_PREFIX}:${hours}h`;
  }

  /**
   * Start background polling to refresh cache automatically
   * Should be called once at server startup
   */
  public startPolling(): void {
    if (this.refreshTimer) {
      logDeduplicator.warn('Active Users polling already started');
      return;
    }

    logDeduplicator.info('Starting Active Users background polling', {
      intervalMs: ActiveUsersService.REFRESH_INTERVAL_MS
    });

    // Initial refresh after 5 seconds (let server stabilize)
    setTimeout(() => {
      this.refreshAllData();
    }, 5000);

    // Then refresh every REFRESH_INTERVAL_MS (60 seconds)
    this.refreshTimer = setInterval(() => {
      this.refreshAllData();
    }, ActiveUsersService.REFRESH_INTERVAL_MS);
  }

  /**
   * Stop background polling
   */
  public stopPolling(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
      logDeduplicator.info('Active Users background polling stopped');
    }
  }

  /**
   * Refresh all active users data in background
   * Fetches multiple hours configurations and caches them
   * Called by polling timer - never throws, just logs errors
   */
  private async refreshAllData(): Promise<void> {
    if (this.isRefreshing) {
      logDeduplicator.info('Skipping Active Users refresh - already in progress');
      return;
    }

    this.isRefreshing = true;
    const startTime = Date.now();

    try {
      logDeduplicator.info('Background refresh: fetching active users data');

      // Fetch all hours configurations sequentially to avoid rate limiting
      for (const hours of ActiveUsersService.HOURS_TO_CACHE) {
        try {
          const response = await this.client.getActiveUsers({
            hours,
            limit: 100
          });

          const cacheKey = this.getCacheKey(hours);
          const cacheData: ActiveUsersResponse = {
            success: true,
            data: response.data,
            metadata: {
              hours,
              limit: 100,
              totalCount: response.total_count || response.data.length,
              executionTimeMs: response.execution_time_ms,
              cachedAt: new Date().toISOString()
            }
          };

          await redisService.set(cacheKey, JSON.stringify(cacheData), ActiveUsersService.CACHE_TTL);

          logDeduplicator.info(`Active Users cached for hours=${hours}`, {
            count: response.data?.length || 0
          });

          // Small delay between requests to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 200));
        } catch (error) {
          logDeduplicator.error(`Failed to fetch active users for hours=${hours}`, {
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      const executionTimeMs = Date.now() - startTime;
      logDeduplicator.info('Active Users background refresh completed', {
        executionTimeMs,
        hoursConfigs: ActiveUsersService.HOURS_TO_CACHE.length
      });
    } catch (error) {
      logDeduplicator.error('Active Users background refresh failed', {
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      this.isRefreshing = false;
    }
  }

  /**
   * Get active users with optional filters
   * Returns cached data if available, otherwise fetches from API
   */
  public async getActiveUsers(params: ActiveUsersQueryParams = {}): Promise<ActiveUsersResponse> {
    const hours = params.hours || 24;
    const limit = params.limit || 100;
    const cacheKey = this.getCacheKey(hours);

    try {
      // Check cache first (only if limit is 100, since we cache full data)
      if (limit === 100) {
        const cached = await redisService.get(cacheKey);
        if (cached) {
          logDeduplicator.info('ActiveUsersService.getActiveUsers cache hit', { hours, limit });
          return JSON.parse(cached);
        }
      } else {
        // For custom limit, try to use cached data and slice
        const cached = await redisService.get(cacheKey);
        if (cached) {
          const cachedResponse: ActiveUsersResponse = JSON.parse(cached);
          logDeduplicator.info('ActiveUsersService.getActiveUsers cache hit (with limit)', { hours, limit });
          return {
            ...cachedResponse,
            data: cachedResponse.data.slice(0, limit),
            metadata: {
              ...cachedResponse.metadata,
              limit
            }
          };
        }
      }
    } catch (cacheError) {
      logDeduplicator.warn('Redis cache error, proceeding without cache', { error: String(cacheError) });
    }

    // Cache miss - fetch from API
    logDeduplicator.info('ActiveUsersService.getActiveUsers cache miss, fetching from API', { hours, limit });

    try {
      const response = await this.client.getActiveUsers({ hours, limit });

      const result: ActiveUsersResponse = {
        success: true,
        data: response.data,
        metadata: {
          hours,
          limit,
          totalCount: response.total_count || response.data.length,
          executionTimeMs: response.execution_time_ms,
          cachedAt: new Date().toISOString()
        }
      };

      // Cache the response if limit is 100 (full data)
      if (limit === 100) {
        try {
          await redisService.set(cacheKey, JSON.stringify(result), ActiveUsersService.CACHE_TTL);
        } catch (cacheError) {
          logDeduplicator.warn('Failed to cache active users', { error: String(cacheError) });
        }
      }

      return result;
    } catch (error) {
      logDeduplicator.error('ActiveUsersService.getActiveUsers failed', {
        error: error instanceof Error ? error.message : String(error),
        params
      });

      // Return 429 for rate limit errors
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('429') || errorMessage.includes('rate limit')) {
        throw new ActiveUsersError(
          'API rate limit exceeded. Please try again in a few seconds.',
          429,
          'RATE_LIMIT_EXCEEDED'
        );
      }

      throw new ActiveUsersError(
        error instanceof Error ? error.message : 'Failed to fetch active users',
        500,
        'ACTIVE_USERS_SERVICE_ERROR'
      );
    }
  }

  /**
   * Check rate limit for an IP
   */
  public checkRateLimit(ip: string): boolean {
    return this.client.checkRateLimit(ip);
  }
}
