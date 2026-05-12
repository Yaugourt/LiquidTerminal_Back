import { BaseWebSocketService } from '../../../core/base.websocket.service';
import { logDeduplicator } from '../../../utils/logDeduplicator';
import { WSConnectionState } from '../../../types/websocket.types';
import {
  HypeDexerCompletedTrade,
  HypeDexerCompletedTradesEvent,
  CompletedTrade,
} from '../../../types/wallet-events.types';

/**
 * Callback type for completed trade events
 */
export type CompletedTradeCallback = (trades: CompletedTrade[]) => void;

/**
 * HypeDexer WebSocket Client for Completed Trades
 *
 * Connects to wss://api.hypedexer.com/ws and subscribes to completed_trades events.
 * 1 global subscription — all wallet filtering is done client-side in TelegramWalletDispatcherService.
 *
 * Features:
 * - Automatic reconnection with exponential backoff
 * - Normalizes HypeDexer data format to internal CompletedTrade format
 * - Heartbeat/ping-pong for connection health
 */
export class HypeDexerCompletedTradesWSClient extends BaseWebSocketService {
  private static instance: HypeDexerCompletedTradesWSClient;

  // Configuration
  private static readonly WS_URL = process.env.HYPEDEXER_WS_URL || 'wss://api.hypedexer.com/ws';
  private static readonly API_KEY = process.env.HL_INDEXER_API_KEY || '';

  // Subscription state
  private isSubscribed = false;

  // Callbacks for completed trade events
  private tradeCallbacks: Set<CompletedTradeCallback> = new Set();

  private constructor() {
    super(
      {
        url: HypeDexerCompletedTradesWSClient.WS_URL,
        headers: {
          'X-API-Key': HypeDexerCompletedTradesWSClient.API_KEY,
        },
        reconnect: true,
        reconnectInterval: 5000,
        reconnectMaxInterval: 60000,
        // 0 = infinite reconnect attempts; exponential backoff capped at reconnectMaxInterval (60s).
        reconnectMaxAttempts: 0,
        pingInterval: 30000,
        pingTimeout: 10000,
      },
      {
        onStateChange: (state: WSConnectionState) => this.handleStateChange(state),
        onReconnect: (attempt: number) => {
          // Emit one degraded-signal error log when consecutive failures cross 10.
          if (attempt === 10) {
            logDeduplicator.error('HypeDexerCompletedTradesWSClient: degraded — 10 consecutive reconnect attempts; continuing with exponential backoff');
          }
        },
      }
    );

    logDeduplicator.info('HypeDexerCompletedTradesWSClient: Initialized', {
      url: HypeDexerCompletedTradesWSClient.WS_URL,
      hasApiKey: !!HypeDexerCompletedTradesWSClient.API_KEY,
    });
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): HypeDexerCompletedTradesWSClient {
    if (!HypeDexerCompletedTradesWSClient.instance) {
      HypeDexerCompletedTradesWSClient.instance = new HypeDexerCompletedTradesWSClient();
    }
    return HypeDexerCompletedTradesWSClient.instance;
  }

  /**
   * Start the WebSocket connection and subscribe to completed_trades
   */
  public start(): void {
    this.connect();
  }

  /**
   * Stop the WebSocket connection
   */
  public stop(): void {
    this.unsubscribe();
    this.disconnect();
    this.tradeCallbacks.clear();
  }

  /**
   * Register a callback for completed trade events
   * Returns an unsubscribe function
   */
  public onCompletedTrade(callback: CompletedTradeCallback): () => void {
    this.tradeCallbacks.add(callback);
    return () => {
      this.tradeCallbacks.delete(callback);
    };
  }

  /**
   * Subscribe to completed_trades events (global — no user filter)
   */
  public subscribe(): void {
    const message = {
      method: 'subscribe',
      subscription: {
        type: 'completed_trades',
      },
    };

    const sent = this.send(message);
    if (sent) {
      logDeduplicator.info('HypeDexerCompletedTradesWSClient: Subscription sent');
    }
  }

