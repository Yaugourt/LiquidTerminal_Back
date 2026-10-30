import WebSocket from 'ws';
import { BaseWebSocketService } from '../../../core/base.websocket.service';
import { logDeduplicator } from '../../../utils/logDeduplicator';
import { WSConnectionState } from '../../../types/websocket.types';

export type CtxMarket = 'spot' | 'perp';

/** The latest context Hyperliquid pushed for one coin, and when it arrived here. */
export interface LiveCtx {
  ctx: Record<string, unknown>;
  at: number;
}

export interface AssetCtxStreamStats {
  state: WSConnectionState;
  connected: boolean;
  /** Coins wanted, by market. */
  subscriptions: { spot: number; perp: number; total: number };
  /** Coins whose subscribe has gone out on the current connection. */
  subscribed: number;
  /** Coins Hyperliquid confirmed (subscriptionResponse or a first frame) on the current connection. */
  acknowledged: number;
  /** Error frames received since the last stop. */
  errorFrames: number;
  /** Recovery steps taken since the last stop. */
  recovery: { resends: number; forcedReconnects: number };
  /** Subscribe / unsubscribe messages still waiting for the pacing timer. */
  pending: number;
  framesLastMinute: number;
  /** Null until the first frame. */
  lastFrameAgeMs: number | null;
  healthy: { spot: boolean; perp: boolean };
}

interface AssetCtxFrame {
  channel?: string;
  data?: unknown;
}

/** What is left of Hyperliquid's error text once the coin is taken out: the dedupe key. */
const COIN_IN_TEXT = /"coin"\s*:\s*"([^"]+)"/;
const ERROR_LOG_WINDOW_MS = 60_000;
const MAX_ERROR_KEYS = 50;

/** Frame channel -> market: a perp answers on `activeAssetCtx`, a spot pair on `activeSpotAssetCtx`. */
const CHANNEL_MARKET: Record<string, CtxMarket> = {
  activeAssetCtx: 'perp',
  activeSpotAssetCtx: 'spot',
};

/**
 * Hyperliquid's public `activeAssetCtx` stream for the spot pairs and the live
 * perps, on one socket: the same context fields `spotMetaAndAssetCtxs` and
 * `metaAndAssetCtxs` return, pushed about 46 times a minute per coin instead
 * of read every 10 s at weight 20.
 *
 * It only keeps the latest context per coin and says which market changed; the
 * pollers (spot / perp assetcontext clients) merge it into their last REST
 * read and write Redis. Hyperliquid's per-IP limits are 1,000 subscriptions and
 * 2,000 client messages a minute across connections: subscribes are paced at
 * 20 a second (1,200 a minute at most, whatever the reconnect loop does) and
 * everything is subscribed again after a reconnect.
 *
 * A subscribe leaving is not a subscribe accepted: Hyperliquid answers each one
 * with a `subscriptionResponse` or an `error` frame (over the 1,000-per-IP
 * limit, which two instances sharing an egress IP reach during a deploy). The
 * acknowledgements are tracked per coin and a market that stays unhealthy with
 * the socket open is repaired: first the subscribes that were not acknowledged
 * or are not updating are sent again, then, if that did not help, the socket is
 * dropped and the reconnect loop starts over (at most once every 5 minutes).
 */
export class HyperliquidAssetCtxWSClient extends BaseWebSocketService {
  private static instance: HyperliquidAssetCtxWSClient;

  private static readonly WS_URL =
    process.env.HYPERLIQUID_WS_URL || 'wss://api.hyperliquid.xyz/ws';

  /** One subscribe or unsubscribe every 50 ms: 20 a second. */
  public static readonly SEND_INTERVAL_MS = 50;
  /** No frame for this long: the stream is not healthy. */
  public static readonly MAX_FRAME_AGE_MS = 15_000;
  /** A coin counts as covered when it updated within this window. */
  public static readonly COVERAGE_WINDOW_MS = 30_000;
  /** Share of the subscribed coins that must be covered. */
  public static readonly MIN_COVERAGE = 0.8;
  /** Unhealthy this long with the socket open (and nothing left to send): subscribe again what is missing. */
  public static readonly RESEND_AFTER_MS = 60_000;
  /** Still unhealthy this long after that: drop the socket. */
  public static readonly RECONNECT_AFTER_RESEND_MS = 60_000;
  /** At most one forced reconnect in this window. */
  public static readonly MIN_FORCED_RECONNECT_GAP_MS = 5 * 60_000;
  /** How often the repair rules are looked at. */
  public static readonly RECOVERY_CHECK_MS = 5_000;

