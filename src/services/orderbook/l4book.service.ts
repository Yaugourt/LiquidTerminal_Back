import { HypeDexerL4BookWSClient } from '../../clients/hypedexer/websocket/l4book.ws.client';
import { HyperliquidTopOfBookWSClient } from '../../clients/hyperliquid/websocket/top-of-book.ws.client';
import { logDeduplicator } from '../../utils/logDeduplicator';
import {
  HypeDexerL4Order,
  HypeDexerL4OrderDiff,
  L4BookCoinStats,
  L4BookDeltaPayload,
  L4BookLevel,
  L4BookSnapshotPayload,
  L4BookTotals,
  L4Side,
} from '../../types/l4book.types';

/** One resting order, reduced to what the book needs. */
interface RestingOrder {
  px: number;
  sz: number;
  side: L4Side;
  user: string;
}

/** One aggregated price level. `makers` counts orders per address. */
interface PriceLevel {
  sz: number;
  orders: number;
  makers: Map<string, number>;
}

/**
 * One side of a book: price → level, plus the price list kept sorted
 * best-first so the top-N ladder is a `slice` instead of a full sort on every
 * emit. Level creation/removal is rare compared to size churn, so the splice
 * cost is paid far less often than a per-tick sort would be.
 */
class SideBook {
  public readonly levels = new Map<number, PriceLevel>();
  /** Sorted best-first: bids descending, asks ascending. */
  public readonly prices: number[] = [];
  public totalSize = 0;
  public totalNotional = 0;
  public totalOrders = 0;

  constructor(private readonly side: L4Side) {}

  /** True when `a` is a better price than `b` for this side. */
  private isBetter(a: number, b: number): boolean {
    return this.side === 'B' ? a > b : a < b;
  }

  /** Index of `px` in `prices`, or the insertion point when absent. */
  private locate(px: number): { index: number; found: boolean } {
    let lo = 0;
    let hi = this.prices.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const cur = this.prices[mid];
      if (cur === px) return { index: mid, found: true };
      if (this.isBetter(cur, px)) lo = mid + 1;
      else hi = mid;
    }
    return { index: lo, found: false };
  }

  public addOrder(px: number, sz: number, user: string): void {
    let level = this.levels.get(px);
    if (!level) {
      level = { sz: 0, orders: 0, makers: new Map() };
      this.levels.set(px, level);
      const { index } = this.locate(px);
      this.prices.splice(index, 0, px);
    }
    level.sz += sz;
    level.orders += 1;
    level.makers.set(user, (level.makers.get(user) ?? 0) + 1);

    this.totalSize += sz;
    this.totalNotional += px * sz;
    this.totalOrders += 1;
  }

  public removeOrder(px: number, sz: number, user: string): void {
    const level = this.levels.get(px);
    if (!level) return;

    level.sz -= sz;
    level.orders -= 1;
    const makerCount = level.makers.get(user);
    if (makerCount !== undefined) {
      if (makerCount <= 1) level.makers.delete(user);
      else level.makers.set(user, makerCount - 1);
    }

    this.totalSize -= sz;
    this.totalNotional -= px * sz;
    this.totalOrders -= 1;

    if (level.orders <= 0) {
      this.levels.delete(px);
      const { index, found } = this.locate(px);
      if (found) this.prices.splice(index, 1);
    }
  }

  /** Resize an order in place (partial fill) without touching order counts. */
  public resizeOrder(px: number, delta: number): void {
    const level = this.levels.get(px);
    if (!level) return;
    level.sz += delta;
    this.totalSize += delta;
    this.totalNotional += px * delta;
  }

  /**
   * Top `depth` levels, best-first, as compact tuples.
   *
   * `touch` is Hyperliquid's authoritative best price for this side. Anything
   * better than it cannot really be resting — Hyperliquid would have matched
   * it — so those leading levels are phantoms left behind by the lossy L4
   * delta stream and are skipped. Without a touch (coins the public stream
   * doesn't carry) the ladder is returned as held.
   */
  public ladder(depth: number, touch?: number | null): L4BookLevel[] {
    const out: L4BookLevel[] = [];
    let i = 0;

    if (touch != null && Number.isFinite(touch)) {
      while (i < this.prices.length && this.isBetter(this.prices[i], touch)) i++;
    }

    for (; i < this.prices.length && out.length < depth; i++) {
      const px = this.prices[i];
      const level = this.levels.get(px);
      if (!level) continue;
      // Round to shed float drift accumulated by incremental += / -=.
      out.push([px, round(level.sz), level.orders, level.makers.size]);
    }
    return out;
  }

  public clear(): void {
    this.levels.clear();
    this.prices.length = 0;
    this.totalSize = 0;
    this.totalNotional = 0;
    this.totalOrders = 0;
  }
}

