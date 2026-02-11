import { BaseWebSocketService } from '../../../core/base.websocket.service';
import { logDeduplicator } from '../../../utils/logDeduplicator';
import {
  HypeDexerWSMessage,
  HypeDexerWSEvent,
  HypeDexerWSLiquidation,
  HypeDexerWSLiquidationEvent,
  WSConnectionState,
} from '../../../types/websocket.types';
import { Liquidation } from '../../../types/liquidations.types';

/**
 * Callback type for liquidation events
 */
export type LiquidationCallback = (liquidations: Liquidation[]) => void;

/**
 * HypeDexer WebSocket Client for Liquidations
 * 
 * Connects to wss://api-eu.hypedexer.com/ws and subscribes to liquidation events.
 * Follows singleton pattern like other clients in the architecture.
 * 
 * Features:
 * - Automatic reconnection with exponential backoff
 * - Normalizes HypeDexer data format to internal format
 * - Heartbeat/ping-pong for connection health
 */
export class HypeDexerLiquidationsWSClient extends BaseWebSocketService {
  private static instance: HypeDexerLiquidationsWSClient;

  // Configuration
  private static readonly WS_URL = 'wss://api-eu.hypedexer.com/ws';
  private static readonly API_KEY = process.env.HL_INDEXER_API_KEY || '';

  // Subscription state
  private isSubscribed = false;
  private subscriptionFilters: { user?: string; amount_dollars?: number } = {};

  // Callbacks for liquidation events
  private liquidationCallbacks: Set<LiquidationCallback> = new Set();

  private constructor() {
    super(
      {
        url: HypeDexerLiquidationsWSClient.WS_URL,
        headers: {
          'X-API-Key': HypeDexerLiquidationsWSClient.API_KEY,
        },
        reconnect: true,
        reconnectInterval: 5000,
        reconnectMaxInterval: 60000,
        reconnectMaxAttempts: 0, // Infinite
        pingInterval: 30000,
        pingTimeout: 10000,
      },
      {
        onStateChange: (state: WSConnectionState) => this.handleStateChange(state),
      }
    );

    logDeduplicator.info('HypeDexerLiquidationsWSClient: Initialized', {
      url: HypeDexerLiquidationsWSClient.WS_URL,
      hasApiKey: !!HypeDexerLiquidationsWSClient.API_KEY,
    });
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): HypeDexerLiquidationsWSClient {
    if (!HypeDexerLiquidationsWSClient.instance) {
      HypeDexerLiquidationsWSClient.instance = new HypeDexerLiquidationsWSClient();
    }
    return HypeDexerLiquidationsWSClient.instance;
  }

  /**
   * Start the WebSocket connection and subscribe to liquidations
   * Called by ClientInitializerService
   */
  public start(filters?: { user?: string; amount_dollars?: number }): void {
    this.subscriptionFilters = filters || {};
    this.connect();
  }

  /**
   * Stop the WebSocket connection
   */
  public stop(): void {
    this.unsubscribe();
    this.disconnect();
    this.liquidationCallbacks.clear();
  }

  /**
   * Register a callback for liquidation events
   */
  public onLiquidation(callback: LiquidationCallback): () => void {
    this.liquidationCallbacks.add(callback);

    // Return unsubscribe function
    return () => {
      this.liquidationCallbacks.delete(callback);
    };
  }

  /**
   * Subscribe to liquidation events
   */
  public subscribe(filters?: { user?: string; amount_dollars?: number }): void {
    if (filters) {
      this.subscriptionFilters = filters;
    }

    const message: HypeDexerWSMessage = {
      method: 'subscribe',
      subscription: {
        type: 'liquidation',
        ...this.subscriptionFilters,
      },
    };

    const sent = this.send(message);
    if (sent) {
      logDeduplicator.info('HypeDexerLiquidationsWSClient: Subscription sent', {
        filters: this.subscriptionFilters,
      });
    }
  }

  /**
   * Unsubscribe from liquidation events
   */
  public unsubscribe(): void {
    if (!this.isSubscribed) return;

    const message: HypeDexerWSMessage = {
      method: 'unsubscribe',
      subscription: {
        type: 'liquidation',
      },
    };

    this.send(message);
    this.isSubscribed = false;

    logDeduplicator.info('HypeDexerLiquidationsWSClient: Unsubscribed');
  }