  /** Coin (wire name) -> market that wants it. */
  private desired: Map<string, CtxMarket> = new Map();
  /** Coins subscribed on the current connection. */
  private sent: Set<string> = new Set();
  private toSubscribe: string[] = [];
  private toUnsubscribe: string[] = [];
  private drainTimer: NodeJS.Timeout | null = null;

  /** Coins Hyperliquid confirmed on the current connection. */
  private acked: Set<string> = new Set();
  private errorFrames = 0;
  private errorLogs: Map<string, { at: number; suppressed: number }> = new Map();
  private recoveryTimer: NodeJS.Timeout | null = null;
  /** Since when each market has been unhealthy with nothing left to send (null: healthy or not wanted). */
  private unhealthySince: Record<CtxMarket, number | null> = { spot: null, perp: null };
  /** When the subscribes of each market were last sent again (null: not yet in this episode). */
  private resentAt: Record<CtxMarket, number | null> = { spot: null, perp: null };
  private resends = 0;
  private forcedReconnects = 0;
  private lastForcedReconnectAt = Number.NEGATIVE_INFINITY;

  private live: Record<CtxMarket, Map<string, LiveCtx>> = { spot: new Map(), perp: new Map() };
  private dirty: Record<CtxMarket, boolean> = { spot: false, perp: false };
  private lastFrameAt = 0;

  /** Frames per second over the last minute: bucket i holds the second `bucketSecond[i]`. */
  private bucketSecond = new Array<number>(60).fill(0);
  private bucketCount = new Array<number>(60).fill(0);

  private constructor() {
    super(
      {
        url: HyperliquidAssetCtxWSClient.WS_URL,
        reconnect: true,
        reconnectInterval: 3000,
        reconnectMaxInterval: 60000,
        reconnectMaxAttempts: 0,
        pingInterval: 30000,
        pingTimeout: 10000,
      },
      {
        onStateChange: (state: WSConnectionState) => {
          if (state !== 'connected') {
            this.stopDrain();
            this.stopRecovery();
          }
          logDeduplicator.info('HyperliquidAssetCtxWSClient: state', {
            state,
            coins: this.desired.size,
          });
        },
      }
    );
  }

  public static getInstance(): HyperliquidAssetCtxWSClient {
    if (!HyperliquidAssetCtxWSClient.instance) {
      HyperliquidAssetCtxWSClient.instance = new HyperliquidAssetCtxWSClient();
    }
    return HyperliquidAssetCtxWSClient.instance;
  }

  /**
   * Sets the coins one market wants: new coins are subscribed, coins that left
   * (a delisting) are unsubscribed and forgotten. The first call opens the
   * socket.
   */
  public setCoins(market: CtxMarket, coins: readonly string[]): void {
    const wanted = new Set(coins);
    // Offline there is nothing to queue: onOpen asks for every wanted coin.
    const online = this.isConnected();

    for (const [coin, owner] of this.desired) {
      if (owner !== market || wanted.has(coin)) continue;
      this.desired.delete(coin);
      this.live[market].delete(coin);
      this.acked.delete(coin);
      if (this.sent.delete(coin) && online) this.toUnsubscribe.push(coin);
    }
    for (const coin of wanted) {
      if (this.desired.has(coin)) continue;
      this.desired.set(coin, market);
      if (online) this.toSubscribe.push(coin);
    }

    if (this.desired.size === 0) {
      this.stop();
      return;
    }
    if (online) {
      this.scheduleDrain(0);
    } else if (this.getState() !== 'connecting' && this.getState() !== 'reconnecting') {
      this.connect();
    }
  }

  /** The latest context per coin of a market. Read only; entries leave with their coin. */
  public getLive(market: CtxMarket): ReadonlyMap<string, LiveCtx> {
    return this.live[market];
  }

