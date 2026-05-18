import { BaseWebSocketService } from '../../../core/base.websocket.service';
import { logDeduplicator } from '../../../utils/logDeduplicator';
import { WSConnectionState } from '../../../types/websocket.types';
import {
  HypeDexerSpotFill,
  HypeDexerSpotFillEvent,
  SpotFill,
} from '../../../types/fill-alerts.types';

/**
 * Callback type for spot fill events
 */
export type SpotFillCallback = (fills: SpotFill[]) => void;

/**
 * HypeDexer WebSocket Client for Spot Fills
 *
 * Connects to the multiplex endpoint wss://api.hypedexer.com/ws and subscribes to
 * fills_spot events. 1 global subscription — all coin/side/notional filtering is
 * done client-side in TelegramSpotFillDispatcherService.
 *
 * Features:
 * - Automatic reconnection with exponential backoff
 * - Normalizes HypeDexer data format to internal SpotFill format
 * - Heartbeat/ping-pong for connection health
 */
export class HypeDexerSpotFillsWSClient extends BaseWebSocketService {
  private static instance: HypeDexerSpotFillsWSClient;

  // Configuration
  private static readonly WS_URL = process.env.HYPEDEXER_WS_URL || 'wss://api.hypedexer.com/ws';
  private static readonly API_KEY = process.env.HL_INDEXER_API_KEY || '';

  // Subscription state
  private isSubscribed = false;

  // Callbacks for spot fill events
  private fillCallbacks: Set<SpotFillCallback> = new Set();

  private constructor() {
    super(
      {
        url: HypeDexerSpotFillsWSClient.WS_URL,
        headers: {
          'X-API-Key': HypeDexerSpotFillsWSClient.API_KEY,
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
            logDeduplicator.error('HypeDexerSpotFillsWSClient: degraded — 10 consecutive reconnect attempts; continuing with exponential backoff');
          }
        },
      }
    );

    logDeduplicator.info('HypeDexerSpotFillsWSClient: Initialized', {
      url: HypeDexerSpotFillsWSClient.WS_URL,
      hasApiKey: !!HypeDexerSpotFillsWSClient.API_KEY,
    });
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): HypeDexerSpotFillsWSClient {
    if (!HypeDexerSpotFillsWSClient.instance) {
      HypeDexerSpotFillsWSClient.instance = new HypeDexerSpotFillsWSClient();
    }
    return HypeDexerSpotFillsWSClient.instance;
  }

  /**
   * Start the WebSocket connection and subscribe to fills_spot
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
    this.fillCallbacks.clear();
  }

  /**
   * Register a callback for spot fill events
   * Returns an unsubscribe function
   */
  public onSpotFill(callback: SpotFillCallback): () => void {
    this.fillCallbacks.add(callback);
    return () => {
      this.fillCallbacks.delete(callback);
    };
  }

  /**
   * Subscribe to fills_spot events (global — no user filter)
   */
  public subscribe(): void {
    const message = {
      method: 'subscribe',
      subscription: {
        type: 'fills_spot',
      },
    };

    const sent = this.send(message);
    if (sent) {
      logDeduplicator.info('HypeDexerSpotFillsWSClient: Subscription sent');
    }
  }

  /**
   * Unsubscribe from fills_spot events
   */
  public unsubscribe(): void {
    if (!this.isSubscribed) return;

    const message = {
      method: 'unsubscribe',
      subscription: {
        type: 'fills_spot',
      },
    };

    this.send(message);
    this.isSubscribed = false;

    logDeduplicator.info('HypeDexerSpotFillsWSClient: Unsubscribed');
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
      callbackCount: this.fillCallbacks.size,
    };
  }

  // ============================================================================
  // PROTECTED METHODS - Override from BaseWebSocketService
  // ============================================================================

  /**
   * Called when connection is established — auto-subscribe
   */
  protected onOpen(): void {
    logDeduplicator.info('HypeDexerSpotFillsWSClient: Connection opened');
    this.subscribe();
  }

  /**
   * Called when a message is received
   */
  protected onMessage(data: unknown): void {
    // Defensive guard: base service should already filter non-object payloads,
    // but Hypedexer occasionally emits non-JSON / malformed frames (known upstream bug).
    if (typeof data !== 'object' || data === null) {
      logDeduplicator.warn('HypeDexerSpotFillsWSClient: non-object ws message dropped', {
        type: typeof data,
      });
      return;
    }

    try {
      const event = data as { type?: string };

      switch (event.type) {
        case 'fills_spot':
          this.handleSpotFillEvent(event as HypeDexerSpotFillEvent);
          break;

        case 'subscription_confirmed':
        case 'subscription_added':
          this.isSubscribed = true;
          logDeduplicator.info('HypeDexerSpotFillsWSClient: Subscription confirmed');
          break;

        case 'error':
          logDeduplicator.error('HypeDexerSpotFillsWSClient: Server error', {
            message: (event as { message?: string }).message,
            code: (event as { code?: string }).code,
          });
          break;

        case 'welcome':
          logDeduplicator.info('HypeDexerSpotFillsWSClient: Welcome received');
          break;

        case 'ping':
          // Heartbeat: HypeDexer expects pong within 60s or closes connection
          this.send({ type: 'pong', ts: (event as { ts?: number }).ts ?? Date.now() });
          break;

        default:
          logDeduplicator.warn('HypeDexerSpotFillsWSClient: Unknown event type', {
            type: event.type,
          });
      }
    } catch (error) {
      logDeduplicator.error('HypeDexerSpotFillsWSClient: Message handling error', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ============================================================================
  // PRIVATE METHODS
  // ============================================================================

  /**
   * Handle fills_spot event from HypeDexer
   */
  private handleSpotFillEvent(event: HypeDexerSpotFillEvent): void {
    const { count, data } = event;

    if (!data || data.length === 0) {
      return;
    }

    logDeduplicator.debug('HypeDexerSpotFillsWSClient: Received spot fills', {
      count,
      actualCount: data.length,
    });

    // Normalize to internal format
    const normalizedFills = data.map((fill) => this.normalizeFill(fill));

    // Notify all callbacks
    for (const callback of this.fillCallbacks) {
      try {
        callback(normalizedFills);
      } catch (error) {
        logDeduplicator.error('HypeDexerSpotFillsWSClient: Callback error', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Normalize HypeDexer spot fill to internal SpotFill format
   * - numeric fields, user lowercase, display coin = coin_meaning || coin
   */
  private normalizeFill(raw: HypeDexerSpotFill): SpotFill {
    return {
      tid: raw.tid,
      oid: raw.oid,
      user: String(raw.user).toLowerCase(),
      coin: raw.coin_meaning || raw.coin,
      rawCoin: raw.coin,
      px: raw.px,
      sz: raw.sz,
      notionalUsd: raw.px * raw.sz,
      side: raw.side,
      time: raw.time,
      hash: raw.hash,
      feeUsdc: raw.fee_usdc,
    };
  }

  /**
   * Handle connection state changes
   */
  private handleStateChange(state: WSConnectionState): void {
    logDeduplicator.info('HypeDexerSpotFillsWSClient: State changed', { state });
  }
}
