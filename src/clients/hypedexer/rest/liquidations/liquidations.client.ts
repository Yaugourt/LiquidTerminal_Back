import { redisService } from '../../../../core/redis.service';
import { Liquidation, LiquidationResponse, LiquidationQueryParams } from '../../../../types/liquidations.types';
import { AnalyticsLiquidationStatsResponse, AnalyticsLiquidationStatsParams } from '../../../../types/analytics-liquidations.types';
import { CircuitBreakerService } from '../../../../core/circuit.breaker.service';
import { RateLimiterService } from '../../../../core/hyperLiquid.ratelimiter.service';
import { logDeduplicator } from '../../../../utils/logDeduplicator';
import { coerceHypedexerListApiResponse } from '../../../../utils/hypedexer-api-response.util';
import { HYPEDEXER_API_URL, hypedexerJsonHeaders } from '../shared/hypedexer-api.config';
import { HypeDexerBaseClient } from '../shared/hypedexer-base.client';

/** Cache config for getRecentLiquidations (default params only) */
const CACHE_KEY = 'liquidations:recent';
const CACHE_TTL = 15;
const UPDATE_INTERVAL = 15000; // 15s
const UPDATE_CHANNEL = 'liquidations:recent:updated';

/**
 * Client for HypeDexer Liquidations API (Redis polling + on-demand).
 * Circuit breaker / rate limiter IDs: `liquidations`.
 */
export class HLIndexerLiquidationsClient extends HypeDexerBaseClient {
  private static instance: HLIndexerLiquidationsClient;
  private static readonly REQUEST_WEIGHT = 10;
  private static readonly MAX_WEIGHT_PER_MINUTE = 1000;

  private circuitBreaker: CircuitBreakerService;
  private rateLimiter: RateLimiterService;
  private pollingInterval: NodeJS.Timeout | null = null;

  private constructor() {
    super(HYPEDEXER_API_URL, hypedexerJsonHeaders);

    this.circuitBreaker = CircuitBreakerService.getInstance('liquidations');
    this.rateLimiter = RateLimiterService.getInstance('liquidations', {
      maxWeightPerMinute: HLIndexerLiquidationsClient.MAX_WEIGHT_PER_MINUTE,
      requestWeight: HLIndexerLiquidationsClient.REQUEST_WEIGHT,
    });
  }

  public static getInstance(): HLIndexerLiquidationsClient {
    if (!HLIndexerLiquidationsClient.instance) {
      HLIndexerLiquidationsClient.instance = new HLIndexerLiquidationsClient();
    }
    return HLIndexerLiquidationsClient.instance;
  }

  private liquidationsFromUnwrapped(raw: unknown): LiquidationResponse {
    const r = coerceHypedexerListApiResponse<Liquidation>(raw);
    return {
      ...r,
      has_more: r.has_more ?? false,
    };
  }

  /**
   * Build query string from params object
   * Converts hours to start_time/end_time for HypeDexer API
   */
  private buildQueryString(params: LiquidationQueryParams): string {
    const queryParams = new URLSearchParams();

    if (params.coin) queryParams.append('coin', params.coin);
    if (params.user) queryParams.append('user', params.user);

    // If hours is provided, calculate start_time
    if (params.hours !== undefined) {
      const now = new Date();
      const startTime = new Date(now.getTime() - params.hours * 60 * 60 * 1000);
      queryParams.append('start_time', startTime.toISOString());
    } else {
      if (params.start_time) queryParams.append('start_time', params.start_time);
      if (params.end_time) queryParams.append('end_time', params.end_time);
    }

    if (params.amount_dollars !== undefined) queryParams.append('amount_dollars', params.amount_dollars.toString());
    if (params.limit !== undefined) queryParams.append('limit', params.limit.toString());
    if (params.cursor) queryParams.append('cursor', params.cursor);
    if (params.order) queryParams.append('order', params.order.toUpperCase());

    const queryString = queryParams.toString();
    return queryString ? `?${queryString}` : '';
  }

  /**
   * Get historical liquidations with filters and keyset pagination
   */
  public async getLiquidations(params: LiquidationQueryParams = {}): Promise<LiquidationResponse> {
    return this.circuitBreaker.execute(async () => {
      const queryString = this.buildQueryString(params);
      const endpoint = `/liquidations/${queryString}`;

      logDeduplicator.info('Fetching liquidations from HypeDexer', {
        endpoint,
        params,
      });

      const response = this.liquidationsFromUnwrapped(await this.getUnwrapped<unknown>(endpoint));

      logDeduplicator.info('Successfully fetched liquidations', {
        count: response.data?.length || 0,
        hasMore: response.has_more,
        executionTime: response.execution_time_ms,
      });

      return response;
    });
  }

