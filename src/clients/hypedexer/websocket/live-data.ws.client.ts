import { BaseWebSocketService } from '../../../core/base.websocket.service';
import { logDeduplicator } from '../../../utils/logDeduplicator';
import { WSConnectionState } from '../../../types/websocket.types';
import {
  HypeDexerFill,
  HypeDexerAllFillsEvent,
  NormalizedFill,
} from '../../../types/fill-alerts.types';
import { HypeDexerTwapStatusEvent, TwapStatusEvent } from '../../../types/twap-live.types';

/**
 * Callback type for normalized fill events (perp and spot)
 */
export type FillCallback = (fills: NormalizedFill[]) => void;

/**
 * Callback type for TWAP status events (`allTwapStatusUpdates`). Snapshot
 * events are delivered too, flagged `isSnapshot`.
 */
export type TwapStatusCallback = (events: TwapStatusEvent[]) => void;

/**
 * Callback type for the upstream connection: `connected` once the socket is
 * open and both subscriptions are sent, false as soon as it closes, errors or
 * starts reconnecting. `at` is when it changed (epoch ms).
 */
export type ConnectionCallback = (connected: boolean, at: number) => void;

/**
 * HypeDexer Live-Data WebSocket Client
 *
 * Connects to the live-data (mirror) endpoint wss://api.hypedexer.com/ws?mode=mirror
 * and subscribes to the `allFills` channel (and `allTwapStatusUpdates`, see
 * below): every fill, market-wide — native
 * perps ("BTC"), HIP-3 perps ("xyz:GOLD"), HIP-4 outcomes ("#123") and spot
 * ("@107"). HypeDexer dropped its separate `fills_spot` channel (2026-09), so
 * spot fills are told apart here and normalized with `source: 'spot'`.
 *
 * Unlike the multiplex endpoint, live-data messages are discriminated by `channel`
 * (NOT `type`). Heartbeat still uses `{type:'ping'}` / `{type:'pong'}`.
 *
 * `allTwapStatusUpdates` rides the same socket: TWAP status events (activated /
 * finished / terminated, ~20 a minute), a snapshot of the latest 200 on
 * subscribe and live frames after. It never reports failed TWAPs.
 *
 * 1 shared connection — consumed by the Fill Alert dispatcher (fills) and the
 * live TWAP book (fills, status events, connection state). start()/stop() are
 * reference-counted: each consumer releases only its own callbacks, and the
 * socket closes with the last one.
 */
export class HypeDexerLiveDataWSClient extends BaseWebSocketService {
  private static instance: HypeDexerLiveDataWSClient;

  // Configuration
  private static readonly WS_URL =
    process.env.HYPEDEXER_LIVEDATA_WS_URL || 'wss://api.hypedexer.com/ws?mode=mirror';
  private static readonly API_KEY = process.env.HL_INDEXER_API_KEY || '';

  // Callbacks
  private fillCallbacks: Set<FillCallback> = new Set();
  private twapStatusCallbacks: Set<TwapStatusCallback> = new Set();
  private connectionCallbacks: Set<ConnectionCallback> = new Set();

