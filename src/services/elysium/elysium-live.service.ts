import { WebSocket } from 'ws';
import { logDeduplicator } from '../../utils/logDeduplicator';

/** A new Elysium mainnet block header, pushed live. */
export interface ElysiumLiveBlock {
  number: number;
  /** Unix seconds. */
  timestamp: number;
  gasUsed: number;
  gasLimit: number;
}

type BlocksListener = (blocks: ElysiumLiveBlock[]) => void;

/**
 * Streams Elysium mainnet new-block headers from the archive node's WebSocket
 * (eth_subscribe newHeads) and hands batches to listeners (the internal WS
 * server broadcasts them to subscribed browsers).
 *
 * The archive WS is keyed (the key is in its URL), so this runs server-side
 * only. The chain makes ~9 blocks/s, so headers are coalesced into one batch
 * per FLUSH_MS instead of a per-block firehose. A dropped socket reconnects
 * with backoff; every callback and frame is guarded so a bad frame or a slow
 * listener can never take the process down.
 *
 * A socket that is open is not a stream that works: the handshake has a time
 * limit, the node's answer to the subscription is read, and a socket that
 * gives no block for SILENCE_MS is closed and opened again. Before, it could
 * stay open and silent until the next restart, with nothing to see. The
 * backoff starts over once a socket has given blocks for a while, not when it
 * opens nor at its first block: a node that accepts and then closes (or gives
 * one block and closes) was reconnected to every second, for ever.
 */
export class ElysiumLiveService {
  private static instance: ElysiumLiveService;

  private ws: WebSocket | null = null;
  private readonly pending = new Map<number, ElysiumLiveBlock>();
  private flushTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly listeners: BlocksListener[] = [];
  private stopped = false;
  private reconnectAttempts = 0;
  private watchdog: NodeJS.Timeout | null = null;
  /** When the current socket last gave a block (or was opened). */
  private lastBlockAt = 0;
  /** When the current socket was opened. */
  private openedAt = 0;

  /** One push per second: ~9 blocks batched, not 9 messages. */
  private readonly FLUSH_MS = 1000;
  private readonly MAX_RECONNECT_DELAY_MS = 30_000;
  /** Headers kept between flushes if listeners are briefly slow. */
  private readonly MAX_PENDING = 200;
  /** The longest the handshake may take. */
  private readonly HANDSHAKE_TIMEOUT_MS = 10_000;
  /** No block for this long on an open socket: it is closed and opened again (the chain makes ~9 blocks a second). */
  private readonly SILENCE_MS = 15_000;
  /** A socket that has given blocks for this long works: the next reconnection starts from the short wait again. */
  private readonly HEALTHY_MS = 30_000;

  public static getInstance(): ElysiumLiveService {
    if (!ElysiumLiveService.instance) {
      ElysiumLiveService.instance = new ElysiumLiveService();
    }
    return ElysiumLiveService.instance;
  }

  /** wss URL from an explicit override, else derived from the keyed RPC URL. */
  private wsUrl(): string | null {
    const explicit = process.env.ELYSIUM_MAINNET_WS_URL?.trim();
    if (explicit) return explicit;
    const rpc = process.env.ELYSIUM_MAINNET_RPC_URL?.trim();
    // https://host/path → wss://host/path (same key in the path), http → ws.
    return rpc ? rpc.replace(/^http/i, 'ws') : null;
  }

  public isConfigured(): boolean {
    return this.wsUrl() !== null;
  }

  public onBlocks(listener: BlocksListener): void {
    this.listeners.push(listener);
  }

  public start(): void {
    this.stopped = false;
    if (!this.wsUrl()) {
      logDeduplicator.info('ElysiumLiveService: no mainnet WS configured, live blocks disabled');
      return;
    }
    this.connect();
    if (!this.flushTimer) {
      this.flushTimer = setInterval(() => this.flush(), this.FLUSH_MS);
    }
  }