  /**
   * Check if params match the cached default (no filters, limit <= 100)
   */
  private isDefaultParams(params: LiquidationQueryParams): boolean {
    const limit = params.limit ?? 100;
    return (
      !params.user &&
      !params.coin &&
      limit <= 100 &&
      params.hours === undefined &&
      params.start_time === undefined &&
      params.end_time === undefined &&
      params.cursor === undefined &&
      params.amount_dollars === undefined
    );
  }

  /**
   * Internal fetch: call API for recent liquidations (no cache). Used by polling.
   * NOTE: returns the raw envelope so Redis stores the full response shape.
   */
  private async fetchRecentLiquidationsFromApi(params: LiquidationQueryParams): Promise<LiquidationResponse> {
    const queryString = this.buildQueryString(params);
    const endpoint = `/liquidations/recent${queryString}`;
    return this.get<LiquidationResponse>(endpoint);
  }

  /**
   * Polling: fetch recent liquidations, cache in Redis, publish.
   */
  private async updateRecentLiquidations(): Promise<void> {
    try {
      const response = await this.circuitBreaker.execute(() =>
        this.fetchRecentLiquidationsFromApi({ limit: 100 })
      );
      await redisService.set(CACHE_KEY, JSON.stringify(response), CACHE_TTL);
      await redisService.publish(UPDATE_CHANNEL, JSON.stringify({ type: 'DATA_UPDATED', timestamp: Date.now() }));
      logDeduplicator.info('Recent liquidations cache updated', {
        count: response.data?.length || 0,
        hasMore: response.has_more,
      });
    } catch (error) {
      logDeduplicator.error('Failed to update recent liquidations cache', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  public startPolling(): void {
    if (this.pollingInterval) {
      logDeduplicator.warn('HLIndexer liquidations polling already started');
      return;
    }
    logDeduplicator.info('Starting HLIndexer liquidations polling');
    void this.updateRecentLiquidations();
    this.pollingInterval = setInterval(() => {
      void this.updateRecentLiquidations();
    }, UPDATE_INTERVAL);
  }

  public stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
      logDeduplicator.info('HLIndexer liquidations polling stopped');
    }
  }

  /**
   * Get recent liquidations (2h window by default if no filter)
   * Supports hours parameter to filter by time period.
   * For default params (no user, no coin, limit<=100): reads from Redis cache.
   */
  public async getRecentLiquidations(params: LiquidationQueryParams = {}): Promise<LiquidationResponse> {
    if (!this.isDefaultParams(params)) {
      return this.circuitBreaker.execute(async () => {
        const queryString = this.buildQueryString(params);
        const endpoint = `/liquidations/recent${queryString}`;
        logDeduplicator.info('Fetching recent liquidations from HypeDexer', { endpoint, params });
        const response = this.liquidationsFromUnwrapped(await this.getUnwrapped<unknown>(endpoint));
        logDeduplicator.info('Successfully fetched recent liquidations', {
          count: response.data?.length || 0,
          hasMore: response.has_more,
          executionTime: response.execution_time_ms,
        });
        return response;
      });
    }

    let cached = await redisService.get(CACHE_KEY);
    if (!cached) {
      await this.updateRecentLiquidations();
      cached = await redisService.get(CACHE_KEY);
    }
    if (!cached) {
      return this.circuitBreaker.execute(() => this.fetchRecentLiquidationsFromApi(params));
    }

    const response = JSON.parse(cached) as LiquidationResponse;
    const limit = params.limit ?? 100;
    if (limit < 100 && response.data && response.data.length > limit) {
      return {
        ...response,
        data: response.data.slice(0, limit),
        has_more: response.data.length > limit || response.has_more,
      };
    }
    return response;
  }

  /**
   * Check rate limit for an IP
   */
  public checkRateLimit(ip: string): boolean {
    return this.rateLimiter.checkRateLimit(ip);
  }

  /**
   * Get analytics liquidation stats from HypeDexer
   * Endpoint: GET /analytics/liquidations/stats
   * This endpoint provides complete stats without the 5K limit
   */
  public async getAnalyticsStats(params: AnalyticsLiquidationStatsParams): Promise<AnalyticsLiquidationStatsResponse> {
    return this.circuitBreaker.execute(async () => {
      const queryParams = new URLSearchParams();
      queryParams.append('days', params.days.toString());
      if (params.coin) queryParams.append('coin', params.coin);

      const endpoint = `/analytics/liquidations/stats?${queryParams.toString()}`;

      logDeduplicator.info('Fetching analytics liquidation stats from HypeDexer', {
        endpoint,
        params,
      });

      const response = await this.getUnwrapped<AnalyticsLiquidationStatsResponse>(endpoint);

      logDeduplicator.info('Successfully fetched analytics liquidation stats', {
        numberLiquidations: response.data?.number_liquidation,
        amountUsd: response.data?.amount_liquidated_usd,
        executionTime: response.execution_time_ms,
      });

      return response;
    });
  }

  public static getRequestWeight(): number {
    return HLIndexerLiquidationsClient.REQUEST_WEIGHT;
  }
}
