/**
 * Top Trader data from HypeDexer API
 * GET /overview/top-traders-24h
 */
export interface TopTrader {
  user: string;           // Wallet address (0x...)
  tradeCount: number;     // Number of trades in 24h
  totalVolume: number;    // Total trading volume in USD
  winRate: number;        // Win rate (0-1)
  totalPnl: number;       // Total PnL in USD
}

/**
 * Sort options for top traders API
 */
export type TopTradersSortType = 'pnl_pos' | 'pnl_neg' | 'volume' | 'trades';

/**
 * Query parameters for top traders API
 */
export interface TopTradersQueryParams {
  sort?: TopTradersSortType;
  limit?: number;
}

/**
 * Response from HypeDexer API (original format)
 */
export interface TopTradersApiResponse {
  success: boolean;
  message: string;
  data: TopTrader[];
  total_count: number | null;
  execution_time_ms: number;
  next_cursor: string | null;
  has_more: boolean | null;
}

/**
 * Our API response format (transformed)
 */
export interface TopTradersResponse {
  success: boolean;
  data: TopTrader[];
  metadata: {
    sort: TopTradersSortType;
    limit: number;
    executionTimeMs: number;
    cachedAt: string;
  };
}

/**
 * Top Traders error class
 */
export class TopTradersError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 500,
    public readonly code: string = 'TOP_TRADERS_ERROR'
  ) {
    super(message);
    this.name = 'TopTradersError';
  }
}
