import {
  ActiveUser,
  ActiveUsersApiResponse,
  ActiveUsersQueryParams,
} from '../../../../types/activeusers.types';
import { CircuitBreakerService } from '../../../../core/circuit.breaker.service';
import { RateLimiterService } from '../../../../core/hyperLiquid.ratelimiter.service';
import { redisService } from '../../../../core/redis.service';
import { withDistributedLock } from '../../../../utils/distributedLock';
import { logDeduplicator } from '../../../../utils/logDeduplicator';
import { coerceHypedexerListApiResponse } from '../../../../utils/hypedexer-api-response.util';
import { HYPEDEXER_API_URL, hypedexerJsonHeaders } from '../shared/hypedexer-api.config';
import { HypeDexerBaseClient } from '../shared/hypedexer-base.client';

const CACHE_KEY_PREFIX = 'activeusers';
const UPDATE_CHANNEL = 'activeusers:updated';
const UPDATE_INTERVAL = 120000;
const CACHE_TTL = 55;
const HOURS_TO_CACHE = [1, 4, 12, 24];

/**
 * Client for HypeDexer Active Users API
 * GET /users/active
 * Circuit breaker / rate limiter IDs: `activeusers`.
 */
export class HLIndexerActiveUsersClient extends HypeDexerBaseClient {
  private static instance: HLIndexerActiveUsersClient;
  private static readonly REQUEST_WEIGHT = 10;
  private static readonly MAX_WEIGHT_PER_MINUTE = 1000;

  private circuitBreaker: CircuitBreakerService;
  private rateLimiter: RateLimiterService;
  private pollingTimeout: NodeJS.Timeout | null = null;
  private pollingStopped = true;
  private consecutiveFailures = 0;

  private constructor() {
    super(HYPEDEXER_API_URL, hypedexerJsonHeaders);

    this.circuitBreaker = CircuitBreakerService.getInstance('activeusers');
    this.rateLimiter = RateLimiterService.getInstance('activeusers', {
      maxWeightPerMinute: HLIndexerActiveUsersClient.MAX_WEIGHT_PER_MINUTE,
      requestWeight: HLIndexerActiveUsersClient.REQUEST_WEIGHT,
    });
  }

  public static getInstance(): HLIndexerActiveUsersClient {
    if (!HLIndexerActiveUsersClient.instance) {
      HLIndexerActiveUsersClient.instance = new HLIndexerActiveUsersClient();
    }
    return HLIndexerActiveUsersClient.instance;
  }

  public startPolling(): void {
    if (!this.pollingStopped) {
      logDeduplicator.warn('Active users polling already started');
      return;
    }
    this.pollingStopped = false;
    logDeduplicator.info('Starting active users polling');
    void this.tickActiveUsersPolling(true);
  }

  public stopPolling(): void {
    this.pollingStopped = true;
    if (this.pollingTimeout) {
      clearTimeout(this.pollingTimeout);
      this.pollingTimeout = null;
      logDeduplicator.info('Active users polling stopped');
    }
  }

  /**
   * Recursive tick with adaptive backoff on consecutive failures.
   * Effective delay = UPDATE_INTERVAL * min(2^failures, 10).
   */
  private async tickActiveUsersPolling(isInitial: boolean): Promise<void> {
    if (this.pollingStopped) return;
    if (!isInitial) {
      // schedule already used to enter this tick
    }
    try {
      await this.updateActiveUsersData();
      this.consecutiveFailures = 0;
    } catch (err) {
      this.consecutiveFailures += 1;
      logDeduplicator.error('Error in active users polling:', {
        error: err instanceof Error ? err.message : String(err),
        consecutiveFailures: this.consecutiveFailures,
      });
    }
    if (this.pollingStopped) return;
    const multiplier = Math.min(Math.pow(2, this.consecutiveFailures), 10);
    const delay = UPDATE_INTERVAL * multiplier;
    this.pollingTimeout = setTimeout(() => {
      void this.tickActiveUsersPolling(false);
    }, delay);
  }

  private async updateActiveUsersData(): Promise<void> {
    let allRejected = false;
    const executed = await withDistributedLock('poll:activeusers', 90, async () => {
      const results = await Promise.allSettled(
        HOURS_TO_CACHE.map(async (hours) => {
          const response = await this.circuitBreaker.execute(() => this.fetchRaw({ hours, limit: 100 }));
          const cacheKey = `${CACHE_KEY_PREFIX}:${hours}h`;
          await redisService.set(cacheKey, JSON.stringify(response), CACHE_TTL);
          await redisService.publish(
            UPDATE_CHANNEL,
            JSON.stringify({ type: 'DATA_UPDATED', hours, timestamp: Date.now() })
          );
          return hours;
        })
      );
      results.forEach((result, idx) => {
        if (result.status === 'rejected') {
          const hours = HOURS_TO_CACHE[idx];
          logDeduplicator.error(`Failed to fetch active users for hours=${hours}`, {
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          });
        }
      });
      allRejected = results.every((r) => r.status === 'rejected');
    });
    if (!executed) {
      logDeduplicator.info('Active users refresh skipped - another instance holds the lock');
      return;
    }
    if (allRejected) {
      throw new Error('All active users fetches failed');
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
    const raw = await this.getUnwrapped<unknown>(`/users/active${queryString}`);
    return coerceHypedexerListApiResponse<ActiveUser>(raw) as ActiveUsersApiResponse;
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
      try {
        await this.updateActiveUsersData();
      } catch (err) {
        logDeduplicator.warn('On-demand active users refresh failed; falling back to passthrough', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
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
