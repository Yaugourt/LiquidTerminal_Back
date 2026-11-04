import { logDeduplicator } from '../../../utils/logDeduplicator';
import { RecentKeys } from '../../../utils/recent-keys';
import { WSConnectionState } from '../../../types/websocket.types';
import { NormalizedFill } from '../../../types/fill-alerts.types';
import { TwapStatusEvent } from '../../../types/twap-live.types';
import { HypeDexerLiveDataSocket, LiveDataSocketListener } from './live-data.socket';

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
 * Callback type for the upstream connection: `connected` while a socket is
 * open with both subscriptions sent and the stream has no known gap, false
 * when that ends. `at` is when it changed (epoch ms).
 */
export type ConnectionCallback = (connected: boolean, at: number) => void;

/** What the client needs from one socket (tests pass fakes). */
export interface LiveDataSocketHandle {
  start(): void;
  stop(): void;
  getState(): WSConnectionState;
}

/** Production code uses getInstance(); the constructor takes these for tests. */
export interface LiveDataClientDeps {
  /** Sockets run side by side. */
  sockets: number;
  createSocket(slot: number, listener: LiveDataSocketListener): LiveDataSocketHandle;
  now(): number;
}

interface Slot {
  slot: number;
  socket: LiveDataSocketHandle;
  /** False once the client let go of this socket: whatever it still reports is ignored. */
  active: boolean;
  ready: boolean;
  /** When this connection's first fills arrived (epoch ms); null until then. */
  firstFrameAt: number | null;
  /** When this connection's latest fills arrived. */
  lastFrameAt: number | null;
}

const DEFAULT_SOCKETS = 2;
const MAX_SOCKETS = 3;
/**
 * Both sockets carry the same frames, the second copy of a fill 27 ms after
 * the first at the median and 263 ms at worst (measured 2026-11-04 over
 * 67,774 fills). Fill ids are kept at least 60 s: a socket can stall up to
 * ~40 s before its ping times out (a ping every 30 s, 10 s to answer), then
 * deliver its backlog.
 */
const FILL_KEY_PERIOD_MS = 60_000;
/** Memory guard: a generation rotates early past this many fills (~400 fills/s measured, ~25k a minute). */
const FILL_KEY_MAX = 200_000;
/** Each subscribe replays the latest 200 status events (~10 min): their keys are kept at least 30 min. */
const STATUS_KEY_PERIOD_MS = 30 * 60_000;
const STATUS_KEY_MAX = 20_000;
/**
 * A socket covers another's drop when it was receiving from at least this long
 * before the dropped one's last fills ...
 */
const COVER_MARGIN_MS = 2_000;
/** ... and still received at most this long before them (a silent stall is no cover). */
const COVER_STALE_MS = 5_000;

/** Sockets to run, from HYPEDEXER_LIVEDATA_SOCKETS: an integer from 1 to 3, else 2. */
export function liveDataSocketCount(raw: string | undefined): number {
  const n = Number(raw);
  if (raw === undefined || raw.trim() === '' || !Number.isInteger(n) || n < 1) return DEFAULT_SOCKETS;
  return Math.min(n, MAX_SOCKETS);
}

/** One fill, whichever socket brought it: a trade id and side never came up for two wallets (measured). */
function fillKey(fill: NormalizedFill): string {
  return typeof fill.tid === 'number' && Number.isFinite(fill.tid)
    ? `${fill.tid}:${fill.side}:${fill.wallet}`
    : `${fill.hash}:${String(fill.time)}:${fill.side}:${fill.wallet}:${fill.sz}`;
}

/**
 * HypeDexer live-data feed: every fill, market-wide (`allFills`), and every
 * TWAP status event (`allTwapStatusUpdates`); see HypeDexerLiveDataSocket.
 *
 * Two sockets run side by side (HYPEDEXER_LIVEDATA_SOCKETS, 1 to 3) and their
 * streams are merged: each fill and status event is handed over once, from
 * whichever socket brings it first. The prod backend's sockets drop a few
 * times an hour, each at its own time (Railway logs, 2026-11-03/04): one
 * socket going down is no gap while the other one keeps streaming.
 *
 * Connected while a socket is ready. A drop ends the connection when no other
 * socket is ready, or when none of the ones left was receiving both before
 * and around the dropped one's last fills (a possible gap): the connection
 * then starts over at once from the socket still up.
 *
 * Consumers: the Fill Alert dispatcher (fills) and the live TWAP book (fills,
 * status events, connection state). start()/stop() are reference-counted:
 * each consumer releases only its own callbacks, and the sockets close with
 * the last one.
 */
