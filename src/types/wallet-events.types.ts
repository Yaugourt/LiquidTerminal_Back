/**
 * Wallet Event Types for LiquidTerminal
 * Defines types for HypeDexer completed_trades WebSocket stream
 * and the normalized internal CompletedTrade format sent to the Telegram bot via /ws
 */

// ============================================================================
// HYPEDEXER EXTERNAL TYPES (completed_trades stream)
// ============================================================================

/**
 * Raw completed trade from HypeDexer WebSocket
 */
export interface HypeDexerCompletedTrade {
  user: string;
  coin: string;
  direction: 'long' | 'short';
  start_time: string;
  end_time: string;
  duration_s: number;
  entry_price: number;
  exit_price: number;
  size_open: number;
  size_close: number;
  pnl_realized: number;
  pnl_percentage: number;
  leverage_type: string;
  leverage_value: number;
  position_value: number;
  total_fills: number;
  total_fees: number;
  avg_fill_price: number;
  total_volume: number;
  trade_id: string;      // Used as eventId for deduplication
  close_hash: string;
  created_at: string;
}

/**
 * HypeDexer completed_trades WebSocket event (server → client)
 */
export interface HypeDexerCompletedTradesEvent {
  type: 'completed_trades';
  count: number;
  data: HypeDexerCompletedTrade[];
}

// ============================================================================
// INTERNAL NORMALIZED TYPE (sent to bot via /ws)
// ============================================================================

/**
 * Normalized completed trade — camelCase, user always lowercase
 * Sent to Telegram bot via InternalWebSocketServer.broadcastWalletEvent()
 */
export interface CompletedTrade {
  tradeId: string;
  user: string;           // Always lowercase
  coin: string;
  direction: 'long' | 'short';
  pnlRealized: number;
  pnlPercentage: number;
  positionValue: number;
  entryPrice: number;
  exitPrice: number;
  totalFees: number;
  totalVolume: number;
  durationSeconds: number;
  endTime: string;
  closeHash: string;
}
