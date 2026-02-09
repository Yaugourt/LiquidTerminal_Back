/**
 * Analytics Liquidation Stats from HypeDexer API
 * Endpoint: GET /analytics/liquidations/stats
 */

/**
 * Data structure from analytics liquidations stats endpoint
 */
export interface AnalyticsLiquidationStatsData {
  number_liquidation: number;
  number_long_liquidated: number;
  number_short_liquidated: number;
  amount_liquidated_usd: number;
  total_fees: number;
  top_token_liquidated: string;
  time_range: {
    start: string;
    end: string;
  };
}

/**
 * Response from GET /analytics/liquidations/stats
 */
export interface AnalyticsLiquidationStatsResponse {
  success: boolean;
  message: string;
  data: AnalyticsLiquidationStatsData;
  total_count: number | null;
  execution_time_ms: number;
  next_cursor: string | null;
  has_more: boolean | null;
}

/**
 * Query parameters for analytics liquidations stats
 */
export interface AnalyticsLiquidationStatsParams {
  days: number;  // 1-30
  coin?: string;
}