export class HypeDexerLiveDataWSClient {
  private static instance: HypeDexerLiveDataWSClient;

  // Configuration
  private static readonly WS_URL =
    process.env.HYPEDEXER_LIVEDATA_WS_URL || 'wss://api.hypedexer.com/ws?mode=mirror';
  private static readonly API_KEY = process.env.HL_INDEXER_API_KEY || '';

  private readonly deps: LiveDataClientDeps;

  // Callbacks
  private fillCallbacks: Set<FillCallback> = new Set();
  private twapStatusCallbacks: Set<TwapStatusCallback> = new Set();
  private connectionCallbacks: Set<ConnectionCallback> = new Set();

  /** Consumers that called start() and not stop() yet. */
  private consumers = 0;
  private slots: Slot[] = [];
  private upstreamConnected = false;
  private upstreamSince: number | null = null;

  /** Fills and status events already handed over (only with more than one socket). */
  private readonly fillKeys: RecentKeys;
  private readonly statusKeys: RecentKeys;
  private readonly counters = { duplicateFills: 0, duplicateStatuses: 0, handovers: 0, gaps: 0 };

  public constructor(overrides: Partial<LiveDataClientDeps> = {}) {
    this.deps = {
      sockets: overrides.sockets ?? liveDataSocketCount(process.env.HYPEDEXER_LIVEDATA_SOCKETS),
      createSocket:
        overrides.createSocket ??
        ((slot, listener) =>
          new HypeDexerLiveDataSocket(slot, listener, {
            url: HypeDexerLiveDataWSClient.WS_URL,
            apiKey: HypeDexerLiveDataWSClient.API_KEY,
          })),
      now: overrides.now ?? Date.now,
    };
    const now = this.deps.now();
    this.fillKeys = new RecentKeys(FILL_KEY_PERIOD_MS, FILL_KEY_MAX, now);
    this.statusKeys = new RecentKeys(STATUS_KEY_PERIOD_MS, STATUS_KEY_MAX, now);

    logDeduplicator.info('HypeDexerLiveDataWSClient: Initialized', {
      url: HypeDexerLiveDataWSClient.WS_URL,
      hasApiKey: !!HypeDexerLiveDataWSClient.API_KEY,
      sockets: this.deps.sockets,
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
   * Open the sockets (each subscribes to allFills and allTwapStatusUpdates).
   * Reference-counted: every consumer calls start() once and stop() once.
   */
  public start(): void {
    this.consumers++;
    // A later consumer joins the open (or reconnecting) sockets.
    if (this.consumers !== 1) return;

    this.slots = [];
    for (let slot = 1; slot <= this.deps.sockets; slot++) this.slots.push(this.createSlot(slot));
    for (const entry of this.slots) entry.socket.start();
  }

  /**
   * Release one consumer. The sockets close (and every callback is dropped)
   * with the last one; a consumer's own callbacks go through the unsubscribe
   * functions of onFill / onTwapStatus / onConnectionChange.
   */
  public stop(): void {
    this.consumers = Math.max(0, this.consumers - 1);
    if (this.consumers > 0) return;

    const slots = this.slots;
    this.slots = [];
    for (const entry of slots) {
      entry.active = false;
      try {
        entry.socket.stop();
      } catch (error) {
        logDeduplicator.error('HypeDexerLiveDataWSClient: Socket stop error', {
          slot: entry.slot,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const now = this.deps.now();
    this.setUpstreamConnected(false, now);
    this.fillCallbacks.clear();
    this.twapStatusCallbacks.clear();
    this.connectionCallbacks.clear();
    this.fillKeys.clear(now);
    this.statusKeys.clear(now);
  }

  /**
   * Register a callback for normalized fill events
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
   * Current upstream state: `at` is when the current connection started
   * (null while disconnected). A socket dropping while another one covers
   * it does not move it.
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
    sockets: Array<{ slot: number; state: WSConnectionState; ready: boolean }>;
    duplicateFills: number;
    duplicateStatuses: number;
    handovers: number;
    gaps: number;
  } {
    const sockets = this.slots.map((entry) => ({ slot: entry.slot, state: entry.socket.getState(), ready: entry.ready }));
    return {
      state: HypeDexerLiveDataWSClient.overallState(sockets.map((s) => s.state)),
      fillCallbackCount: this.fillCallbacks.size,
      twapStatusCallbackCount: this.twapStatusCallbacks.size,
      sockets,
      ...this.counters,
    };
  }

  // ============================================================================
  // PRIVATE METHODS
  // ============================================================================

  /** The best state among the sockets: connected when one is. */
  private static overallState(states: WSConnectionState[]): WSConnectionState {
    for (const state of ['connected', 'connecting', 'reconnecting', 'error'] as const) {
      if (states.includes(state)) return state;
    }
    return 'disconnected';
  }

  private createSlot(slot: number): Slot {
    const listener: LiveDataSocketListener = {
      onFills: (fills) => this.handleFills(entry, fills),
      onTwapStatuses: (events) => this.handleStatuses(entry, events),
      onReadyChange: (ready, at) => this.handleReady(entry, ready, at),
    };
    const entry: Slot = {
      slot,
      socket: this.deps.createSocket(slot, listener),
      active: true,
      ready: false,
      firstFrameAt: null,
      lastFrameAt: null,
    };
    return entry;
  }

  /** Hand over the fills no other socket brought already. */
  private handleFills(entry: Slot, fills: NormalizedFill[]): void {
    if (!entry.active || fills.length === 0) return;
    const now = this.deps.now();
    if (entry.ready) {
      if (entry.firstFrameAt === null) entry.firstFrameAt = now;
      entry.lastFrameAt = now;
    }

    let fresh = fills;
    if (this.deps.sockets > 1) {
      fresh = [];
      for (const fill of fills) {
        if (this.fillKeys.add(fillKey(fill), now)) fresh.push(fill);
      }
      this.counters.duplicateFills += fills.length - fresh.length;
      if (fresh.length === 0) return;
    }

    for (const callback of this.fillCallbacks) {
      try {
        callback(fresh);
      } catch (error) {
        logDeduplicator.error('HypeDexerLiveDataWSClient: Fill callback error', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /** Hand over the status events no other socket brought already (each subscribe replays the latest 200). */
  private handleStatuses(entry: Slot, events: TwapStatusEvent[]): void {
    if (!entry.active || events.length === 0) return;

    let fresh = events;
    if (this.deps.sockets > 1) {
      const now = this.deps.now();
      fresh = events.filter((event) => this.statusKeys.add(`${event.twapId}:${event.status}:${event.time}`, now));
      this.counters.duplicateStatuses += events.length - fresh.length;
      if (fresh.length === 0) return;
    }

    for (const callback of this.twapStatusCallbacks) {
      try {
        callback(fresh);
      } catch (error) {
        logDeduplicator.error('HypeDexerLiveDataWSClient: TWAP status callback error', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * A socket became ready or dropped. The first ready socket starts the
   * connection; a drop ends it only when no socket left covers the dropped
   * one's last fills.
   */
  private handleReady(entry: Slot, ready: boolean, at: number): void {
    if (!entry.active || entry.ready === ready) return;
    entry.ready = ready;
    const lastFrameAt = entry.lastFrameAt;
    entry.firstFrameAt = null;
    entry.lastFrameAt = null;

    if (ready) {
      if (!this.upstreamConnected) this.setUpstreamConnected(true, at);
      else logDeduplicator.info(`HypeDexerLiveDataWSClient: socket #${entry.slot} back alongside the others`);
      return;
    }
    if (!this.upstreamConnected) return;

    const others = this.slots.filter((other) => other !== entry && other.active && other.ready);
    if (others.length === 0) {
      this.counters.gaps++;
      this.setUpstreamConnected(false, at);
      return;
    }
    // A socket that dropped before its first fills carried nothing the others lack.
    const cover =
      lastFrameAt === null
        ? others[0]
        : others.find(
            (other) =>
              other.firstFrameAt !== null &&
              other.lastFrameAt !== null &&
              other.firstFrameAt + COVER_MARGIN_MS <= lastFrameAt &&
              other.lastFrameAt + COVER_STALE_MS >= lastFrameAt,
          );
    if (cover) {
      this.counters.handovers++;
      logDeduplicator.info(`HypeDexerLiveDataWSClient: socket #${entry.slot} down, #${cover.slot} still streaming (no gap)`);
      return;
    }

    // The sockets left started after the dropped one's last fills, or stalled before them: some may be missing.
    this.counters.gaps++;
    logDeduplicator.warn(`HypeDexerLiveDataWSClient: socket #${entry.slot} down and no other socket covers its last fills, restarting the connection`);
    this.setUpstreamConnected(false, at);
    this.setUpstreamConnected(true, at);
  }

  /** Record the upstream state and tell the listeners when it changed. */
  private setUpstreamConnected(connected: boolean, at: number): void {
    if (this.upstreamConnected === connected) return;

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
