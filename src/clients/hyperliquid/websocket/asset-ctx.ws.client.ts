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
  /** Subscribe / unsubscribe messages still waiting for the pacing timer. */
  pending: number;
  framesLastMinute: number;
  /** Null until the first frame. */
  lastFrameAgeMs: number | null;
  healthy: { spot: boolean; perp: boolean };
}

interface AssetCtxFrame {
  channel?: string;
  data?: { coin?: unknown; ctx?: unknown };
}

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

  /** Coin (wire name) -> market that wants it. */
  private desired: Map<string, CtxMarket> = new Map();
  /** Coins subscribed on the current connection. */
  private sent: Set<string> = new Set();
  private toSubscribe: string[] = [];
  private toUnsubscribe: string[] = [];
  private drainTimer: NodeJS.Timeout | null = null;

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
          if (state !== 'connected') this.stopDrain();
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
      pending: this.toSubscribe.length + this.toUnsubscribe.length,
      framesLastMinute: frames,
      lastFrameAgeMs: this.lastFrameAt > 0 ? now - this.lastFrameAt : null,
      healthy: { spot: this.isHealthy('spot', now), perp: this.isHealthy('perp', now) },
    };
  }

  public stop(): void {
    this.desired.clear();
    this.sent.clear();
    this.toSubscribe = [];
    this.toUnsubscribe = [];
    this.live.spot.clear();
    this.live.perp.clear();
    this.dirty = { spot: false, perp: false };
    this.lastFrameAt = 0;
    this.bucketSecond.fill(0);
    this.bucketCount.fill(0);
    this.stopDrain();
    this.disconnect();
  }

  /** A new connection knows no subscription: ask for every wanted coin again, paced. */
  protected onOpen(): void {
    this.sent.clear();
    this.toUnsubscribe = [];
    this.toSubscribe = [...this.desired.keys()];
    this.scheduleDrain(0);
  }

  protected onMessage(data: unknown): void {
    const frame = data as AssetCtxFrame;
    const market = frame.channel ? CHANNEL_MARKET[frame.channel] : undefined;
    const coin = frame.data?.coin;
    const ctx = frame.data?.ctx;
    if (!market || typeof coin !== 'string' || typeof ctx !== 'object' || ctx === null) return;
    // A late frame of a coin that was just unsubscribed would grow the map for nothing.
    if (this.desired.get(coin) !== market) return;

    const now = Date.now();
    this.live[market].set(coin, { ctx: ctx as Record<string, unknown>, at: now });
    this.dirty[market] = true;
    this.lastFrameAt = now;
    this.countFrame(now);
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
