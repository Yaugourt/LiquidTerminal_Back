import { BaseWebSocketService } from '../../../core/base.websocket.service';
import { logDeduplicator } from '../../../utils/logDeduplicator';
import { WSConnectionState } from '../../../types/websocket.types';
import {
  HypeDexerL4Order,
  HypeDexerL4OrderDiff,
  HypeDexerL4SnapshotFrame,
  HypeDexerL4UpdatesFrame,
} from '../../../types/l4book.types';

export type L4SnapshotCallback = (coin: string, orders: [HypeDexerL4Order[], HypeDexerL4Order[]]) => void;
export type L4UpdatesCallback = (coin: string, time: number, diffs: HypeDexerL4OrderDiff[]) => void;

/**
 * HypeDexer L4 book WebSocket client.
 *
 * One socket, multiplexed across every coin someone is currently watching —
 * the mirror endpoint accepts many `l4Book` subscriptions on a single
 * connection, so we never open more than one upstream regardless of traffic.
 *
 * Connection is lazy: it opens on the first `subscribeCoin` and closes once the
 * last coin is dropped, so an idle deployment holds no upstream socket.
 *
 * Coin identifiers are used verbatim on the wire but routed case-insensitively:
 * HIP-3 tickers are echoed back upper-cased (`xyz:SKHX` → `XYZ:SKHX`) while
 * perps, spot indexes (`@107`) and HIP-4 outcomes (`#10250`) come back as sent.
 */
export class HypeDexerL4BookWSClient extends BaseWebSocketService {
  private static instance: HypeDexerL4BookWSClient;

  private static readonly WS_URL =
    process.env.HYPEDEXER_LIVEDATA_WS_URL || 'wss://api.hypedexer.com/ws?mode=mirror';
  private static readonly API_KEY = process.env.HL_INDEXER_API_KEY || '';

  /**
   * A full L4 snapshot is far larger than any other frame we consume — HYPE is
   * ~1.4 MB of JSON, BTC ~1.2 MB. The base service drops anything above
   * `maxBufferSize`, so it has to be raised well past the biggest book.
   */
  private static readonly MAX_FRAME_BYTES = 32 * 1024 * 1024;

  /** Coins we want subscribed upstream, keyed by normalized id → wire id. */
  private desired: Map<string, string> = new Map();

  private snapshotCallbacks: Set<L4SnapshotCallback> = new Set();
  private updatesCallbacks: Set<L4UpdatesCallback> = new Set();

  private constructor() {
    super(
      {
        url: HypeDexerL4BookWSClient.WS_URL,
        headers: { 'X-API-Key': HypeDexerL4BookWSClient.API_KEY },
        reconnect: true,
        reconnectInterval: 3000,
        reconnectMaxInterval: 60000,
        // 0 = infinite; a book feed must survive upstream restarts.
        reconnectMaxAttempts: 0,
        pingInterval: 30000,
        pingTimeout: 10000,
        maxBufferSize: HypeDexerL4BookWSClient.MAX_FRAME_BYTES,
      },
      {
        onStateChange: (state: WSConnectionState) => {
          logDeduplicator.info('HypeDexerL4BookWSClient: state', { state, coins: this.desired.size });
        },
      }
    );
  }

  public static getInstance(): HypeDexerL4BookWSClient {
    if (!HypeDexerL4BookWSClient.instance) {
      HypeDexerL4BookWSClient.instance = new HypeDexerL4BookWSClient();
    }
    return HypeDexerL4BookWSClient.instance;
  }

  /** Normalized routing key — see the class note on HIP-3 case echoing. */
  public static normalizeCoin(coin: string): string {
    return coin.trim().toLowerCase();
  }

  /**
   * Subscribe upstream to a coin's book. Idempotent; opens the socket if this
   * is the first coin.
   */
  public subscribeCoin(coin: string): void {
    const key = HypeDexerL4BookWSClient.normalizeCoin(coin);
    if (this.desired.has(key)) return;

    this.desired.set(key, coin);

    // While the socket is still coming up, `onOpen` replays the whole desired
    // set — sending now would just be dropped as "not connected".
    if (this.isConnected()) {
      this.sendSubscribe(coin);
      return;
    }
    if (this.getState() !== 'connecting' && this.getState() !== 'reconnecting') {
      this.connect();
    }
  }