/** Books drift by ~1e-12 through incremental arithmetic; 8 dp is well past any real lot size. */
function round(n: number): number {
  return Math.round(n * 1e8) / 1e8;
}

/** Full state for one mirrored coin. */
class CoinBook {
  public readonly orders = new Map<number, RestingOrder>();
  public readonly bids = new SideBook('B');
  public readonly asks = new SideBook('A');
  /** Address → resting order count, book-wide, for the unique-maker total. */
  public readonly makers = new Map<string, number>();

  public hasSnapshot = false;
  public lastUpdate = 0;
  public dirty = false;
  public lastEmitAt = 0;
  public lastResyncAt = 0;
  /** Last ladder we sent, so deltas only carry what actually moved. */
  public lastBids = new Map<number, L4BookLevel>();
  public lastAsks = new Map<number, L4BookLevel>();

  public reset(): void {
    this.orders.clear();
    this.bids.clear();
    this.asks.clear();
    this.makers.clear();
    // Fresh Maps, not `.clear()`: a resync holds a reference to these to diff
    // the rebuilt book against what clients already have, and clearing in place
    // would empty that reference too — every level would then look new and no
    // removal would ever be sent.
    this.lastBids = new Map();
    this.lastAsks = new Map();
    this.hasSnapshot = false;
    this.dirty = false;
  }

  private side(side: L4Side): SideBook {
    return side === 'B' ? this.bids : this.asks;
  }

  public insert(oid: number, px: number, sz: number, side: L4Side, user: string): void {
    // A repeated oid is a replace, not a duplicate — drop the old resting size first.
    if (this.orders.has(oid)) this.remove(oid);
    if (!Number.isFinite(px) || !Number.isFinite(sz) || sz <= 0) return;

    this.orders.set(oid, { px, sz, side, user });
    this.side(side).addOrder(px, sz, user);
    this.makers.set(user, (this.makers.get(user) ?? 0) + 1);
  }

  public remove(oid: number): void {
    const order = this.orders.get(oid);
    if (!order) return;
    this.orders.delete(oid);
    this.side(order.side).removeOrder(order.px, order.sz, order.user);

    const count = this.makers.get(order.user);
    if (count !== undefined) {
      if (count <= 1) this.makers.delete(order.user);
      else this.makers.set(order.user, count - 1);
    }
  }

  public resize(oid: number, newSz: number): void {
    const order = this.orders.get(oid);
    if (!order) return;
    if (!Number.isFinite(newSz) || newSz <= 0) {
      this.remove(oid);
      return;
    }
    this.side(order.side).resizeOrder(order.px, newSz - order.sz);
    order.sz = newSz;
  }

  public totals(): L4BookTotals {
    return {
      bidSize: round(this.bids.totalSize),
      askSize: round(this.asks.totalSize),
      bidNotional: Math.round(this.bids.totalNotional * 100) / 100,
      askNotional: Math.round(this.asks.totalNotional * 100) / 100,
      bidOrders: this.bids.totalOrders,
      askOrders: this.asks.totalOrders,
      bidLevels: this.bids.prices.length,
      askLevels: this.asks.prices.length,
      makers: this.makers.size,
    };
  }
}