  /**
   * Unsubscribe from completed_trades events
   */
  public unsubscribe(): void {
    if (!this.isSubscribed) return;

    const message = {
      method: 'unsubscribe',
      subscription: {
        type: 'completed_trades',
      },
    };

    this.send(message);
    this.isSubscribed = false;

    logDeduplicator.info('HypeDexerCompletedTradesWSClient: Unsubscribed');
  }

  /**
   * Get connection statistics
   */
  public getStats(): {
    state: WSConnectionState;
    isSubscribed: boolean;
    callbackCount: number;
  } {
    return {
      state: this.getState(),
      isSubscribed: this.isSubscribed,
      callbackCount: this.tradeCallbacks.size,
    };
  }

  // ============================================================================
  // PROTECTED METHODS - Override from BaseWebSocketService
  // ============================================================================

  /**
   * Called when connection is established — auto-subscribe
   */
  protected onOpen(): void {
    logDeduplicator.info('HypeDexerCompletedTradesWSClient: Connection opened');
    this.subscribe();
  }

  /**
   * Called when a message is received
   */
  protected onMessage(data: unknown): void {
    // Defensive guard: base service should already filter non-object payloads,
    // but Hypedexer occasionally emits non-JSON / malformed frames (known upstream bug).
    if (typeof data !== 'object' || data === null) {
      logDeduplicator.warn('HypeDexerCompletedTradesWSClient: non-object ws message dropped', {
        type: typeof data,
      });
      return;
    }

    try {
      const event = data as { type?: string };

      switch (event.type) {
        case 'completed_trades':
          this.handleCompletedTradesEvent(event as HypeDexerCompletedTradesEvent);
          break;

        case 'subscription_confirmed':
          this.isSubscribed = true;
          logDeduplicator.info('HypeDexerCompletedTradesWSClient: Subscription confirmed');
          break;

        case 'error':
          logDeduplicator.error('HypeDexerCompletedTradesWSClient: Server error', {
            message: (event as { message?: string }).message,
            code: (event as { code?: string }).code,
          });
          break;

        case 'welcome':
          logDeduplicator.info('HypeDexerCompletedTradesWSClient: Welcome received');
          break;

        case 'ping':
          // Heartbeat: HypeDexer expects pong within 60s or closes connection
          this.send({ type: 'pong', ts: (event as { ts?: number }).ts ?? Date.now() });
          break;

        default:
          logDeduplicator.warn('HypeDexerCompletedTradesWSClient: Unknown event type', {
            type: event.type,
          });
      }
    } catch (error) {
      logDeduplicator.error('HypeDexerCompletedTradesWSClient: Message handling error', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ============================================================================
  // PRIVATE METHODS
  // ============================================================================

  /**
   * Handle completed_trades event from HypeDexer
   */
  private handleCompletedTradesEvent(event: HypeDexerCompletedTradesEvent): void {
    const { count, data } = event;

    if (!data || data.length === 0) {
      return;
    }

    logDeduplicator.info('HypeDexerCompletedTradesWSClient: Received completed trades', {
      count,
      actualCount: data.length,
    });

    // Normalize to internal format
    const normalizedTrades = data.map((trade) => this.normalizeTrade(trade));

    // Notify all callbacks
    for (const callback of this.tradeCallbacks) {
      try {
        callback(normalizedTrades);
      } catch (error) {
        logDeduplicator.error('HypeDexerCompletedTradesWSClient: Callback error', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Normalize HypeDexer completed trade to internal format
   * - camelCase field names
   * - user address always lowercase
   */
  private normalizeTrade(raw: HypeDexerCompletedTrade): CompletedTrade {
    return {
      tradeId: raw.trade_id,
      user: raw.user.toLowerCase(),
      coin: raw.coin,
      direction: raw.direction,
      pnlRealized: raw.pnl_realized,
      pnlPercentage: raw.pnl_percentage,
      positionValue: raw.position_value,
      entryPrice: raw.entry_price,
      exitPrice: raw.exit_price,
      totalFees: raw.total_fees,
      totalVolume: raw.total_volume,
      durationSeconds: raw.duration_s,
      endTime: raw.end_time,
      closeHash: raw.close_hash,
    };
  }

  /**
   * Handle connection state changes
   */
  private handleStateChange(state: WSConnectionState): void {
    logDeduplicator.info('HypeDexerCompletedTradesWSClient: State changed', { state });
  }
}