  /** True once if the market received a frame since the last call. */
  public consumeDirty(market: CtxMarket): boolean {
    const was = this.dirty[market];
    this.dirty[market] = false;
    return was;
  }

  /**
   * Healthy: the socket is up, a frame came within 15 s, every coin of the
   * market has been subscribed (a few still queued after a new listing do not
   * count against it) and at least 80 % of the subscribed coins updated within
   * 30 s. A market with nothing subscribed is not healthy.
   */
  public isHealthy(market: CtxMarket, now: number = Date.now()): boolean {
    if (!this.isConnected()) return false;
    if (now - this.lastFrameAt > HyperliquidAssetCtxWSClient.MAX_FRAME_AGE_MS) return false;

    let wanted = 0;
    let sent = 0;
    let covered = 0;
    for (const [coin, owner] of this.desired) {
      if (owner !== market) continue;
      wanted++;
      if (!this.sent.has(coin)) continue;
      sent++;
      const at = this.live[market].get(coin)?.at;
      if (at !== undefined && now - at <= HyperliquidAssetCtxWSClient.COVERAGE_WINDOW_MS) covered++;
    }
    if (wanted === 0 || sent === 0) return false;
    const min = HyperliquidAssetCtxWSClient.MIN_COVERAGE;
    return sent >= min * wanted && covered >= min * sent;
  }

  public getStats(now: number = Date.now()): AssetCtxStreamStats {
    let spot = 0;
    let perp = 0;
    for (const owner of this.desired.values()) {
      if (owner === 'spot') spot++;
      else perp++;
    }
    const nowSecond = Math.floor(now / 1000);
    let frames = 0;
    for (let i = 0; i < 60; i++) {
      if (this.bucketSecond[i] > nowSecond - 60) frames += this.bucketCount[i];
    }
    return {
      state: this.getState(),
      connected: this.isConnected(),
      subscriptions: { spot, perp, total: spot + perp },
      subscribed: this.sent.size,
      acknowledged: this.acked.size,
      errorFrames: this.errorFrames,
      recovery: { resends: this.resends, forcedReconnects: this.forcedReconnects },
      pending: this.toSubscribe.length + this.toUnsubscribe.length,
      framesLastMinute: frames,
      lastFrameAgeMs: this.lastFrameAt > 0 ? now - this.lastFrameAt : null,
      healthy: { spot: this.isHealthy('spot', now), perp: this.isHealthy('perp', now) },
    };
  }