  /**
   * Drop a coin's upstream subscription. Closes the socket once nothing is left
   * to watch.
   */
  public unsubscribeCoin(coin: string): void {
    const key = HypeDexerL4BookWSClient.normalizeCoin(coin);
    const wireCoin = this.desired.get(key);
    if (!wireCoin) return;

    this.desired.delete(key);

    if (this.isConnected()) {
      this.send({ method: 'unsubscribe', subscription: { type: 'l4Book', coin: wireCoin } });
    }

    if (this.desired.size === 0) {
      logDeduplicator.info('HypeDexerL4BookWSClient: no coins left, closing upstream');
      this.disconnect();
    }
  }

  /**
   * Ask upstream for a fresh snapshot of a coin already being watched.
   *
   * Necessary because the `l4Book` delta stream is lossy: orders can leave the
   * book with no `remove` diff (measured 2026-08-07 on HYPE — 10 of 10 resting
   * asks the price traded through were never announced), so a purely
   * incremental book drifts. Re-sending `subscribe` for a live subscription
   * makes the mirror re-send the snapshot without dropping the stream.
   */
  public resyncCoin(coin: string): void {
    const key = HypeDexerL4BookWSClient.normalizeCoin(coin);
    const wireCoin = this.desired.get(key);
    if (!wireCoin || !this.isConnected()) return;
    this.sendSubscribe(wireCoin);
  }

  public onSnapshot(cb: L4SnapshotCallback): () => void {
    this.snapshotCallbacks.add(cb);
    return () => this.snapshotCallbacks.delete(cb);
  }

  public onUpdates(cb: L4UpdatesCallback): () => void {
    this.updatesCallbacks.add(cb);
    return () => this.updatesCallbacks.delete(cb);
  }

  public getStats(): { state: WSConnectionState; coins: string[] } {
    return { state: this.getState(), coins: [...this.desired.values()] };
  }

  /** Test seam / shutdown: drop everything and close. */
  public stop(): void {
    this.desired.clear();
    this.snapshotCallbacks.clear();
    this.updatesCallbacks.clear();
    this.disconnect();
  }

  // ==========================================================================
  // BaseWebSocketService hooks
  // ==========================================================================

  protected onOpen(): void {
    // Replay every wanted subscription — this covers both the initial connect
    // and every reconnect, where upstream state is gone.
    for (const wireCoin of this.desired.values()) {
      this.sendSubscribe(wireCoin);
    }
    logDeduplicator.info('HypeDexerL4BookWSClient: connected, subscriptions replayed', {
      coins: this.desired.size,
    });
  }

  protected onMessage(data: unknown): void {
    const frame = data as Partial<HypeDexerL4SnapshotFrame & HypeDexerL4UpdatesFrame> & {
      type?: string;
      channel?: string;
      data?: unknown;
      message?: string;
    };

    // Acks and errors carry `type`/`channel` instead of a book payload.
    if (frame.type === 'subscriptionUpdate' || frame.channel === 'subscriptionResponse') return;
    if (frame.type === 'error') {
      logDeduplicator.error('HypeDexerL4BookWSClient: upstream error', {
        message: frame.message ?? 'unknown',
      });
      return;
    }
    if (frame.type === 'ping') {
      this.send({ type: 'pong' });
      return;
    }

    // Book frames arrive either bare or wrapped in `data` depending on the
    // upstream build; accept both.
    const payload = (frame.data ?? frame) as Partial<
      HypeDexerL4SnapshotFrame & HypeDexerL4UpdatesFrame
    >;

    if (payload.snapshot) {
      const { coin, levels } = payload.snapshot;
      if (!coin || !Array.isArray(levels) || levels.length < 2) return;
      for (const cb of this.snapshotCallbacks) {
        cb(coin, [levels[0] ?? [], levels[1] ?? []]);
      }
      return;
    }

    if (payload.updates) {
      const { coin, time, updates } = payload.updates;
      if (!coin || !Array.isArray(updates)) return;
      for (const cb of this.updatesCallbacks) {
        cb(coin, time ?? Date.now(), updates);
      }
    }
  }

  // ==========================================================================
  // PRIVATE
  // ==========================================================================

  private sendSubscribe(coin: string): void {
    this.send({ method: 'subscribe', subscription: { type: 'l4Book', coin } });
  }
}
