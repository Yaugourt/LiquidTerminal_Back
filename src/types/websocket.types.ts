/**
 * WebSocket Types for LiquidTerminal
 * Defines types for both external (HypeDexer) and internal WebSocket communication
 */

// ============================================================================
// HYPEDEXER WEBSOCKET TYPES (External)
// ============================================================================

/**
 * HypeDexer WebSocket subscription methods
 */
export type HypeDexerWSMethod = 'subscribe' | 'unsubscribe' | 'list_subscriptions';

/**
 * HypeDexer subscription types
 */
export type HypeDexerSubscriptionType = 'liquidation';

/**
 * HypeDexer subscription request
 */
export interface HypeDexerWSSubscription {
  type: HypeDexerSubscriptionType;
  user?: string;           // Filter by user address
  amount_dollars?: number; // Filter by minimum notional USD
}

/**
 * HypeDexer WebSocket message (client → server)
 */
export interface HypeDexerWSMessage {
  method: HypeDexerWSMethod;
  subscription: HypeDexerWSSubscription;
}

/**
 * HypeDexer liquidation data from WebSocket
 */
export interface HypeDexerWSLiquidation {
  tid: number;
  time: string;              // ISO datetime "2025-11-19T15:46:43"
  time_ms: number;           // Timestamp in milliseconds
  coin: string;
  hash: string;
  liquidated_user: string;
  size_total: number;
  notional_total: number;    // Total value liquidated in USD
  fill_px_vwap: number;
  mark_px: number;
  method: string;            // "market"
  fee_total_liquidated: number;
  liquidators: string[];
  liquidator_count: number;
  liq_dir: 'long' | 'short'; // Note: lowercase from HypeDexer
}

/**
 * HypeDexer WebSocket liquidation event (server → client)
 */
export interface HypeDexerWSLiquidationEvent {
  type: 'liquidation';
  count: number;
  data: HypeDexerWSLiquidation[];
}

/**
 * HypeDexer WebSocket error event
 */
export interface HypeDexerWSErrorEvent {
  type: 'error';
  message: string;
  code?: string;
}

/**
 * HypeDexer WebSocket subscription confirmation
 */
export interface HypeDexerWSSubscriptionConfirm {
  type: 'subscription_confirmed';
  subscription: HypeDexerWSSubscription;
}

/**
 * HypeDexer WebSocket welcome message (sent on connection)
 */
export interface HypeDexerWSWelcomeEvent {
  type: 'welcome';
  message?: string;
}

/**
 * HypeDexer WebSocket heartbeat ping (sent every 60s, expects pong response)
 */
export interface HypeDexerWSPingEvent {
  type: 'ping';
  ts: number;
}

/**
 * All possible HypeDexer WebSocket events
 */
export type HypeDexerWSEvent =
  | HypeDexerWSLiquidationEvent
  | HypeDexerWSErrorEvent
  | HypeDexerWSSubscriptionConfirm
  | HypeDexerWSWelcomeEvent
  | HypeDexerWSPingEvent;

// ============================================================================
// INTERNAL WEBSOCKET TYPES (Our API)
// ============================================================================

/**
 * Internal WebSocket connection state
 */
export type WSConnectionState = 'connecting' | 'connected' | 'disconnected' | 'reconnecting' | 'error';

/**
 * Internal WebSocket client info
 */
export interface WSClient {
  id: string;
  ip: string;
  connectedAt: number;
  lastActivity: number;
  subscriptions: WSClientSubscription[];
  isAuthenticated: boolean;
  userId?: number;          // If authenticated via Privy
  privyUserId?: string;     // Privy user ID
}

/**
 * Client subscription to our internal WebSocket
 */
export interface WSClientSubscription {
  type: 'liquidation' | 'wallet_event' | 'liquidation_alert';
  filters: WSLiquidationFilters;
  subscribedAt: number;
}

/**
 * Liquidation filters for internal subscriptions
 */
export interface WSLiquidationFilters {
  coins?: string[];         // Filter by coins (e.g., ["BTC", "ETH"])
  minAmountUsd?: number;    // Minimum notional in USD
  wallets?: string[];       // Filter by liquidated wallet addresses
}

/**
 * Internal WebSocket message methods
 */
export type WSMethod = 'subscribe' | 'unsubscribe' | 'ping';

/**
 * Internal WebSocket message (client → server)
 */
export interface WSClientMessage {
  method: WSMethod;
  subscription?: {
    type: 'liquidation' | 'wallet_event';
    filters?: WSLiquidationFilters;
  };
  token?: string;           // Privy JWT for authentication
}

/**
 * Internal WebSocket event types (server → client)
 */
export type WSEventType =
  | 'connected'
  | 'authenticated'
  | 'subscribed'
  | 'unsubscribed'
  | 'liquidation'
  | 'wallet_event'
  | 'liquidation_alert'
  | 'heartbeat'
  | 'error';

/**
 * Internal WebSocket server message (server → client)
 */
export interface WSServerMessage {
  type: WSEventType;
  data?: unknown;
  timestamp: string;
  error?: string;
  code?: string;
}

/**
 * Internal WebSocket liquidation event
 */
export interface WSLiquidationEvent extends WSServerMessage {
  type: 'liquidation';
  data: {
    tid: number;
    time: string;
    time_ms: number;
    coin: string;
    hash: string;
    liquidated_user: string;
    size_total: number;
    notional_total: number;
    fill_px_vwap: number;
    mark_px: number;
    liq_dir: 'Long' | 'Short';  // Normalized to PascalCase
    liquidator_count: number;
    aggregation?: {
      isAggregated: boolean;
      count: number;
      timeRangeMs: [number, number];
      originalTids: number[];
      totalNotional: number;
      avgMarkPrice: number;
    };
  };
}

/**
 * Internal WebSocket liquidation alert event (sent by TelegramLiquidationDispatcherService)
 * The bot receives this and calls sendMessage(telegramId, message)
 */
export interface WSLiquidationAlertEvent extends WSServerMessage {
  type: 'liquidation_alert';
  data: {
    telegramId: string;
    message: string;
  };
}

/**
 * WebSocket connection statistics
 */
export interface WSConnectionStats {
  totalConnections: number;
  authenticatedConnections: number;
  uniqueIps: number;
  subscriptionsByType: Record<string, number>;
  messagesPerSecond: number;
  uptime: number;
}

// ============================================================================
// BASE WEBSOCKET CLIENT TYPES
// ============================================================================

/**
 * WebSocket client configuration
 */
export interface WSClientConfig {
  url: string;
  headers?: Record<string, string>;
  reconnect?: boolean;
  reconnectInterval?: number;      // Initial reconnect delay in ms
  reconnectMaxInterval?: number;   // Max reconnect delay in ms
  reconnectMaxAttempts?: number;   // Max reconnect attempts (0 = infinite)
  pingInterval?: number;           // Ping interval in ms
  pingTimeout?: number;            // Ping timeout in ms
  maxBufferSize?: number;          // Max message buffer size in bytes
}

/**
 * WebSocket client events
 */
export interface WSClientEvents {
  onOpen?: () => void;
  onClose?: (code: number, reason: string) => void;
  onError?: (error: Error) => void;
  onMessage?: (data: unknown) => void;
  onReconnect?: (attempt: number) => void;
  onStateChange?: (state: WSConnectionState) => void;
}