  /**
   * Get connection statistics
   */
  public getStats(): {
    state: WSConnectionState;
    isSubscribed: boolean;
    callbackCount: number;
    filters: { user?: string; amount_dollars?: number };
  } {
    return {
      state: this.getState(),
      isSubscribed: this.isSubscribed,
      callbackCount: this.liquidationCallbacks.size,
      filters: this.subscriptionFilters,
    };
  }

  // ============================================================================
  // PROTECTED METHODS - Override from BaseWebSocketService
  // ============================================================================

  /**
   * Called when connection is established
   */
  protected onOpen(): void {
    logDeduplicator.info('HypeDexerLiquidationsWSClient: Connection opened');

    // Subscribe to liquidations
    this.subscribe();
  }

  /**
   * Called when a message is received
   */
  protected onMessage(data: unknown): void {
    try {
      const event = data as HypeDexerWSEvent;

      switch (event.type) {
        case 'liquidation':
          this.handleLiquidationEvent(event as HypeDexerWSLiquidationEvent);
          break;

        case 'subscription_confirmed':
          this.isSubscribed = true;
          logDeduplicator.info('HypeDexerLiquidationsWSClient: Subscription confirmed');
          break;

        case 'error':
          logDeduplicator.error('HypeDexerLiquidationsWSClient: Server error', {
            message: (event as { message?: string }).message,
            code: (event as { code?: string }).code,
          });
          break;

        case 'welcome':
          // HypeDexer sends a welcome message on connection - ignore it
          logDeduplicator.info('HypeDexerLiquidationsWSClient: Welcome received');
          break;

        default:
          logDeduplicator.warn('HypeDexerLiquidationsWSClient: Unknown event type', {
            type: (event as { type?: string }).type,
          });
      }
    } catch (error) {
      logDeduplicator.error('HypeDexerLiquidationsWSClient: Message handling error', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ============================================================================
  // PRIVATE METHODS
  // ============================================================================

  /**
   * Handle liquidation event from HypeDexer
   */
  private handleLiquidationEvent(event: HypeDexerWSLiquidationEvent): void {
    const { count, data } = event;

    if (!data || data.length === 0) {
      return;
    }

    logDeduplicator.info('HypeDexerLiquidationsWSClient: Received liquidations', {
      count,
      actualCount: data.length,
    });

    // Normalize liquidations to internal format
    const normalizedLiquidations = data.map((liq) => this.normalizeLiquidation(liq));

    // Notify all callbacks
    for (const callback of this.liquidationCallbacks) {
      try {
        callback(normalizedLiquidations);
      } catch (error) {
        logDeduplicator.error('HypeDexerLiquidationsWSClient: Callback error', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Normalize HypeDexer liquidation format to internal format
   * - Converts liq_dir from lowercase to PascalCase
   * - Ensures consistent field naming
   */
  private normalizeLiquidation(raw: HypeDexerWSLiquidation): Liquidation {
    return {
      tid: raw.tid,
      time: raw.time,
      time_ms: raw.time_ms,
      coin: raw.coin,
      hash: raw.hash,
      liquidated_user: raw.liquidated_user,
      size_total: raw.size_total,
      notional_total: raw.notional_total,
      fill_px_vwap: raw.fill_px_vwap,
      mark_px: raw.mark_px,
      method: raw.method,
      fee_total_liquidated: raw.fee_total_liquidated,
      liquidators: raw.liquidators,
      liquidator_count: raw.liquidator_count,
      // Normalize liq_dir to PascalCase (case-insensitive)
      liq_dir: String(raw.liq_dir).toLowerCase() === 'long' ? 'Long' 
             : String(raw.liq_dir).toLowerCase() === 'short' ? 'Short' 
             : 'Short', // Fallback si valeur inattendue
    };
  }

  /**
   * Handle connection state changes
   */
  private handleStateChange(state: WSConnectionState): void {
    logDeduplicator.info('HypeDexerLiquidationsWSClient: State changed', { state });
  }
}
