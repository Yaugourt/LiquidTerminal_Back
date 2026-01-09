/**
 * Types for HypeDexer Liquidations API
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
  fee_total_liquidated: number;
  liquidators: string[];     // List of liquidator addresses
  liquidator_count: number;
  liq_dir: "Long" | "Short"; // Liquidation direction
  tid: number;               // Trade ID
}

export interface LiquidationResponse {
  success: boolean;
  message: string;
  data: Liquidation[];
  total_count: number | null;
  execution_time_ms: number;
  next_cursor: string | null;  // For pagination: "<time_ms>:<tid>"
  has_more: boolean;
}

export interface LiquidationQueryParams {
  coin?: string;
  user?: string;
  start_time?: string;
  end_time?: string;
  amount_dollars?: number;
  limit?: number;
  cursor?: string;
  order?: 'ASC' | 'DESC';
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