  public stop(): void {
    this.desired.clear();
    this.sent.clear();
    this.acked.clear();
    this.toSubscribe = [];
    this.toUnsubscribe = [];
    this.live.spot.clear();
    this.live.perp.clear();
    this.dirty = { spot: false, perp: false };
    this.lastFrameAt = 0;
    this.bucketSecond.fill(0);
    this.bucketCount.fill(0);
    this.errorFrames = 0;
    this.errorLogs.clear();
    this.resetRecovery();
    this.resends = 0;
    this.forcedReconnects = 0;
    this.lastForcedReconnectAt = Number.NEGATIVE_INFINITY;
    this.stopDrain();
    this.stopRecovery();

    // The base disconnect only closes an OPEN socket: one still connecting would
    // open later with its handlers on. Detach it and abort the handshake.
    const connecting = this.ws && this.ws.readyState === WebSocket.CONNECTING ? this.ws : null;
    this.disconnect();
    if (connecting) {
      connecting.removeAllListeners();
      connecting.on('error', () => undefined); // terminate() reports the aborted handshake as an error
      try {
        connecting.terminate();
      } catch (error) {
        logDeduplicator.warn('HyperliquidAssetCtxWSClient: terminate of a connecting socket failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /** A new connection knows no subscription: ask for every wanted coin again, paced. */
  protected onOpen(): void {
    this.sent.clear();
    this.acked.clear();
    this.toUnsubscribe = [];
    this.toSubscribe = [...this.desired.keys()];
    this.resetRecovery();
    this.scheduleDrain(0);
    this.startRecovery();
  }

  protected onMessage(data: unknown): void {
    const frame = data as AssetCtxFrame;
    if (frame.channel === 'subscriptionResponse') {
      this.onSubscriptionResponse(frame.data);
      return;
    }
    if (frame.channel === 'error') {
      this.onErrorFrame(frame.data);
      return;
    }

    const market = frame.channel ? CHANNEL_MARKET[frame.channel] : undefined;
    const payload = frame.data as { coin?: unknown; ctx?: unknown } | null | undefined;
    const coin = payload?.coin;
    const ctx = payload?.ctx;
    if (!market || typeof coin !== 'string' || typeof ctx !== 'object' || ctx === null) return;
    // A late frame of a coin that was just unsubscribed would grow the map for nothing.
    if (this.desired.get(coin) !== market) return;

    const now = Date.now();
    this.live[market].set(coin, { ctx: ctx as Record<string, unknown>, at: now });
    this.acked.add(coin); // a frame proves the subscription, whatever the response said
    this.dirty[market] = true;
    this.lastFrameAt = now;
    this.countFrame(now);
  }

  /** `{ method, subscription: { type, coin } }`: the answer to one of our subscribes. */
  private onSubscriptionResponse(data: unknown): void {
    const response = data as { method?: unknown; subscription?: { coin?: unknown } } | null | undefined;
    const coin = response?.subscription?.coin;
    if (response?.method !== 'subscribe' || typeof coin !== 'string') return;
    // Only the coins still wanted and sent on this connection count.
    if (this.desired.has(coin) && this.sent.has(coin)) this.acked.add(coin);
  }

  /**
   * `{ channel: 'error', data: '<text>' }`: an invalid subscription, one already
   * made, or the per-IP limit. Logged once a minute per kind of error (the coin
   * is not part of the kind: 400 refused coins are one line, with a count).
   * "Already subscribed" proves the subscription exists; any other error leaves
   * the coin unacknowledged, which the repair rules pick up.
   */
  private onErrorFrame(data: unknown): void {
    this.errorFrames++;
    const text = typeof data === 'string' ? data : JSON.stringify(data) ?? 'unknown';
    const coin = COIN_IN_TEXT.exec(text)?.[1];
    if (coin && /already subscribed/i.test(text) && this.desired.has(coin) && this.sent.has(coin)) {
      this.acked.add(coin);
    } else if (coin) {
      this.acked.delete(coin);
    }

    const key = text.replace(COIN_IN_TEXT, '"coin":"*"').slice(0, 200);
    const now = Date.now();
    const seen = this.errorLogs.get(key);
    if (seen && now - seen.at < ERROR_LOG_WINDOW_MS) {
      seen.suppressed++;
      return;
    }
    if (this.errorLogs.size >= MAX_ERROR_KEYS) this.errorLogs.clear();
    this.errorLogs.set(key, { at: now, suppressed: 0 });
    logDeduplicator.error('HyperliquidAssetCtxWSClient: Hyperliquid error frame', {
      message: text.slice(0, 300),
      coin,
      suppressedSincePrevious: seen?.suppressed ?? 0,
      acknowledged: this.acked.size,
      subscribed: this.sent.size,
    });
  }

  private countFrame(now: number): void {
    const second = Math.floor(now / 1000);
    const i = second % 60;
    if (this.bucketSecond[i] !== second) {
      this.bucketSecond[i] = second;
      this.bucketCount[i] = 0;
    }
    this.bucketCount[i]++;
  }

  private startRecovery(): void {
    this.stopRecovery();
    this.recoveryTimer = setInterval(() => {
      try {
        this.checkRecovery();
      } catch (error) {
        logDeduplicator.error('HyperliquidAssetCtxWSClient: recovery check failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, HyperliquidAssetCtxWSClient.RECOVERY_CHECK_MS);
  }

  private stopRecovery(): void {
    if (this.recoveryTimer) {
      clearInterval(this.recoveryTimer);
      this.recoveryTimer = null;
    }
  }

  private resetRecovery(): void {
    this.unhealthySince = { spot: null, perp: null };
    this.resentAt = { spot: null, perp: null };
  }

  /**
   * The repair rules, looked at every 5 s while the socket is open. A market
   * unhealthy for over 60 s with nothing left in the send queue (a queue still
   * draining explains a slow start): subscribe again the coins that were not
   * acknowledged or are not updating, paced like any subscribe. Still unhealthy
   * 60 s after that: drop the socket and let the reconnect loop run, at most
   * once every 5 minutes.
   */
  private checkRecovery(now: number = Date.now()): void {
    if (!this.isConnected()) return;
    const pending = this.toSubscribe.length > 0 || this.toUnsubscribe.length > 0;

    for (const market of ['spot', 'perp'] as const) {
      let wanted = 0;
      for (const owner of this.desired.values()) if (owner === market) wanted++;
      if (wanted === 0 || this.isHealthy(market, now)) {
        this.unhealthySince[market] = null;
        this.resentAt[market] = null;
        continue;
      }
      if (pending && this.resentAt[market] === null) {
        this.unhealthySince[market] = null; // the clock starts once the queue is empty
        continue;
      }
      const since = this.unhealthySince[market] ?? now;
      this.unhealthySince[market] = since;

      const resentAt = this.resentAt[market];
      if (resentAt === null) {
        if (now - since > HyperliquidAssetCtxWSClient.RESEND_AFTER_MS) this.resendMissing(market, now);
      } else if (now - resentAt > HyperliquidAssetCtxWSClient.RECONNECT_AFTER_RESEND_MS && !pending) {
        this.forceReconnect(market, now);
      }
    }
  }

  private resendMissing(market: CtxMarket, now: number): void {
    const queued = new Set(this.toSubscribe);
    let resent = 0;
    let silent = 0;
    for (const [coin, owner] of this.desired) {
      if (owner !== market || queued.has(coin)) continue;
      const at = this.live[market].get(coin)?.at;
      const updating = at !== undefined && now - at <= HyperliquidAssetCtxWSClient.COVERAGE_WINDOW_MS;
      if (this.acked.has(coin) && updating) continue;
      if (!this.acked.has(coin)) silent++;
      this.sent.delete(coin);
      this.acked.delete(coin);
      this.toSubscribe.push(coin);
      resent++;
    }
    this.resentAt[market] = now;
    this.resends++;
    logDeduplicator.warn(`HyperliquidAssetCtxWSClient: ${market} stream unhealthy, subscribing again`, {
      resent,
      notAcknowledged: silent,
      errorFrames: this.errorFrames,
    });
    this.scheduleDrain(0);
  }

  private forceReconnect(market: CtxMarket, now: number): void {
    if (now - this.lastForcedReconnectAt < HyperliquidAssetCtxWSClient.MIN_FORCED_RECONNECT_GAP_MS) return;
    this.lastForcedReconnectAt = now;
    this.forcedReconnects++;
    logDeduplicator.warn(`HyperliquidAssetCtxWSClient: ${market} stream still unhealthy after subscribing again, reconnecting`, {
      errorFrames: this.errorFrames,
      acknowledged: this.acked.size,
    });
    this.resetRecovery();
    this.ws?.terminate(); // the close handler runs the reconnect loop
  }

  private scheduleDrain(delayMs: number): void {
    if (this.drainTimer || !this.isConnected()) return;
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      this.drainOne();
    }, delayMs);
  }

  private stopDrain(): void {
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
  }

  /** Sends the next queued message, then waits SEND_INTERVAL_MS before the one after. */
  private drainOne(): void {
    if (!this.isConnected()) return;

    let sentOne = false;
    while (!sentOne && (this.toUnsubscribe.length > 0 || this.toSubscribe.length > 0)) {
      if (this.toUnsubscribe.length > 0) {
        const coin = this.toUnsubscribe.shift() as string;
        // Wanted again since it was dropped: still subscribed upstream, nothing to send.
        if (this.desired.has(coin)) {
          this.sent.add(coin);
          continue;
        }
        sentOne = this.send({ method: 'unsubscribe', subscription: { type: 'activeAssetCtx', coin } });
      } else {
        const coin = this.toSubscribe.shift() as string;
        if (!this.desired.has(coin) || this.sent.has(coin)) continue;
        sentOne = this.send({ method: 'subscribe', subscription: { type: 'activeAssetCtx', coin } });
        if (sentOne) this.sent.add(coin);
      }
      if (!sentOne) return; // socket gone: onOpen starts over
    }

    if (this.toUnsubscribe.length > 0 || this.toSubscribe.length > 0) {
      this.scheduleDrain(HyperliquidAssetCtxWSClient.SEND_INTERVAL_MS);
    }
  }
}
