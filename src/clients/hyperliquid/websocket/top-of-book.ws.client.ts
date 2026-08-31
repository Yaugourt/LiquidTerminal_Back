import { BaseWebSocketService } from '../../../core/base.websocket.service';
import { logDeduplicator } from '../../../utils/logDeduplicator';
import { WSConnectionState } from '../../../types/websocket.types';

/** Best bid / best ask for one coin, straight from Hyperliquid. */
export interface TopOfBook {
  bid: number | null;
  ask: number | null;
  time: number;
}

interface HyperliquidL2Frame {
  channel?: string;
  data?: {
    coin?: string;
    time?: number;
    levels?: [{ px: string }[], { px: string }[]];
  };
}

/**
 * Hyperliquid's public `l2Book` stream, used only for the touch.
 *
 * This is the authority on where a book actually starts. It is keyless, tiny
 * (~1.5 KB a frame) and multiplexes every coin over one socket, which makes it
 * the cheap way to keep the L4 mirror honest: the L4 delta stream does not
 * announce every departing order, so its top of book grows phantom levels that
 * only a known-good best bid/ask can identify.
 *
 * It carries perps, spot (`@107`, `PURR/USDC`) and HIP-3 tickers, but not
 * HIP-4 outcome coins (`#NNN`) — those simply get no touch, and the L4 book
 * falls back to periodic resync alone.
 */
export class HyperliquidTopOfBookWSClient extends BaseWebSocketService {
  private static instance: HyperliquidTopOfBookWSClient;

  private static readonly WS_URL =
    process.env.HYPERLIQUID_WS_URL || 'wss://api.hyperliquid.xyz/ws';

  /** Normalized coin → wire id. */
  private desired: Map<string, string> = new Map();
  /** Normalized coin → latest touch. */
  private touches: Map<string, TopOfBook> = new Map();

  private constructor() {
    super(
      {
        url: HyperliquidTopOfBookWSClient.WS_URL,
        reconnect: true,
        reconnectInterval: 3000,
        reconnectMaxInterval: 60000,
        reconnectMaxAttempts: 0,
        pingInterval: 30000,
        pingTimeout: 10000,
      },
      {
        onStateChange: (state: WSConnectionState) =>
          logDeduplicator.info('HyperliquidTopOfBookWSClient: state', {
            state,
            coins: this.desired.size,
          }),
      }
    );
  }

  public static getInstance(): HyperliquidTopOfBookWSClient {
    if (!HyperliquidTopOfBookWSClient.instance) {
      HyperliquidTopOfBookWSClient.instance = new HyperliquidTopOfBookWSClient();
    }
    return HyperliquidTopOfBookWSClient.instance;
  }

  private static key(coin: string): string {
    return coin.trim().toLowerCase();
  }

  public subscribeCoin(coin: string): void {
    const key = HyperliquidTopOfBookWSClient.key(coin);
    if (this.desired.has(key)) return;
    this.desired.set(key, coin);

    if (this.isConnected()) {
      this.sendSubscribe(coin);
      return;
    }
    if (this.getState() !== 'connecting' && this.getState() !== 'reconnecting') {
      this.connect();
    }
  }

  public unsubscribeCoin(coin: string): void {
    const key = HyperliquidTopOfBookWSClient.key(coin);
    const wireCoin = this.desired.get(key);
    if (!wireCoin) return;

    this.desired.delete(key);
    this.touches.delete(key);

    if (this.isConnected()) {
      this.send({ method: 'unsubscribe', subscription: { type: 'l2Book', coin: wireCoin } });
    }
    if (this.desired.size === 0) this.disconnect();
  }

  /**
   * Latest touch for a coin, or `null` when none has arrived — which is normal
   * for coins Hyperliquid's shared stream does not carry.
   */
  public getTouch(coin: string): TopOfBook | null {
    return this.touches.get(HyperliquidTopOfBookWSClient.key(coin)) ?? null;
  }

  public stop(): void {
    this.desired.clear();
    this.touches.clear();
    this.disconnect();
  }

  protected onOpen(): void {
    for (const wireCoin of this.desired.values()) this.sendSubscribe(wireCoin);
  }

  protected onMessage(data: unknown): void {
    const frame = data as HyperliquidL2Frame;
    if (frame.channel !== 'l2Book' || !frame.data?.coin || !frame.data.levels) return;

    const [bids, asks] = frame.data.levels;
    const bid = bids?.[0] ? parseFloat(bids[0].px) : null;
    const ask = asks?.[0] ? parseFloat(asks[0].px) : null;

    this.touches.set(HyperliquidTopOfBookWSClient.key(frame.data.coin), {
      bid: Number.isFinite(bid as number) ? bid : null,
      ask: Number.isFinite(ask as number) ? ask : null,
      time: frame.data.time ?? Date.now(),
    });
  }

  private sendSubscribe(coin: string): void {
    this.send({ method: 'subscribe', subscription: { type: 'l2Book', coin } });
  }
}