/** `[px, sz, orders, makers]` equality — used to skip unchanged levels in a delta. */
function sameLevel(a: L4BookLevel | undefined, b: L4BookLevel): boolean {
  return a !== undefined && a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

export type L4BookSnapshotListener = (payload: L4BookSnapshotPayload) => void;
export type L4BookDeltaListener = (payload: L4BookDeltaPayload) => void;
export type L4BookUnavailableListener = (coin: string) => void;

/**
 * Maintains L4 books in memory and publishes a browser-sized view of them.
 *
 * Browsers cannot consume L4 directly: the HypeDexer mirror needs a server-side
 * API key, and a single snapshot is ~1.4 MB with ~33 KiB/s of deltas per coin.
 * So the server holds the book and ships an aggregated ladder (100 levels/side
 * ≈ 8 KiB, vs the 20 levels Hyperliquid's public l2Book caps at) plus totals
 * computed over the *entire* book.
 *
 * Coins are reference-counted against connected viewers, kept warm briefly
 * after the last one leaves, and capped so memory stays bounded.
 */
export class L4BookService {
  private static instance: L4BookService;

  /** Levels per side shipped downstream. */
  public static readonly DEPTH = 100;
  /** Max broadcast rate per coin. The book itself stays tick-accurate. */
  private static readonly EMIT_INTERVAL_MS = 250;
  /**
   * How often each watched book is rebuilt from a fresh upstream snapshot.
   *
   * The `l4Book` delta stream is lossy — orders can leave the book without a
   * `remove` diff (measured 2026-08-07 on HYPE: 10 of 10 resting asks the price
   * traded through were never announced), so an incrementally-maintained book
   * accumulates phantom levels and eventually shows a crossed spread. Periodic
   * resync bounds that drift; `maybeResync` also fires one on the spot the
   * moment a crossed book proves the state is stale.
   */
  private static readonly RESYNC_INTERVAL_MS = Number(process.env.L4BOOK_RESYNC_MS ?? 8_000);
  /** Floor between two resyncs of the same coin, so a crossed book can't spam upstream. */
  private static readonly RESYNC_MIN_GAP_MS = 3_000;
  /** Keep a book warm this long after the last viewer leaves. */
  private static readonly IDLE_GRACE_MS = 30_000;
  /** No snapshot within this window ⇒ the coin has no live book. */
  private static readonly SNAPSHOT_TIMEOUT_MS = 8_000;
  /** Concurrent mirrored coins. Each costs a few MB of resident book. */
  private static readonly MAX_COINS = Number(process.env.L4BOOK_MAX_COINS ?? 24);

  private readonly books = new Map<string, CoinBook>();
  /** Normalized coin → viewer count. */
  private readonly refCounts = new Map<string, number>();
  /** Normalized coin → wire id, as first requested. */
  private readonly wireCoins = new Map<string, string>();
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();
  private readonly snapshotTimers = new Map<string, NodeJS.Timeout>();

  private snapshotListeners: Set<L4BookSnapshotListener> = new Set();
  private deltaListeners: Set<L4BookDeltaListener> = new Set();
  private unavailableListeners: Set<L4BookUnavailableListener> = new Set();

  private client: HypeDexerL4BookWSClient | null = null;
  private touchClient: HyperliquidTopOfBookWSClient | null = null;
  private emitTimer: NodeJS.Timeout | null = null;
  private resyncTimer: NodeJS.Timeout | null = null;
  private started = false;

  private constructor() {}

  public static getInstance(): L4BookService {
    if (!L4BookService.instance) {
      L4BookService.instance = new L4BookService();
    }
    return L4BookService.instance;
  }

  /** Wire up the upstream client. Safe to call more than once. */
  public start(): void {
    if (this.started) return;
    this.started = true;

    this.client = HypeDexerL4BookWSClient.getInstance();
    this.client.onSnapshot((coin, levels) => this.applySnapshot(coin, levels));
    this.client.onUpdates((coin, time, diffs) => this.applyUpdates(coin, time, diffs));

    // Keyless, ~1.5 KB a frame: the reference that tells phantom levels apart
    // from real ones.
    this.touchClient = HyperliquidTopOfBookWSClient.getInstance();

    this.emitTimer = setInterval(() => this.flush(), L4BookService.EMIT_INTERVAL_MS);
    this.resyncTimer = setInterval(() => this.resyncSweep(), L4BookService.RESYNC_INTERVAL_MS);
    logDeduplicator.info('L4BookService: started', {
      depth: L4BookService.DEPTH,
      maxCoins: L4BookService.MAX_COINS,
      resyncMs: L4BookService.RESYNC_INTERVAL_MS,
    });
  }

  public shutdown(): void {
    if (this.emitTimer) {
      clearInterval(this.emitTimer);
      this.emitTimer = null;
    }
    if (this.resyncTimer) {
      clearInterval(this.resyncTimer);
      this.resyncTimer = null;
    }
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    for (const timer of this.snapshotTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
    this.snapshotTimers.clear();
    this.books.clear();
    this.refCounts.clear();
    this.wireCoins.clear();
    this.client?.stop();
    this.client = null;
    this.touchClient?.stop();
    this.touchClient = null;
    this.started = false;
    logDeduplicator.info('L4BookService: shutdown');
  }

  // ==========================================================================
  // SUBSCRIPTIONS
  // ==========================================================================

  /**
   * Register a viewer for `coin`. Returns the current snapshot when the book is
   * already warm, so a client joining an active coin renders immediately
   * instead of waiting for the next upstream frame.
   */
  public acquire(coin: string): L4BookSnapshotPayload | null {
    this.start();
    const key = HypeDexerL4BookWSClient.normalizeCoin(coin);

    const timer = this.idleTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(key);
    }

    const next = (this.refCounts.get(key) ?? 0) + 1;
    this.refCounts.set(key, next);

    if (next === 1 && !this.books.has(key)) {
      if (!this.makeRoom()) {
        logDeduplicator.warn('L4BookService: coin cap reached, refusing new book', {
          coin,
          cap: L4BookService.MAX_COINS,
        });
        this.refCounts.delete(key);
        return null;
      }
      this.wireCoins.set(key, coin);
      this.books.set(key, new CoinBook());
      this.client?.subscribeCoin(coin);
      this.touchClient?.subscribeCoin(coin);
      this.armSnapshotTimeout(key, coin);
    }

    return this.snapshotOf(key);
  }

  /** Drop a viewer. The book stays warm for a grace period before eviction. */
  public release(coin: string): void {
    const key = HypeDexerL4BookWSClient.normalizeCoin(coin);
    const current = this.refCounts.get(key);
    if (current === undefined) return;

    if (current > 1) {
      this.refCounts.set(key, current - 1);
      return;
    }

    this.refCounts.delete(key);
    if (this.idleTimers.has(key)) return;

    const timer = setTimeout(() => {
      this.idleTimers.delete(key);
      if ((this.refCounts.get(key) ?? 0) > 0) return; // someone came back
      this.evict(key);
    }, L4BookService.IDLE_GRACE_MS);
    // Do not hold the event loop open just to expire an idle book.
    timer.unref?.();
    this.idleTimers.set(key, timer);
  }

  public onSnapshot(cb: L4BookSnapshotListener): () => void {
    this.snapshotListeners.add(cb);
    return () => this.snapshotListeners.delete(cb);
  }

  public onDelta(cb: L4BookDeltaListener): () => void {
    this.deltaListeners.add(cb);
    return () => this.deltaListeners.delete(cb);
  }

  public onUnavailable(cb: L4BookUnavailableListener): () => void {
    this.unavailableListeners.add(cb);
    return () => this.unavailableListeners.delete(cb);
  }

  /** Current ladder for a coin, or `null` when no snapshot has landed yet. */
  public getSnapshot(coin: string): L4BookSnapshotPayload | null {
    return this.snapshotOf(HypeDexerL4BookWSClient.normalizeCoin(coin));
  }

  public getStats(): L4BookCoinStats[] {
    return [...this.books.entries()].map(([key, book]) => ({
      coin: this.wireCoins.get(key) ?? key,
      subscribers: this.refCounts.get(key) ?? 0,
      orders: book.orders.size,
      levels: book.bids.prices.length + book.asks.prices.length,
      lastUpdate: book.lastUpdate,
      hasSnapshot: book.hasSnapshot,
    }));
  }

  // ==========================================================================
  // UPSTREAM HANDLERS
  // ==========================================================================

  private applySnapshot(coin: string, levels: [HypeDexerL4Order[], HypeDexerL4Order[]]): void {
    const key = HypeDexerL4BookWSClient.normalizeCoin(coin);
    const book = this.books.get(key);
    if (!book) return;

    this.clearSnapshotTimeout(key);

    // A resync replaces the book but not what the clients already hold, so it
    // reconciles as a delta instead of re-sending the whole ladder.
    const isResync = book.hasSnapshot;
    const heldBids = book.lastBids;
    const heldAsks = book.lastAsks;

    book.reset();

    for (const order of levels[0]) this.insertOrder(book, order, 'B');
    for (const order of levels[1]) this.insertOrder(book, order, 'A');

    book.hasSnapshot = true;
    book.lastUpdate = Date.now();
    book.lastResyncAt = Date.now();

    if (isResync) {
      book.lastBids = heldBids;
      book.lastAsks = heldAsks;
      book.dirty = true; // the next flush ships the corrections
      return;
    }

    // First snapshot: the clients have nothing, so push the full ladder now
    // rather than waiting for the delta tick.
    const payload = this.snapshotOf(key);
    if (payload) {
      this.rememberLadder(book, payload.bids, payload.asks);
      book.dirty = false;
      book.lastEmitAt = Date.now();
      for (const cb of this.snapshotListeners) cb(payload);
    }
  }

  private insertOrder(book: CoinBook, order: HypeDexerL4Order, fallbackSide: L4Side): void {
    const px = parseFloat(order.px);
    const sz = parseFloat(order.sz);
    book.insert(order.oid, px, sz, order.side ?? fallbackSide, order.user);
  }

  private applyUpdates(coin: string, time: number, diffs: HypeDexerL4OrderDiff[]): void {
    const key = HypeDexerL4BookWSClient.normalizeCoin(coin);
    const book = this.books.get(key);
    // Deltas before the snapshot would build a book from a partial state.
    if (!book || !book.hasSnapshot) return;

    for (const diff of diffs) {
      const raw = diff.raw_book_diff;
      if (raw === 'remove') {
        book.remove(diff.oid);
      } else if (raw && typeof raw === 'object' && 'new' in raw) {
        book.insert(diff.oid, parseFloat(diff.px), parseFloat(raw.new.sz), diff.side, diff.user);
      } else if (raw && typeof raw === 'object' && 'update' in raw) {
        book.resize(diff.oid, parseFloat(raw.update.newSz));
      }
    }

    book.lastUpdate = time;
    book.dirty = true;
  }

  // ==========================================================================
  // EMIT
  // ==========================================================================

  /** Broadcast the levels that moved since the last tick, per dirty coin. */
  private flush(): void {
    const now = Date.now();
    for (const [key, book] of this.books) {
      if (!book.dirty || !book.hasSnapshot) continue;
      if ((this.refCounts.get(key) ?? 0) === 0) continue; // warm but unwatched

      const { bids, asks } = this.laddersOf(key, book);

      // Still crossed after pruning ⇒ the touch is missing (HIP-4) or itself
      // stale. Rebuild from upstream and hold the tick rather than publishing a
      // book that cannot exist; the throttle caps the pause at RESYNC_MIN_GAP_MS.
      if (bids.length > 0 && asks.length > 0 && bids[0][0] >= asks[0][0]) {
        book.dirty = false;
        this.maybeResync(key, book, now);
        continue;
      }

      const bidDelta = diffLadder(book.lastBids, bids);
      const askDelta = diffLadder(book.lastAsks, asks);

      book.dirty = false;
      book.lastEmitAt = now;

      if (bidDelta.length === 0 && askDelta.length === 0) continue;

      this.rememberLadder(book, bids, asks);

      const payload: L4BookDeltaPayload = {
        coin: this.wireCoins.get(key) ?? key,
        time: book.lastUpdate,
        bids: bidDelta,
        asks: askDelta,
        totals: book.totals(),
      };
      for (const cb of this.deltaListeners) cb(payload);
    }
  }

  /**
   * Rebuild a watched book from upstream, at most once per
   * `RESYNC_MIN_GAP_MS`. Returns whether a resync was actually requested.
   */
  private maybeResync(key: string, book: CoinBook, now: number): boolean {
    if (now - book.lastResyncAt < L4BookService.RESYNC_MIN_GAP_MS) return false;
    const wireCoin = this.wireCoins.get(key);
    if (!wireCoin) return false;

    // Stamped now, not on arrival, so a snapshot in flight can't trigger a second.
    book.lastResyncAt = now;
    this.client?.resyncCoin(wireCoin);
    return true;
  }

  /** Periodic drift correction for every book someone is watching. */
  private resyncSweep(): void {
    const now = Date.now();
    for (const [key, book] of this.books) {
      if (!book.hasSnapshot) continue;
      if ((this.refCounts.get(key) ?? 0) === 0) continue;
      if (now - book.lastResyncAt < L4BookService.RESYNC_INTERVAL_MS) continue;
      this.maybeResync(key, book, now);
    }
  }

  private rememberLadder(book: CoinBook, bids: L4BookLevel[], asks: L4BookLevel[]): void {
    book.lastBids = new Map(bids.map((l) => [l[0], l]));
    book.lastAsks = new Map(asks.map((l) => [l[0], l]));
  }

  /** Both sides of the ladder, pruned against Hyperliquid's touch. */
  private laddersOf(key: string, book: CoinBook): { bids: L4BookLevel[]; asks: L4BookLevel[] } {
    const wireCoin = this.wireCoins.get(key);
    const touch = wireCoin ? this.touchClient?.getTouch(wireCoin) : null;
    return {
      bids: book.bids.ladder(L4BookService.DEPTH, touch?.bid),
      asks: book.asks.ladder(L4BookService.DEPTH, touch?.ask),
    };
  }

  private snapshotOf(key: string): L4BookSnapshotPayload | null {
    const book = this.books.get(key);
    if (!book || !book.hasSnapshot) return null;
    const { bids, asks } = this.laddersOf(key, book);
    return {
      coin: this.wireCoins.get(key) ?? key,
      time: book.lastUpdate,
      bids,
      asks,
      totals: book.totals(),
      depth: L4BookService.DEPTH,
    };
  }

  // ==========================================================================
  // LIFECYCLE
  // ==========================================================================

  /**
   * A coin whose subscription is accepted but never sends a snapshot has no
   * live book (delisted HIP-3 asset, settled HIP-4 outcome). Tell the viewers
   * so they show an honest placeholder instead of an empty ladder.
   */
  private armSnapshotTimeout(key: string, coin: string): void {
    const timer = setTimeout(() => {
      this.snapshotTimers.delete(key);
      const book = this.books.get(key);
      if (!book || book.hasSnapshot) return;
      logDeduplicator.info('L4BookService: no snapshot for coin, reporting unavailable', { coin });
      for (const cb of this.unavailableListeners) cb(coin);
    }, L4BookService.SNAPSHOT_TIMEOUT_MS);
    timer.unref?.();
    this.snapshotTimers.set(key, timer);
  }

  private clearSnapshotTimeout(key: string): void {
    const timer = this.snapshotTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.snapshotTimers.delete(key);
    }
  }

  /** Free an idle book if we are at the coin cap. */
  private makeRoom(): boolean {
    if (this.books.size < L4BookService.MAX_COINS) return true;

    let oldestKey: string | null = null;
    let oldestAt = Infinity;
    for (const [key, book] of this.books) {
      if ((this.refCounts.get(key) ?? 0) > 0) continue;
      if (book.lastUpdate < oldestAt) {
        oldestAt = book.lastUpdate;
        oldestKey = key;
      }
    }
    if (!oldestKey) return false;

    this.evict(oldestKey);
    return true;
  }

  private evict(key: string): void {
    const wireCoin = this.wireCoins.get(key);
    this.clearSnapshotTimeout(key);
    this.books.get(key)?.reset();
    this.books.delete(key);
    this.wireCoins.delete(key);
    if (wireCoin) {
      this.client?.unsubscribeCoin(wireCoin);
      this.touchClient?.unsubscribeCoin(wireCoin);
    }
    logDeduplicator.info('L4BookService: book evicted', { coin: wireCoin ?? key });
  }
}

/**
 * Levels that changed between two ladders. A price present before but gone now
 * is emitted with size 0, which the client reads as "drop this level".
 */
function diffLadder(prev: Map<number, L4BookLevel>, next: L4BookLevel[]): L4BookLevel[] {
  const out: L4BookLevel[] = [];
  const seen = new Set<number>();

  for (const level of next) {
    seen.add(level[0]);
    if (!sameLevel(prev.get(level[0]), level)) out.push(level);
  }
  for (const px of prev.keys()) {
    if (!seen.has(px)) out.push([px, 0, 0, 0]);
  }
  return out;
}
