import { BaseApiService } from '../../../core/base.api.service';
import { LiquidationResponse, LiquidationQueryParams, LiquidationsError } from '../../../types/liquidations.types';
import { logDeduplicator } from '../../../utils/logDeduplicator';

/**
 * Client for HypeDexer Liquidations API
 * Provides methods to fetch historical and recent liquidations
 */
export class HLIndexerLiquidationsClient extends BaseApiService {
  private static instance: HLIndexerLiquidationsClient;
  private static readonly API_URL = process.env.HL_INDEXER_API_URL || 'https://api-eu.hypedexer.com';
  private static readonly API_KEY = process.env.HL_INDEXER_API_KEY || '';

  private constructor() {
    super(HLIndexerLiquidationsClient.API_URL, {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-API-Key': HLIndexerLiquidationsClient.API_KEY
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
   */
  private buildQueryString(params: LiquidationQueryParams): string {
    const queryParams = new URLSearchParams();
    
    if (params.coin) queryParams.append('coin', params.coin);
    if (params.user) queryParams.append('user', params.user);
    if (params.start_time) queryParams.append('start_time', params.start_time);
    if (params.end_time) queryParams.append('end_time', params.end_time);
    if (params.amount_dollars !== undefined) queryParams.append('amount_dollars', params.amount_dollars.toString());
    if (params.limit !== undefined) queryParams.append('limit', params.limit.toString());
    if (params.cursor) queryParams.append('cursor', params.cursor);
    if (params.order) queryParams.append('order', params.order);

    const queryString = queryParams.toString();
    return queryString ? `?${queryString}` : '';
  }

  /**
   * Get historical liquidations with filters and keyset pagination
   * @param params Query parameters for filtering and pagination
   * @returns Liquidation response with data and pagination info
   */
  public async getLiquidations(params: LiquidationQueryParams = {}): Promise<LiquidationResponse> {
    try {
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
    } catch (error) {
      logDeduplicator.error('Failed to fetch liquidations', { error });
      throw new LiquidationsError(
        error instanceof Error ? error.message : 'Failed to fetch liquidations',
        500,
        'LIQUIDATIONS_FETCH_ERROR'
      );
    }
  }

  /**
   * Get recent liquidations (2h window by default if no filter)
   * @param params Query parameters for filtering and pagination
   * @returns Liquidation response with data and pagination info
   */
  public async getRecentLiquidations(params: LiquidationQueryParams = {}): Promise<LiquidationResponse> {
    try {
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
    } catch (error) {
      logDeduplicator.error('Failed to fetch recent liquidations', { error });
      throw new LiquidationsError(
        error instanceof Error ? error.message : 'Failed to fetch recent liquidations',
        500,
        'RECENT_LIQUIDATIONS_FETCH_ERROR'
      );
    }
  }
}
