import { BaseWebSocketService } from '../../../core/base.websocket.service';
import { logDeduplicator } from '../../../utils/logDeduplicator';
import { WSConnectionState } from '../../../types/websocket.types';
import {
  HypeDexerFill,
  HypeDexerAllFillsEvent,
  NormalizedFill,
} from '../../../types/fill-alerts.types';

/**
 * Callback type for normalized perp fill events
 */
export type FillCallback = (fills: NormalizedFill[]) => void;

/**
 * HypeDexer Live-Data WebSocket Client
 *
 * Connects to the live-data (mirror) endpoint wss://api.hypedexer.com/ws?mode=mirror
 * and subscribes to the `allFills` channel (perp fills, market-wide).
 *
 * Unlike the multiplex endpoint, live-data messages are discriminated by `channel`
 * (NOT `type`). Heartbeat still uses `{type:'ping'}` / `{type:'pong'}`.
 *
 * 1 shared connection — consumed by the Fill Alert dispatcher.
 */
export class HypeDexerLiveDataWSClient extends BaseWebSocketService {
  private static instance: HypeDexerLiveDataWSClient;

  // Configuration
  private static readonly WS_URL =
    process.env.HYPEDEXER_LIVEDATA_WS_URL || 'wss://api.hypedexer.com/ws?mode=mirror';
  private static readonly API_KEY = process.env.HL_INDEXER_API_KEY || '';

  // Callbacks
  private fillCallbacks: Set<FillCallback> = new Set();

  private constructor() {
    super(
      {
        url: HypeDexerLiveDataWSClient.WS_URL,
        headers: {
          'X-API-Key': HypeDexerLiveDataWSClient.API_KEY,
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
            logDeduplicator.error('HypeDexerLiveDataWSClient: degraded — 10 consecutive reconnect attempts; continuing with exponential backoff');
          }
        },
      }
    );

    logDeduplicator.info('HypeDexerLiveDataWSClient: Initialized', {
      url: HypeDexerLiveDataWSClient.WS_URL,
      hasApiKey: !!HypeDexerLiveDataWSClient.API_KEY,
    });
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): HypeDexerLiveDataWSClient {
    if (!HypeDexerLiveDataWSClient.instance) {
      HypeDexerLiveDataWSClient.instance = new HypeDexerLiveDataWSClient();
    }
    return HypeDexerLiveDataWSClient.instance;
  }

  /**
   * Start the WebSocket connection and subscribe to allFills
   */
  public start(): void {
    this.connect();
  }

  /**
   * Stop the WebSocket connection
   */
  public stop(): void {
    this.disconnect();
    this.fillCallbacks.clear();
  }

  /**
   * Register a callback for normalized perp fill events
   * Returns an unsubscribe function
   */
  public onFill(callback: FillCallback): () => void {
    this.fillCallbacks.add(callback);
    return () => {
      this.fillCallbacks.delete(callback);
    };
  }

  /**
   * Get connection statistics
   */
  public getStats(): {
    state: WSConnectionState;
    fillCallbackCount: number;
  } {
    return {
      state: this.getState(),
      fillCallbackCount: this.fillCallbacks.size,
    };
  }

  // ============================================================================
  // PROTECTED METHODS - Override from BaseWebSocketService
  // ============================================================================

  /**
   * Called when connection is established — subscribe to allFills
   */
  protected onOpen(): void {
    logDeduplicator.info('HypeDexerLiveDataWSClient: Connection opened');
    this.send({ method: 'subscribe', subscription: { type: 'allFills' } });
    logDeduplicator.info('HypeDexerLiveDataWSClient: Subscription sent (allFills)');
  }

  /**
   * Called when a message is received
   */
  protected onMessage(data: unknown): void {
    // Defensive guard: base service should already filter non-object payloads,
    // but Hypedexer occasionally emits non-JSON / malformed frames (known upstream bug).
    if (typeof data !== 'object' || data === null) {
      logDeduplicator.warn('HypeDexerLiveDataWSClient: non-object ws message dropped', {
        type: typeof data,
      });
      return;
    }

    try {
      const event = data as { channel?: string; type?: string };

      // Heartbeat uses `type` (same as multiplex endpoint)
      if (event.type === 'ping') {
        this.send({ type: 'pong', ts: (event as { ts?: number }).ts ?? Date.now() });
        return;
      }

      // Live-data channels are discriminated by `channel`
      switch (event.channel) {
        case 'allFills':
          this.handleAllFillsEvent(event as HypeDexerAllFillsEvent);
          break;

        case 'subscriptionResponse':
          logDeduplicator.info('HypeDexerLiveDataWSClient: Subscription acknowledged');
          break;

        case 'error':
          logDeduplicator.error('HypeDexerLiveDataWSClient: Server error', {
            message: (event as { message?: string }).message,
          });
          break;

        default:
          if (event.channel === undefined && event.type === undefined) {
            logDeduplicator.warn('HypeDexerLiveDataWSClient: message without channel/type dropped');
          } else {
            logDeduplicator.warn('HypeDexerLiveDataWSClient: Unknown channel', {
              channel: event.channel,
              type: event.type,
            });
          }
      }
    } catch (error) {
      logDeduplicator.error('HypeDexerLiveDataWSClient: Message handling error', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ============================================================================
  // PRIVATE METHODS
  // ============================================================================

  /**
   * Handle `allFills` channel event — normalize and dispatch
   */
  private handleAllFillsEvent(event: HypeDexerAllFillsEvent): void {
    const data = event.data;
    if (!data || !Array.isArray(data.fills) || data.fills.length === 0) return;

    // Skip the one-shot historical snapshot replayed on (re)subscribe — those
    // fills are old and must not be broadcast as fresh alerts.
    if (data.isSnapshot === true) {
      logDeduplicator.info('HypeDexerLiveDataWSClient: allFills snapshot skipped', {
        count: data.fills.length,
      });
      return;
    }

    const normalized = data.fills.map((entry) => this.normalizeFill(entry.address, entry.fill));

    for (const callback of this.fillCallbacks) {
      try {
        callback(normalized);
      } catch (error) {
        logDeduplicator.error('HypeDexerLiveDataWSClient: Fill callback error', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Normalize a HypeDexer perp fill to the unified NormalizedFill shape.
   * px/sz are strings — parsed to numbers.
   */
  private normalizeFill(address: string, raw: HypeDexerFill): NormalizedFill {
    const px = parseFloat(raw.px);
    const sz = parseFloat(raw.sz);
    // closedPnl is a string in the HypeDexer schema; default to 0 if it parses to NaN.
    const closedPnlParsed = parseFloat(raw.closedPnl);
    const closedPnl = Number.isFinite(closedPnlParsed) ? closedPnlParsed : 0;
    return {
      source: 'perp',
      oid: raw.oid,
      wallet: address.toLowerCase(),
      coin: raw.coin,
      px,
      sz,
      notionalUsd: px * sz,
      side: raw.side,
      time: raw.time,
      hash: raw.hash,
      dir: raw.dir,
      twapId: raw.twapId ?? null,
      closedPnl,
    };
  }

  /**
   * Handle connection state changes
   */
  private handleStateChange(state: WSConnectionState): void {
    logDeduplicator.info('HypeDexerLiveDataWSClient: State changed', { state });
  }
}
