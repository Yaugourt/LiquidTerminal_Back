/**
 * Liquidation data from HypeDexer API
 * Keep ALL original field names
 */
export interface Liquidation {
  time: string;              // ISO datetime "2026-01-08T10:28:36"
  time_ms: number;           // Timestamp in milliseconds
  coin: string;              // Crypto symbol
  hash: string;              // Transaction hash
  liquidated_user: string;   // Liquidated wallet address
  size_total: number;        // Total position size
  notional_total: number;    // Notional value in USD
  fill_px_vwap: number;      // Volume weighted average price
  mark_px: number;           // Mark price
  method: string;            // Method (e.g., "market")
  fee_total_liquidated: number; // Liquidation fee
  liquidators: string[];     // List of liquidator addresses
  liquidator_count: number;  // Number of liquidators
  liq_dir: "Long" | "Short"; // Liquidation direction
  tid: number;               // Trade ID (unique)
}

/**
 * Response from HypeDexer API (original format)
 */
export interface LiquidationResponse {
  success: boolean;
  message: string;
  data: Liquidation[];
  total_count: number | null;
  execution_time_ms: number;
  next_cursor: string | null;  // For keyset pagination: "<time_ms>:<tid>"
  has_more: boolean;
}

/**
 * Query parameters for liquidations API
 */
export interface LiquidationQueryParams {
  coin?: string;
  user?: string;
  start_time?: string;
  end_time?: string;
  amount_dollars?: number;
  limit?: number;
  cursor?: string;
  order?: 'ASC' | 'DESC';
  // Hours filter for recent liquidations
  hours?: number;
}

/**
 * Aggregated stats for liquidations
 */
export interface LiquidationStats {
  totalVolume: number;        // Sum of notional_total
  liquidationsCount: number;  // Total number of liquidations
  longCount: number;          // Number of Long liquidations
  shortCount: number;         // Number of Short liquidations
  topCoin: string;            // Most liquidated coin
  topCoinVolume: number;      // Volume of top coin
  avgSize: number;            // Average liquidation size (totalVolume / liquidationsCount)
  maxLiq: number;             // Largest single liquidation
  longVolume: number;         // Total volume of Long liquidations
  shortVolume: number;        // Total volume of Short liquidations
}

/**
 * Stats response for single period
 */
export interface LiquidationStatsResponse {
  success: boolean;
  stats: LiquidationStats;
  metadata: {
    hours: number;
    executionTimeMs: number;
    pagesLoaded: number;
  };
}

/**
 * Stats response for ALL periods (/stats/all)
 */
export interface LiquidationStatsAllResponse {
  success: boolean;
  stats: {
    '2h': LiquidationStats | null;
    '4h': LiquidationStats | null;
    '8h': LiquidationStats | null;
    '12h': LiquidationStats | null;
    '24h': LiquidationStats | null;
  };
  errors?: string[];
  metadata: {
    executionTimeMs: number;
    cachedAt: string;
  };
}

/**
 * Single bucket of aggregated chart data (simplified: volume + count only)
 */
export interface ChartDataBucket {
  timestamp: string;          // Start of bucket (ISO)
  timestampMs: number;        // For client-side sorting
  totalVolume: number;        // Total notional volume USD
  longVolume: number;         // Long liquidations volume
  shortVolume: number;        // Short liquidations volume
  liquidationsCount: number;  // Total count
  longCount: number;          // Long count
  shortCount: number;         // Short count
}

/**
 * Interval type for chart data aggregation
 */
export type ChartInterval = '5m' | '15m' | '30m' | '1h' | '2h' | '4h' | '1d';

/**
 * Valid period values for chart data (max 24h)
 */
export type ChartPeriod = '2h' | '4h' | '8h' | '12h' | '24h';

/**
 * Combined stats + chart data for a single period
 */
export interface PeriodData {
  stats: LiquidationStats;
  chart: {
    interval: ChartInterval;
    buckets: ChartDataBucket[];
  };
}

/**
 * Unified response combining stats and chart data for all periods
 * Used by /liquidations/data endpoint
 */
export interface LiquidationsDataResponse {
  success: boolean;
  periods: {
    '2h': PeriodData;
    '4h': PeriodData;
    '8h': PeriodData;
    '12h': PeriodData;
    '24h': PeriodData;
  };
  metadata: {
    executionTimeMs: number;
    cachedAt: string;
  };
}

/**
 * Chart data response (for standalone /chart-data endpoint)
 */
export interface LiquidationChartDataResponse {
  success: boolean;
  period: ChartPeriod;
  interval: ChartInterval;
  buckets: ChartDataBucket[];
  metadata: {
    bucketCount: number;
    totalLiquidations: number;
    totalVolume: number;
    executionTimeMs: number;
    cachedAt: string;
    dataSource: 'stats-cache' | 'historical-fetch';
  };
}

export class LiquidationsError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 500,
    public readonly code: string = 'LIQUIDATIONS_ERROR'
  ) {
    super(message);
    this.name = 'LiquidationsError';
  }
}
