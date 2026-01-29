/**
 * Active User data from HypeDexer API
 * GET /users/active
 */
export interface ActiveUser {
  user: string;           // Wallet address (0x...)
  fill_count: number;     // Number of fills/trades
  total_volume: number;   // Total trading volume in USD
  unique_coins: number;   // Number of unique coins traded
  last_activity: string;  // ISO datetime of last activity
}

/**
 * Query parameters for active users API
 */
export interface ActiveUsersQueryParams {
  hours?: number;  // Lookback window in hours (1-168, default: 24)
  limit?: number;  // Max users (1-100, default: 100)
}

/**
 * Response from HypeDexer API (original format)
 */
export interface ActiveUsersApiResponse {
  success: boolean;
  message: string;
  data: ActiveUser[];
  total_count: number | null;
  execution_time_ms: number;
  next_cursor: string | null;
  has_more: boolean | null;
}

/**
 * Our API response format (transformed)
 */
export interface ActiveUsersResponse {
  success: boolean;
  data: ActiveUser[];
  metadata: {
    hours: number;
    limit: number;
    totalCount: number;
    executionTimeMs: number;
    cachedAt: string;
  };
}

/**
 * Active Users error class
 */
export class ActiveUsersError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 500,
    public readonly code: string = 'ACTIVE_USERS_ERROR'
  ) {
    super(message);
    this.name = 'ActiveUsersError';
  }
}