  private connect(): void {
    const url = this.wsUrl();
    if (!url || this.stopped || this.ws) return;

    let ws: WebSocket;
    try {
      ws = new WebSocket(url, { handshakeTimeout: this.HANDSHAKE_TIMEOUT_MS });
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      // A socket this service has let go of (stopped, then started again) is not its socket any more.
      if (this.ws !== ws) return;
      try {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['newHeads'] }));
      } catch {
        /* close/error will fire and reconnect */
      }
      this.watch(ws);
      logDeduplicator.info('ElysiumLiveService: mainnet WS connected');
    });
    ws.on('message', (data) => this.onMessage(ws, data.toString()));
    // An 'error' with no listener is an uncaughtException: this handler keeps it contained.
    ws.on('error', (error) => {
      logDeduplicator.warn('ElysiumLiveService: WS error', {
        error: error instanceof Error ? error.message : 'unknown',
      });
    });
    ws.on('close', () => {
      // The 'close' of a socket let go of earlier can arrive after another one was opened: it
      // must neither stop that one's watchdog nor open a third.
      if (this.ws !== ws) return;
      this.ws = null;
      this.unwatch();
      if (!this.stopped) this.scheduleReconnect();
    });
  }

  /** Closes `ws` when it has given no block for SILENCE_MS; its 'close' then opens another. */
  private watch(ws: WebSocket): void {
    this.unwatch();
    this.lastBlockAt = Date.now();
    this.openedAt = this.lastBlockAt;
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastBlockAt < this.SILENCE_MS) return;
      logDeduplicator.warn('ElysiumLiveService: no block on an open socket, reconnecting', {
        silentForS: Math.round((Date.now() - this.lastBlockAt) / 1000),
      });
      this.drop(ws);
    }, 5_000);
    this.watchdog.unref?.();
  }

  private unwatch(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
  }

  /** Ends a socket that is of no use, without waiting for the other side. */
  private drop(ws: WebSocket): void {
    try {
      ws.terminate();
    } catch {
      /* already gone */
    }
  }

  private onMessage(ws: WebSocket, raw: string): void {
    if (this.ws !== ws) return;
    try {
      const msg = JSON.parse(raw) as {
        id?: number;
        error?: { message?: string };
        method?: string;
        params?: { result?: { number?: string; timestamp?: string; gasUsed?: string; gasLimit?: string } };
      };
      // The node's answer to the subscription: refused, this socket will never give a block.
      if (msg.id === 1 && msg.error) {
        logDeduplicator.warn('ElysiumLiveService: subscription refused', { error: String(msg.error.message ?? 'unknown').slice(0, 120) });
        this.drop(ws);
        return;
      }
      if (msg.method !== 'eth_subscription') return;
      const h = msg.params?.result;
      if (!h?.number) return;
      const number = parseInt(h.number, 16);
      if (!Number.isFinite(number)) return;
      this.lastBlockAt = Date.now();
      // Blocks for a while: the stream works, so the next reconnection starts from the short wait again.
      if (this.lastBlockAt - this.openedAt >= this.HEALTHY_MS) this.reconnectAttempts = 0;
      this.pending.set(number, {
        number,
        timestamp: parseInt(h.timestamp ?? '0x0', 16) || 0,
        gasUsed: parseInt(h.gasUsed ?? '0x0', 16) || 0,
        gasLimit: parseInt(h.gasLimit ?? '0x0', 16) || 0,
      });
      if (this.pending.size > this.MAX_PENDING) {
        const oldest = Math.min(...this.pending.keys());
        this.pending.delete(oldest);
      }
    } catch {
      /* a malformed frame is ignored */
    }
  }

  private flush(): void {
    if (this.pending.size === 0 || this.listeners.length === 0) {
      this.pending.clear();
      return;
    }
    const blocks = [...this.pending.values()].sort((a, b) => b.number - a.number);
    this.pending.clear();
    for (const listener of this.listeners) {
      try {
        listener(blocks);
      } catch (error) {
        logDeduplicator.warn('ElysiumLiveService: listener error', {
          error: error instanceof Error ? error.message : 'unknown',
        });
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    // Between 80% and 120% of the step, so several processes do not come back together.
    const step = Math.min(1000 * 2 ** this.reconnectAttempts, this.MAX_RECONNECT_DELAY_MS);
    const delay = Math.round(step * (0.8 + Math.random() * 0.4));
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  public stop(): void {
    this.stopped = true;
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.unwatch();
    this.flushTimer = null;
    this.reconnectTimer = null;
    try {
      this.ws?.close();
    } catch {
      /* already closing */
    }
    this.ws = null;
  }
}
