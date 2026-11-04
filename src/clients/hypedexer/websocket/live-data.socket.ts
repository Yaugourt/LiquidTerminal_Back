import { BaseWebSocketService } from '../../../core/base.websocket.service';
import { logDeduplicator } from '../../../utils/logDeduplicator';
import { WSConnectionState } from '../../../types/websocket.types';
import {
  HypeDexerFill,
  HypeDexerAllFillsEvent,
  NormalizedFill,
} from '../../../types/fill-alerts.types';
import { HypeDexerTwapStatusEvent, TwapStatusEvent } from '../../../types/twap-live.types';

/** What one socket hands to the client that owns it. */
export interface LiveDataSocketListener {
  /** Live fills, normalized. The snapshot replayed on subscribe is skipped. */
  onFills(fills: NormalizedFill[]): void;
  /** TWAP status events, those of the subscribe snapshot flagged `isSnapshot`. */
  onTwapStatuses(events: TwapStatusEvent[]): void;
  /**
   * Ready once the socket is open and both subscriptions are sent; not ready
   * as soon as it closes, errors or starts reconnecting. `at` is when it changed (epoch ms).
   */
  onReadyChange(ready: boolean, at: number): void;
}

export interface LiveDataSocketOptions {
  url: string;
  apiKey: string;
}

/**
 * One socket to HypeDexer's live-data (mirror) endpoint
 * (wss://api.hypedexer.com/ws?mode=mirror), subscribed to `allFills` and
 * `allTwapStatusUpdates`. HypeDexerLiveDataWSClient runs several of them and
 * merges what they receive; this class only connects, subscribes, parses and
 * reports. It reconnects by itself (5 s, doubling up to 60 s).
 *
 * `allFills` carries every fill, market-wide — native perps ("BTC"), HIP-3
 * perps ("xyz:GOLD"), HIP-4 outcomes ("#123") and spot ("@107"). HypeDexer
 * dropped its separate `fills_spot` channel (2026-09), so spot fills are told
 * apart here and normalized with `source: 'spot'`.
 *
 * Live-data messages are discriminated by `channel` (NOT `type`), except the
 * heartbeat: `{type:'ping'}` / `{type:'pong'}`.
 *
 * `allTwapStatusUpdates`: TWAP status events (activated / finished /
 * terminated, ~20 a minute), a snapshot of the latest 200 on subscribe and
 * live frames after. It never reports failed TWAPs.
 */
export class HypeDexerLiveDataSocket extends BaseWebSocketService {
  private ready = false;

