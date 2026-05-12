import { Builder, BuildersApiResponse } from '../../../../types/builders.types';
import { CircuitBreakerService } from '../../../../core/circuit.breaker.service';
import { RateLimiterService } from '../../../../core/hyperLiquid.ratelimiter.service';
import { redisService } from '../../../../core/redis.service';
import { withDistributedLock } from '../../../../utils/distributedLock';
import { logDeduplicator } from '../../../../utils/logDeduplicator';
import { coerceHypedexerListApiResponse } from '../../../../utils/hypedexer-api-response.util';
import { HYPEDEXER_API_URL, hypedexerJsonHeaders } from '../shared/hypedexer-api.config';
import { HypeDexerBaseClient } from '../shared/hypedexer-base.client';

const CACHE_KEY = 'builders:all';
const UPDATE_CHANNEL = 'builders:updated';
const UPDATE_INTERVAL = 300000; // 5 minutes
const CACHE_TTL = 290; // Just under 5 minutes

/**
 * Redis-backed poller for GET /builders/list (full list, cached).
 * Circuit breaker / rate limiter IDs: `builders`.
 * Pass-through builders analytics live in `builders-indexer.client.ts`.
 */
export class HLIndexerBuildersClient extends HypeDexerBaseClient {
  private static instance: HLIndexerBuildersClient;
  private static readonly REQUEST_WEIGHT = 12;
  private static readonly MAX_WEIGHT_PER_MINUTE = 1000;

  private circuitBreaker: CircuitBreakerService;
  private rateLimiter: RateLimiterService;
  private pollingTimeout: NodeJS.Timeout | null = null;
  private pollingStopped = true;
  private consecutiveFailures = 0;

  private constructor() {
    super(HYPEDEXER_API_URL, hypedexerJsonHeaders);

    this.circuitBreaker = CircuitBreakerService.getInstance('builders');
    this.rateLimiter = RateLimiterService.getInstance('builders', {
      maxWeightPerMinute: HLIndexerBuildersClient.MAX_WEIGHT_PER_MINUTE,
      requestWeight: HLIndexerBuildersClient.REQUEST_WEIGHT,
    });
  }

  public static getInstance(): HLIndexerBuildersClient {
    if (!HLIndexerBuildersClient.instance) {
      HLIndexerBuildersClient.instance = new HLIndexerBuildersClient();
    }
    return HLIndexerBuildersClient.instance;
  }

  public startPolling(): void {
    if (!this.pollingStopped) {
      logDeduplicator.warn('Builders polling already started');
      return;
    }
    this.pollingStopped = false;
    logDeduplicator.info('Starting Builders polling');
    void this.tickBuildersPolling();
  }

  public stopPolling(): void {
    this.pollingStopped = true;
    if (this.pollingTimeout) {
      clearTimeout(this.pollingTimeout);
      this.pollingTimeout = null;
      logDeduplicator.info('Builders polling stopped');
    }
  }

  private async tickBuildersPolling(): Promise<void> {
    if (this.pollingStopped) return;
    try {
      await this.updateBuildersData();
      this.consecutiveFailures = 0;
    } catch (err) {
      this.consecutiveFailures += 1;
      logDeduplicator.error('Error in Builders polling:', {
        error: err instanceof Error ? err.message : String(err),
        consecutiveFailures: this.consecutiveFailures,
      });
    }
    if (this.pollingStopped) return;
    const multiplier = Math.min(Math.pow(2, this.consecutiveFailures), 10);
    const delay = UPDATE_INTERVAL * multiplier;
    this.pollingTimeout = setTimeout(() => {
      void this.tickBuildersPolling();
    }, delay);
  }

  private async updateBuildersData(): Promise<void> {
    let fetchError: unknown = null;
    const executed = await withDistributedLock('poll:builders', 90, async () => {
      try {
        const response = await this.fetchAllBuilders();
        await redisService.set(CACHE_KEY, JSON.stringify(response), CACHE_TTL);
        await redisService.publish(UPDATE_CHANNEL, JSON.stringify({ type: 'DATA_UPDATED', timestamp: Date.now() }));
      } catch (error) {
        fetchError = error;
        logDeduplicator.error('Failed to fetch builders', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
    if (!executed) {
      logDeduplicator.info('Builders refresh skipped - another instance holds the lock');
      return;
    }
    if (fetchError) {
      throw fetchError instanceof Error ? fetchError : new Error(String(fetchError));
    }
  }

  private async fetchAllBuilders(): Promise<BuildersApiResponse> {
    return this.circuitBreaker.execute(async () => {
      const raw = await this.getUnwrapped<unknown>(
        '/builders/list?limit=1000&offset=0&sort=volume_usd&order=DESC'
      );
      return coerceHypedexerListApiResponse<Builder>(raw) as BuildersApiResponse;
    });
  }

  /**
   * Get all builders from cache. Falls back to direct API call if cache empty.
   */
  public async getAllBuilders(): Promise<BuildersApiResponse> {
    const cached = await redisService.get(CACHE_KEY);
    if (cached) {
      return JSON.parse(cached);
    }

    try {
      await this.updateBuildersData();
    } catch (err) {
      logDeduplicator.warn('On-demand builders refresh failed; falling back to direct fetch', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const reRead = await redisService.get(CACHE_KEY);
    if (reRead) {
      return JSON.parse(reRead);
    }

    return this.fetchAllBuilders();
  }

  public checkRateLimit(ip: string): boolean {
    return this.rateLimiter.checkRateLimit(ip);
  }

  public static getRequestWeight(): number {
    return HLIndexerBuildersClient.REQUEST_WEIGHT;
  }
}
