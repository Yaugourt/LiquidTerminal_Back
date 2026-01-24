import { BaseApiService } from '../../../core/base.api.service';
import { LiquidationResponse, LiquidationQueryParams, LiquidationsError } from '../../../types/liquidations.types';
import { CircuitBreakerService } from '../../../core/circuit.breaker.service';
import { RateLimiterService } from '../../../core/hyperLiquid.ratelimiter.service';
import { logDeduplicator } from '../../../utils/logDeduplicator';

/**
 * Client for HypeDexer Liquidations API
 * Follows the standard client architecture with CircuitBreaker and RateLimiter
 */
export class HLIndexerLiquidationsClient extends BaseApiService {
  private static instance: HLIndexerLiquidationsClient;
  private static readonly API_URL = process.env.HL_INDEXER_API_URL || 'https://api-eu.hypedexer.com';
  private static readonly API_KEY = process.env.HL_INDEXER_API_KEY || '';
  private static readonly REQUEST_WEIGHT = 10;
  private static readonly MAX_WEIGHT_PER_MINUTE = 1000;

  private circuitBreaker: CircuitBreakerService;
  private rateLimiter: RateLimiterService;

  private constructor() {
    super(HLIndexerLiquidationsClient.API_URL, {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-API-Key': HLIndexerLiquidationsClient.API_KEY
    });

    this.circuitBreaker = CircuitBreakerService.getInstance('liquidations');
    this.rateLimiter = RateLimiterService.getInstance('liquidations', {
      maxWeightPerMinute: HLIndexerLiquidationsClient.MAX_WEIGHT_PER_MINUTE,
      requestWeight: HLIndexerLiquidationsClient.REQUEST_WEIGHT
    });
  }

  public static getInstance(): HLIndexerLiquidationsClient {
    if (!HLIndexerLiquidationsClient.instance) {
      HLIndexerLiquidationsClient.instance = new HLIndexerLiquidationsClient();
    }
    return HLIndexerLiquidationsClient.instance;
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
        params
      });

      const response = await this.get<LiquidationResponse>(endpoint);
      
      logDeduplicator.info('Successfully fetched liquidations', {
        count: response.data?.length || 0,
        hasMore: response.has_more,
        executionTime: response.execution_time_ms
      });

      return response;
    });
  }

  /**
   * Get recent liquidations (2h window by default if no filter)
   * Supports hours parameter to filter by time period
   */
  public async getRecentLiquidations(params: LiquidationQueryParams = {}): Promise<LiquidationResponse> {
    return this.circuitBreaker.execute(async () => {
      const queryString = this.buildQueryString(params);
      const endpoint = `/liquidations/recent${queryString}`;
      
      logDeduplicator.info('Fetching recent liquidations from HypeDexer', {
        endpoint,
        params
      });

      const response = await this.get<LiquidationResponse>(endpoint);
      
      logDeduplicator.info('Successfully fetched recent liquidations', {
        count: response.data?.length || 0,
        hasMore: response.has_more,
        executionTime: response.execution_time_ms
      });

      return response;
    });
  }

  /**
   * Check rate limit for an IP
   */
  public checkRateLimit(ip: string): boolean {
    return this.rateLimiter.checkRateLimit(ip);
  }

  public static getRequestWeight(): number {
    return HLIndexerLiquidationsClient.REQUEST_WEIGHT;
  }
}