  public constructor(
    private readonly slot: number,
    private readonly listener: LiveDataSocketListener,
    options: LiveDataSocketOptions,
  ) {
    super(
      {
        url: options.url,
        headers: {
          'X-API-Key': options.apiKey,
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
        onError: () => this.setReady(false),
        onReconnect: (attempt: number) => {
          // Emit one degraded-signal error log when consecutive failures cross 10.
          if (attempt === 10) {
            logDeduplicator.error(`${this.logName}: degraded — 10 consecutive reconnect attempts; continuing with exponential backoff`);
          }
        },
      }
    );
  }

  /** Railway logs keep the client's name, with the socket's number. */
  protected get logName(): string {
    return `HypeDexerLiveDataWSClient#${this.slot}`;
  }

  /** Open the socket (it subscribes on open and reconnects on its own). */
  public start(): void {
    this.connect();
  }

  /** Close the socket for good; it reports not ready. */
  public stop(): void {
    this.disconnect();
    this.setReady(false);
  }

  /** Open with both subscriptions sent. */
  public isReady(): boolean {
    return this.ready;
  }

  // ============================================================================
  // PROTECTED METHODS - Override from BaseWebSocketService
  // ============================================================================

  /**
   * Called when connection is established — subscribe to allFills and allTwapStatusUpdates
   */
  protected onOpen(): void {
    logDeduplicator.info(`${this.logName}: Connection opened`);
    const fillsSent = this.send({ method: 'subscribe', subscription: { type: 'allFills' } });
    const twapsSent = this.send({ method: 'subscribe', subscription: { type: 'allTwapStatusUpdates' } });
    logDeduplicator.info(`${this.logName}: Subscriptions sent (allFills, allTwapStatusUpdates)`);
    this.setReady(fillsSent && twapsSent);
  }

  /**
   * Called when a message is received
   */
  protected onMessage(data: unknown): void {
    // Defensive guard: base service should already filter non-object payloads,
    // but Hypedexer occasionally emits non-JSON / malformed frames (known upstream bug).
    if (typeof data !== 'object' || data === null) {
      logDeduplicator.warn(`${this.logName}: non-object ws message dropped`, {
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
          logDeduplicator.info(`${this.logName}: Subscription acknowledged`);
          break;

        case 'error':
          logDeduplicator.error(`${this.logName}: Server error`, {
            message: (event as { message?: string }).message,
          });
          break;

        default:
          if (event.channel === undefined && event.type === undefined) {
            logDeduplicator.warn(`${this.logName}: message without channel/type dropped`);
          } else {
            logDeduplicator.warn(`${this.logName}: Unknown channel`, {
              channel: event.channel,
              type: event.type,
            });
          }
      }
    } catch (error) {
      logDeduplicator.error(`${this.logName}: Message handling error`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ============================================================================
  // PRIVATE METHODS
  // ============================================================================

  /**
   * Handle `allFills` channel event — normalize and hand over
   */
  private handleAllFillsEvent(event: HypeDexerAllFillsEvent): void {
    const data = event.data;
    if (!data || !Array.isArray(data.fills) || data.fills.length === 0) return;

    // Skip the one-shot historical snapshot replayed on (re)subscribe — those
    // fills are old and must not be broadcast as fresh alerts.
    if (data.isSnapshot === true) {
      logDeduplicator.info(`${this.logName}: allFills snapshot skipped`, {
        count: data.fills.length,
      });
      return;
    }

    const normalized = data.fills.map((entry) => HypeDexerLiveDataSocket.normalizeFill(entry.address, entry.fill));
    try {
      this.listener.onFills(normalized);
    } catch (error) {
      logDeduplicator.error(`${this.logName}: Fill listener error`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Handle `allTwapStatusUpdates` channel event — parse both frame shapes
   * (snapshot object, live array) and hand over the valid events.
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
      const parsed = HypeDexerLiveDataSocket.parseTwapStatus(raw, isSnapshot);
      if (parsed) events.push(parsed);
      else malformed++;
    }
    if (malformed > 0) {
      logDeduplicator.warn(`${this.logName}: malformed allTwapStatusUpdates event dropped`, {
        count: malformed,
      });
    }
    if (events.length === 0) return;

    try {
      this.listener.onTwapStatuses(events);
    } catch (error) {
      logDeduplicator.error(`${this.logName}: TWAP status listener error`, {
        error: error instanceof Error ? error.message : String(error),
      });
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

    const twapId = HypeDexerLiveDataSocket.toNumber(e.twapId);
    const time = HypeDexerLiveDataSocket.toNumber(e.time);
    const sz = HypeDexerLiveDataSocket.toNumber(s.sz);
    const executedSz = HypeDexerLiveDataSocket.toNumber(s.executedSz);
    const executedNtl = HypeDexerLiveDataSocket.toNumber(s.executedNtl);
    const minutes = HypeDexerLiveDataSocket.toNumber(s.minutes);
    const startTime = HypeDexerLiveDataSocket.toNumber(s.timestamp);
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
  private static normalizeFill(address: string, raw: HypeDexerFill): NormalizedFill {
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
    if (HypeDexerLiveDataSocket.isSpotCoin(raw.coin)) {
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
    logDeduplicator.info(`${this.logName}: State changed`, { state });
    // 'connected' alone is not "ready": onOpen decides once both subscriptions are sent.
    if (state !== 'connected') this.setReady(false);
  }

  /** Record readiness and tell the owner when it changed. */
  private setReady(ready: boolean): void {
    if (this.ready === ready) return;
    this.ready = ready;
    try {
      this.listener.onReadyChange(ready, Date.now());
    } catch (error) {
      logDeduplicator.error(`${this.logName}: Ready listener error`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