  /** Consumers that called start() and not stop() yet. */
  private consumers = 0;
  /** True once the socket is open and both subscriptions are sent. */
  private upstreamConnected = false;
  private upstreamSince: number | null = null;

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
        // A frame is one block of fills: ~64 KB at normal load, and the default
        // 100 KB cap would drop a whole block (so its alerts) under heavy load.
        maxBufferSize: 1024 * 1024,
      },
      {
        onStateChange: (state: WSConnectionState) => this.handleStateChange(state),
        onError: () => this.setUpstreamConnected(false),
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
   * Start the WebSocket connection and subscribe to allFills and
   * allTwapStatusUpdates. Reference-counted: every consumer calls start() once
   * and stop() once.
   */
  public start(): void {
    this.consumers++;
    // A later consumer joins the open (or reconnecting) socket.
    if (this.consumers === 1) this.connect();
  }

  /**
   * Release one consumer. The socket closes (and every callback is dropped)
   * with the last one; a consumer's own callbacks go through the unsubscribe
   * functions of onFill / onTwapStatus / onConnectionChange.
   */
  public stop(): void {
    this.consumers = Math.max(0, this.consumers - 1);
    if (this.consumers > 0) return;

    this.disconnect();
    this.setUpstreamConnected(false);
    this.fillCallbacks.clear();
    this.twapStatusCallbacks.clear();
    this.connectionCallbacks.clear();
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
   * Register a callback for TWAP status events (snapshot events included,
   * flagged `isSnapshot`). Returns an unsubscribe function.
   */
  public onTwapStatus(callback: TwapStatusCallback): () => void {
    this.twapStatusCallbacks.add(callback);
    return () => {
      this.twapStatusCallbacks.delete(callback);
    };
  }

  /**
   * Register a callback for upstream connection changes. Returns an
   * unsubscribe function. See getConnection() for the current state.
   */
  public onConnectionChange(callback: ConnectionCallback): () => void {
    this.connectionCallbacks.add(callback);
    return () => {
      this.connectionCallbacks.delete(callback);
    };
  }

  /**
   * Current upstream state: `at` is when the current connection became ready
   * (null while disconnected).
   */
  public getConnection(): { connected: boolean; at: number | null } {
    return { connected: this.upstreamConnected, at: this.upstreamSince };
  }

  /**
   * Get connection statistics
   */
  public getStats(): {
    state: WSConnectionState;
    fillCallbackCount: number;
    twapStatusCallbackCount: number;
  } {
    return {
      state: this.getState(),
      fillCallbackCount: this.fillCallbacks.size,
      twapStatusCallbackCount: this.twapStatusCallbacks.size,
    };
  }

  // ============================================================================
  // PROTECTED METHODS - Override from BaseWebSocketService
  // ============================================================================

  /**
   * Called when connection is established — subscribe to allFills and allTwapStatusUpdates
   */
  protected onOpen(): void {
    logDeduplicator.info('HypeDexerLiveDataWSClient: Connection opened');
    const fillsSent = this.send({ method: 'subscribe', subscription: { type: 'allFills' } });
    const twapsSent = this.send({ method: 'subscribe', subscription: { type: 'allTwapStatusUpdates' } });
    logDeduplicator.info('HypeDexerLiveDataWSClient: Subscriptions sent (allFills, allTwapStatusUpdates)');
    this.setUpstreamConnected(fillsSent && twapsSent);
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

        case 'allTwapStatusUpdates':
          this.handleTwapStatusEvent(event as HypeDexerTwapStatusEvent);
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
   * Handle `allTwapStatusUpdates` channel event — parse both frame shapes
   * (snapshot object, live array) and dispatch the valid events.
   */
  private handleTwapStatusEvent(event: HypeDexerTwapStatusEvent): void {
    const data: unknown = event.data;
    let rawEvents: unknown;
    let isSnapshot = false;
    if (Array.isArray(data)) {
      rawEvents = data;
    } else if (typeof data === 'object' && data !== null) {
      rawEvents = (data as { events?: unknown }).events;
      isSnapshot = (data as { isSnapshot?: unknown }).isSnapshot === true;
    }
    if (!Array.isArray(rawEvents) || rawEvents.length === 0) return;

    const events: TwapStatusEvent[] = [];
    let malformed = 0;
    for (const raw of rawEvents) {
      const parsed = HypeDexerLiveDataWSClient.parseTwapStatus(raw, isSnapshot);
      if (parsed) events.push(parsed);
      else malformed++;
    }
    if (malformed > 0) {
      logDeduplicator.warn('HypeDexerLiveDataWSClient: malformed allTwapStatusUpdates event dropped', {
        count: malformed,
      });
    }
    if (events.length === 0) return;

    for (const callback of this.twapStatusCallbacks) {
      try {
        callback(events);
      } catch (error) {
        logDeduplicator.error('HypeDexerLiveDataWSClient: TWAP status callback error', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /** A finite number from a JSON number or numeric string, else null. */
  private static toNumber(value: unknown): number | null {
    const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
    return Number.isFinite(n) ? n : null;
  }

  /** Validate one status event; null when a field the book relies on is missing or malformed. */
  private static parseTwapStatus(raw: unknown, isSnapshot: boolean): TwapStatusEvent | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const e = raw as { twapId?: unknown; status?: unknown; time?: unknown; state?: unknown };
    const state = e.state;
    if (typeof state !== 'object' || state === null) return null;
    const s = state as Record<string, unknown>;

    const twapId = HypeDexerLiveDataWSClient.toNumber(e.twapId);
    const time = HypeDexerLiveDataWSClient.toNumber(e.time);
    const sz = HypeDexerLiveDataWSClient.toNumber(s.sz);
    const executedSz = HypeDexerLiveDataWSClient.toNumber(s.executedSz);
    const executedNtl = HypeDexerLiveDataWSClient.toNumber(s.executedNtl);
    const minutes = HypeDexerLiveDataWSClient.toNumber(s.minutes);
    const startTime = HypeDexerLiveDataWSClient.toNumber(s.timestamp);
    if (
      twapId === null ||
      time === null ||
      sz === null ||
      executedSz === null ||
      executedNtl === null ||
      minutes === null ||
      startTime === null
    ) {
      return null;
    }
    if (typeof e.status !== 'string' || e.status === '') return null;
    if (typeof s.coin !== 'string' || s.coin === '') return null;
    if (typeof s.user !== 'string' || s.user === '') return null;
    if (s.side !== 'A' && s.side !== 'B') return null;

    return {
      twapId,
      status: e.status,
      time,
      coin: s.coin,
      user: s.user.toLowerCase(),
      side: s.side,
      sz,
      executedSz,
      executedNtl,
      minutes,
      reduceOnly: s.reduceOnly === true,
      randomize: s.randomize === true,
      startTime,
      isSnapshot,
    };
  }

  /**
   * Spot pairs are "@<pair index>" plus the legacy "PURR/USDC"; every other
   * coin on allFills is a perp-like market (native, HIP-3 "dex:COIN", HIP-4 "#N").
   */
  private static isSpotCoin(coin: string): boolean {
    return coin.startsWith('@') || coin.includes('/');
  }

  /**
   * Normalize a HypeDexer fill to the unified NormalizedFill shape.
   * px/sz are strings — parsed to numbers. Spot fills keep their pair id as
   * `coin` ("@107"); display names are resolved by the consumer.
   */
  private normalizeFill(address: string, raw: HypeDexerFill): NormalizedFill {
    const px = parseFloat(raw.px);
    const sz = parseFloat(raw.sz);
    const fill = {
      oid: raw.oid,
      tid: raw.tid,
      wallet: address.toLowerCase(),
      coin: raw.coin,
      px,
      sz,
      notionalUsd: px * sz,
      side: raw.side,
      time: raw.time,
      hash: raw.hash,
      twapId: raw.twapId ?? null,
    };

    // Spot fills also carry a `dir` ("Buy"/"Sell") and a closedPnl, but alerts
    // show direction and realized PnL for perps only, as the former `fills_spot` feed did.
    if (HypeDexerLiveDataWSClient.isSpotCoin(raw.coin)) {
      return { source: 'spot', ...fill };
    }

    // closedPnl is a string in the HypeDexer schema; default to 0 if it parses to NaN.
    const closedPnlParsed = parseFloat(raw.closedPnl);
    const closedPnl = Number.isFinite(closedPnlParsed) ? closedPnlParsed : 0;
    return { source: 'perp', ...fill, dir: raw.dir, closedPnl };
  }

  /**
   * Handle connection state changes
   */
  private handleStateChange(state: WSConnectionState): void {
    logDeduplicator.info('HypeDexerLiveDataWSClient: State changed', { state });
    // 'connected' alone is not "ready": onOpen decides once both subscriptions are sent.
    if (state !== 'connected') this.setUpstreamConnected(false);
  }

  /** Record the upstream state and tell the listeners when it changed. */
  private setUpstreamConnected(connected: boolean): void {
    if (this.upstreamConnected === connected) return;

    const at = Date.now();
    this.upstreamConnected = connected;
    this.upstreamSince = connected ? at : null;
    for (const callback of this.connectionCallbacks) {
      try {
        callback(connected, at);
      } catch (error) {
        logDeduplicator.error('HypeDexerLiveDataWSClient: Connection callback error', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
