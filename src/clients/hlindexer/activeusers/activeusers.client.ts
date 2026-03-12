import { BaseApiService } from '../../../core/base.api.service';
import {
  ActiveUsersApiResponse,
  ActiveUsersQueryParams,
  ActiveUsersError
} from '../../../types/activeusers.types';
import { CircuitBreakerService } from '../../../core/circuit.breaker.service';
import { RateLimiterService } from '../../../core/hyperLiquid.ratelimiter.service';
import { redisService } from '../../../core/redis.service';
import { withDistributedLock } from '../../../utils/distributedLock';
import { logDeduplicator } from '../../../utils/logDeduplicator';

const CACHE_KEY_PREFIX = 'activeusers';
const UPDATE_CHANNEL = 'activeusers:updated';
const UPDATE_INTERVAL = 60000;
const CACHE_TTL = 55;
const HOURS_TO_CACHE = [1, 4, 12, 24];

/**
 * Client for HypeDexer Active Users API
 * GET /users/active
 * Follows the standard client architecture with CircuitBreaker and RateLimiter
 */
export class HLIndexerActiveUsersClient extends BaseApiService {
  private static instance: HLIndexerActiveUsersClient;
  private static readonly API_URL = process.env.HL_INDEXER_API_URL || 'https://api-eu.hypedexer.com';
  private static readonly API_KEY = process.env.HL_INDEXER_API_KEY || '';
  private static readonly REQUEST_WEIGHT = 10;
  private static readonly MAX_WEIGHT_PER_MINUTE = 1000;

  private circuitBreaker: CircuitBreakerService;
  private rateLimiter: RateLimiterService;
  private pollingInterval: NodeJS.Timeout | null = null;

  private constructor() {
    super(HLIndexerActiveUsersClient.API_URL, {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-API-Key': HLIndexerActiveUsersClient.API_KEY
    });

    this.circuitBreaker = CircuitBreakerService.getInstance('activeusers');
    this.rateLimiter = RateLimiterService.getInstance('activeusers', {
      maxWeightPerMinute: HLIndexerActiveUsersClient.MAX_WEIGHT_PER_MINUTE,
      requestWeight: HLIndexerActiveUsersClient.REQUEST_WEIGHT
    });
  }

  public static getInstance(): HLIndexerActiveUsersClient {
    if (!HLIndexerActiveUsersClient.instance) {
      HLIndexerActiveUsersClient.instance = new HLIndexerActiveUsersClient();
    }
    return HLIndexerActiveUsersClient.instance;
  }

  public startPolling(): void {
    if (this.pollingInterval) {
      logDeduplicator.warn('Active users polling already started');
      return;
    }
    logDeduplicator.info('Starting active users polling');
    this.updateActiveUsersData().catch(err =>
      logDeduplicator.error('Error in initial active users update:', { error: err })
    );
    this.pollingInterval = setInterval(() => {
      this.updateActiveUsersData().catch(err =>
        logDeduplicator.error('Error in active users polling:', { error: err })
      );
    }, UPDATE_INTERVAL);
  }

  public stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
      logDeduplicator.info('Active users polling stopped');
    }
  }

  private async updateActiveUsersData(): Promise<void> {
    const executed = await withDistributedLock('poll:activeusers', 90, async () => {
      for (const hours of HOURS_TO_CACHE) {
        try {
          const response = await this.circuitBreaker.execute(() =>
            this.fetchRaw({ hours, limit: 100 })
          );
          const cacheKey = `${CACHE_KEY_PREFIX}:${hours}h`;
          await redisService.set(cacheKey, JSON.stringify(response), CACHE_TTL);
          await redisService.publish(UPDATE_CHANNEL, JSON.stringify({ type: 'DATA_UPDATED', hours, timestamp: Date.now() }));
          await new Promise(r => setTimeout(r, 200));
        } catch (error) {
          logDeduplicator.error(`Failed to fetch active users for hours=${hours}`, {
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    });
    if (!executed) {
      logDeduplicator.info('Active users refresh skipped - another instance holds the lock');
    }
  }

  private buildQueryString(params: ActiveUsersQueryParams): string {
    const queryParams = new URLSearchParams();
    if (params.hours !== undefined) queryParams.append('hours', params.hours.toString());
    if (params.limit !== undefined) queryParams.append('limit', params.limit.toString());
    const qs = queryParams.toString();
    return qs ? `?${qs}` : '';
  }

  private async fetchRaw(params: ActiveUsersQueryParams): Promise<ActiveUsersApiResponse> {
    const queryString = this.buildQueryString({ hours: params.hours || 24, limit: params.limit || 100 });
    return this.get<ActiveUsersApiResponse>(`/users/active${queryString}`);
  }

  /**
   * Get active users for the specified time window
   * Reads from Redis cache first for cached hours (1,4,12,24) and limit<=100.
   * On miss: triggers update, re-reads cache. For non-cached params: passthrough to API.
   */
  public async getActiveUsers(params: ActiveUsersQueryParams = {}): Promise<ActiveUsersApiResponse> {
    const hours = params.hours ?? 24;
    const limit = params.limit ?? 100;
    const cacheKey = `${CACHE_KEY_PREFIX}:${hours}h`;
    const isCachedHours = HOURS_TO_CACHE.includes(hours);

    if (isCachedHours && limit <= 100) {
      const cached = await redisService.get(cacheKey);
      if (cached) {
        const parsed: ActiveUsersApiResponse = JSON.parse(cached);
        if (limit < 100) {
          return { ...parsed, data: parsed.data.slice(0, limit) };
        }
        return parsed;
      }
      await this.updateActiveUsersData();
      const reRead = await redisService.get(cacheKey);
      if (reRead) {
        const parsed: ActiveUsersApiResponse = JSON.parse(reRead);
        if (limit < 100) {
          return { ...parsed, data: parsed.data.slice(0, limit) };
        }
        return parsed;
      }
    }

    return this.circuitBreaker.execute(() => this.fetchRaw({ hours, limit }));
  }

  public checkRateLimit(ip: string): boolean {
    return this.rateLimiter.checkRateLimit(ip);
  }

  public static getRequestWeight(): number {
    return HLIndexerActiveUsersClient.REQUEST_WEIGHT;
  }
}
