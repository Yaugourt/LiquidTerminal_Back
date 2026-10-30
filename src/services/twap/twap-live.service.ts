import { HypeDexerLiveDataWSClient } from '../../clients/hypedexer/websocket/live-data.ws.client';
import {
  IndexerTwapsService,
  IndexerTwap,
  IndexerTwapSource,
  IndexerTwapSourceDeep,
} from '../indexer/indexer-twaps.service';
import { NormalizedFill } from '../../types/fill-alerts.types';
import {
  TwapLiveDelta,
  TwapLiveEntry,
  TwapLivePatch,
  TwapLiveSnapshot,
  TwapLiveUpstream,
  TwapStatusEvent,
} from '../../types/twap-live.types';
import { logDeduplicator } from '../../utils/logDeduplicator';

const CONTEXT = 'TwapLiveService';

/** What the book needs from the HypeDexer live-data client. */
export type TwapLiveUpstreamClient = Pick<
  HypeDexerLiveDataWSClient,
  'start' | 'stop' | 'onFill' | 'onTwapStatus' | 'onConnectionChange' | 'getConnection'
>;

/** What the book needs from the REST side: the running TWAPs, and one TWAP's detail (`/twaps/:id`, 3 credits). */
export interface TwapLiveDeps {
  client: TwapLiveUpstreamClient;
  source: {
    getTwapSource(): Promise<IndexerTwapSource>;
    getTwapSourceDeep(): Promise<IndexerTwapSourceDeep>;
  };
  fetchTwap(twapId: number): Promise<unknown>;
  now(): number;
  /** Pause between two seeding fetches of one worker. */
  seedGapMs: number;
}

/** One fill kept while an entry is not exact, to merge with its REST summary. */
interface BufferedFill {
  time: number;
  sz: number;
  ntl: number;
  px: number;
}

interface BookEntry {
  twapId: number;
  status?: string;
  coin?: string;
  user?: string;
  side?: 'A' | 'B';
  sz?: number;
  minutes?: number;
  reduceOnly?: boolean;
  randomize?: boolean;
  startTime?: number;
  statusAt?: number;
  executedSz: number;
  executedNtl: number;
  fills: number;
  lastFillAt: number | null;
  lastPx: number | null;
  exact: boolean;
  createdAt: number;
  /** The socket fills received since the entry became non-exact; null while exact. */
  buffer: BufferedFill[] | null;
  /** Newest fill time dropped from a full buffer (0 = none dropped). */
  bufferDroppedUpTo: number;
  /**
   * Clients may hold it: sent once, then kept in step (deltas, `removed`). An
   * entry is withheld until its first fill or a terminal event, so TWAPs that
   * never execute (failed bots) stay off the wire.
   */
  shown: boolean;
}

/** What the seeding reads of `/twaps/:id`'s `meta` (the TWAP's own row, final totals once it ended). */
interface SeedMeta {
  status: string | null;
  coin: string | null;
  user: string | null;
  side: 'A' | 'B' | null;
  sz: number | null;
  executedSz: number | null;
  executedNtl: number | null;
  minutes: number | null;
  reduceOnly: boolean | null;
  randomize: boolean | null;
  startTime: number | null;
  updatedAt: number | null;
}

/** Where the REST discovery stands for the current connection. */
interface Discovery {
  /** The first sweep allowed to read the REST list: set so discoveries stay a cooldown apart. */
  dueAt: number;
  tries: number;
  done: boolean;
}

/** The part of `/twaps/:id` the seeding reads (`fills`). */
interface FillSummary {
  fillCount: number;
  totalSz: number;
  totalNotional: number;
  /** Epoch ms of the last indexed fill; null when there is none. */
  lastFillAt: number | null;
}

const FLUSH_INTERVAL_MS = 1_000;
const EVICT_INTERVAL_MS = 5_000;
const SWEEP_INTERVAL_MS = 60_000;
const ENDED_TTL_MS = 10 * 60_000;
/** A running TWAP stays this long past its theoretical end (start + minutes). */
const RUNNING_GRACE_MS = 10 * 60_000;
const PROGRESS_ONLY_TTL_MS = 30 * 60_000;
const MAX_ENTRIES = 10_000;
/** Fill ids remembered to drop a replayed fill (~440 TWAP fills/min: about an hour). */
const MAX_SEEN_FILLS = 30_000;
const MAX_BUFFERED_FILLS = 1_000;
const SEED_CONCURRENCY = 2;
/** Cap on /twaps/:id fetches per connection epoch (~530 running TWAPs, 3 credits each). */
const SEED_FETCH_CAP = 800;
/** Rolling cap on /twaps/:id fetches across epochs: a flapping socket cannot buy more (9,000 credits an hour at most). */
const SEED_HOURLY_CAP = 3_000;
const HOUR_MS = 60 * 60_000;
/** A discovery plus the re-seed it drives costs ~1,600 credits: at most one per this long, however often the socket flaps. */
const SEED_EPOCH_MIN_INTERVAL_MS = 10 * 60_000;
/** A failed REST list read is retried by the 60 s sweep, this many times per connection. */
const DISCOVERY_MAX_TRIES = 10;
/** A TWAP counts as tracked from its start only when it started this long after the connection. */
const EXACT_MARGIN_MS = 5_000;
/** A running TWAP missing from a complete REST list lost its end event if it started this long before the connection. */
const LOST_END_MARGIN_MS = 60_000;
/** A non-terminal entry with no fill this long after its start is not a TWAP anyone needs to see (failed bots). */
const ZERO_FILL_TTL_MS = 2 * 60_000;
/** A sweep gives up after this many failed fetches in a row; the next one retries. */
const SEED_MAX_CONSECUTIVE_FAILURES = 5;
const DEFAULT_SEED_GAP_MS = 100;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Spot pairs are "@<pair index>" plus the legacy "PURR/USDC": their REST summary is empty. */
function isSpotCoin(coin: string): boolean {
  return coin.startsWith('@') || coin.includes('/');
}

/** Epoch ms of a REST timestamp (UTC, with or without a zone suffix); null when unparseable. */
/**
 * HypeDexer writes times with microseconds, and a fill's millisecond can come
 * back a hair early (18:44:19.000999 for the socket's 18:44:19.001): the
 * sub-second part is rounded to the nearest millisecond, as the socket reports
 * it. Date.parse truncates it, which put a seeded last fill 1 ms before the
 * same fill on the socket, so that fill was counted twice (seen on prod data
 * 2026-10-30).
 */
function parseUtcMs(value: unknown): number | null {
  if (typeof value !== 'string' || value === '') return null;
  const match = /^(.+T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/i.exec(value);
  if (!match) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  const whole = Date.parse(`${match[1]}${match[3] ?? 'Z'}`);
  if (!Number.isFinite(whole)) return null;
  return whole + (match[2] ? Math.round(Number(`0.${match[2]}`) * 1_000) : 0);
}

function finite(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * Final statuses. Everything else (activated, waitingForTrigger, any status we
 * do not know yet) is live: a later event wins by time and fills accumulate.
 */
function isTerminal(status: string): boolean {
  return (
    status === 'finished' ||
    status === 'terminated' ||
    status === 'stopped' ||
    status === 'canceled' ||
    status === 'cancelled' ||
    status.startsWith('error')
  );
}

function isEnded(entry: BookEntry): boolean {
  return entry.status !== undefined && isTerminal(entry.status);
}

/** The running TWAPs of Hyperliquid, live: fills and status events from HypeDexer's socket. */
export class TwapLiveService {
  private static instance: TwapLiveService;

  private readonly overrides: Partial<TwapLiveDeps>;
  private resolved: TwapLiveDeps | null = null;

  private readonly book = new Map<number, BookEntry>();
  /** Fills already counted ("twapId:tid"), oldest first. */
  private readonly seenFills = new Set<string>();

  /** Entries new to the book or whose status changed: sent whole in the next delta. */
  private readonly fullDirty = new Set<number>();
  /** Entries whose progress changed: sent as a patch. */
  private readonly progressDirty = new Set<number>();
  private readonly removed = new Set<number>();
  private upstreamDirty = false;
  private readonly listeners = new Set<(delta: TwapLiveDelta) => void>();

  private started = false;
  private startedAt = 0;
  private unsubscribes: Array<() => void> = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private lastEvictAt = 0;

  /** Start of the current upstream connection; null while it is down. */
  private connectedSince: number | null = null;
  /** Bumped on every connect and disconnect: work started in an older epoch is discarded. */
  private epoch = 0;
  private sweeping = false;
  private seedFetches = 0;
  /** REST discovery of the current connection; null while the socket is down. */
  private discovery: Discovery | null = null;
  /** When a discovery last succeeded: the next one waits SEED_EPOCH_MIN_INTERVAL_MS after it. */
  private lastDiscoveryAt: number | null = null;
  /** Discovered running TWAPs whose /twaps/:id is not done yet (a failed fetch stays here). */
  private readonly pending = new Set<number>();
  /** When each /twaps/:id fetch of the last hour was made, oldest first. */
  private readonly fetchLog: number[] = [];
  private hourlyCapLogged = false;
  /** Per epoch: 'done' = seeded, 'empty' = no usable summary (not retried this epoch). */
  private readonly attempted = new Map<number, 'done' | 'empty'>();

  /** Production code uses getInstance(); the constructor takes the dependencies for tests. */
  public constructor(overrides: Partial<TwapLiveDeps> = {}) {
    this.overrides = overrides;
  }

  public static getInstance(): TwapLiveService {
    if (!TwapLiveService.instance) {
      TwapLiveService.instance = new TwapLiveService();
    }
    return TwapLiveService.instance;
  }

  // ============================================================================
  // LIFECYCLE
  // ============================================================================

  /**
   * Acquire the HypeDexer live-data client (reference-counted with the other
   * consumers) and start following it. Idempotent.
   */
  public start(): void {
    if (this.started) return;
    const deps = this.deps();
    this.started = true;
    this.startedAt = deps.now();
    this.lastEvictAt = this.startedAt;

    const client = deps.client;
    this.unsubscribes = [
      client.onFill((fills) => this.guard('fills', () => this.applyFills(fills))),
      client.onTwapStatus((events) => this.guard('status', () => this.applyStatuses(events))),
      client.onConnectionChange((connected, at) => this.guard('connection', () => this.handleConnection(connected, at))),
    ];
    try {
      client.start();
    } catch (error) {
      logDeduplicator.error(`${CONTEXT}: Client start error`, { error: errorMessage(error) });
    }

    // The socket may be open already (another consumer started it): fills
    // before this point were not seen, so the connection counts from now.
    const connection = client.getConnection();
    if (connection.connected) {
      this.guard('connection', () => this.handleConnection(true, Math.max(connection.at ?? 0, this.startedAt)));
    }

    this.flushTimer = setInterval(() => this.guard('flush', () => this.flush()), FLUSH_INTERVAL_MS);
    this.flushTimer.unref?.();
    this.sweepTimer = setInterval(() => this.requestSweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();

    logDeduplicator.info(`${CONTEXT}: Started`);
  }

  /** Release this service's callbacks and the client, drop the book. Idempotent. */
  public stop(): void {
    if (!this.started) return;
    this.started = false;

    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes = [];
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.flushTimer = null;
    this.sweepTimer = null;
    try {
      this.deps().client.stop();
    } catch (error) {
      logDeduplicator.error(`${CONTEXT}: Client stop error`, { error: errorMessage(error) });
    }

    this.epoch++;
    this.connectedSince = null;
    this.book.clear();
    this.seenFills.clear();
    this.fullDirty.clear();
    this.progressDirty.clear();
    this.removed.clear();
    this.attempted.clear();
    this.pending.clear();
    this.discovery = null;
    this.lastDiscoveryAt = null;
    this.fetchLog.length = 0;
    this.hourlyCapLogged = false;
    this.upstreamDirty = false;

    logDeduplicator.info(`${CONTEXT}: Stopped`);
  }

  // ============================================================================
  // CONSUMERS
  // ============================================================================

  /**
   * Register for the deltas, built once a second when something changed.
   * Deltas are only built while at least one listener is registered, so a
   * server with nobody subscribed pays nothing for building or serializing.
   * Returns an unsubscribe function.
   */
  public onDelta(listener: (delta: TwapLiveDelta) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public hasListeners(): boolean {
    return this.listeners.size > 0;
  }

  /** Every entry plus the upstream state, for a new subscriber. */
  public getSnapshot(): TwapLiveSnapshot {
    const entries: TwapLiveEntry[] = [];
    for (const entry of this.book.values()) {
      if (entry.shown) entries.push(this.toEntry(entry));
    }
    return { entries, upstream: this.upstream(), at: this.deps().now() };
  }

  /** One entry as the book holds it, withheld ones included (the snapshot leaves those out). For tests and diagnostics. */
  public peek(twapId: number): TwapLiveEntry | undefined {
    const entry = this.book.get(twapId);
    return entry ? this.toEntry(entry) : undefined;
  }

  public getStats(): {
    entries: number;
    running: number;
    nonExact: number;
    withheld: number;
    listeners: number;
    connectedSince: number | null;
  } {
    let running = 0;
    let nonExact = 0;
    let withheld = 0;
    for (const entry of this.book.values()) {
      if (!entry.shown) withheld++;
      if (isEnded(entry)) continue;
      running++;
      if (!entry.exact) nonExact++;
    }
    return { entries: this.book.size, running, nonExact, withheld, listeners: this.listeners.size, connectedSince: this.connectedSince };
  }

  // ============================================================================
  // BOOK — upstream events
  // ============================================================================

  private applyFills(fills: NormalizedFill[]): void {
    const now = this.deps().now();
    for (const fill of fills) {
      const twapId = fill.twapId;
      if (twapId === null || twapId === undefined) continue;
      // A fill with no usable price or size would turn the totals into NaN for good.
      if (!Number.isFinite(fill.px) || !Number.isFinite(fill.sz)) continue;
      const notional = Number.isFinite(fill.notionalUsd) ? fill.notionalUsd : fill.px * fill.sz;

      // Without a numeric trade id, a replay is told apart by hash + time + size.
      const key =
        typeof fill.tid === 'number' && Number.isFinite(fill.tid)
          ? `${twapId}:${fill.tid}`
          : `${twapId}:${fill.hash}:${String(fill.time)}:${fill.sz}`;
      if (this.seenFills.has(key)) continue;
      this.seenFills.add(key);
      if (this.seenFills.size > MAX_SEEN_FILLS) {
        const oldest = this.seenFills.values().next().value;
        if (oldest !== undefined) this.seenFills.delete(oldest);
      }

      const entry = this.book.get(twapId) ?? this.createEntry(twapId, false, now);
      // An ended entry's final totals are authoritative (they already include its last slices).
      if (isEnded(entry)) continue;

      const time = finite(fill.time) ?? now;
      entry.executedSz += fill.sz;
      entry.executedNtl += notional;
      entry.fills++;
      if (entry.lastFillAt === null || time >= entry.lastFillAt) {
        entry.lastFillAt = time;
        entry.lastPx = fill.px;
      }
      if (entry.buffer) this.buffer(entry, { time, sz: fill.sz, ntl: notional, px: fill.px });
      this.progressDirty.add(twapId);
      this.markShown(entry);
    }
  }

  private buffer(entry: BookEntry, fill: BufferedFill): void {
    const buffer = entry.buffer;
    if (!buffer) return;
    buffer.push(fill);
    if (buffer.length > MAX_BUFFERED_FILLS) {
      const dropped = buffer.shift();
      if (dropped) entry.bufferDroppedUpTo = Math.max(entry.bufferDroppedUpTo, dropped.time);
    }
  }

  private applyStatuses(events: TwapStatusEvent[]): void {
    const now = this.deps().now();
    // Only the newest event of a TWAP counts: an older 'activated' must not
    // re-create an entry whose newer terminal event is dropped as stale.
    const newest = new Map<number, TwapStatusEvent>();
    for (const event of events) {
      const previous = newest.get(event.twapId);
      if (!previous || event.time > previous.time || (event.time === previous.time && isTerminal(event.status))) {
        newest.set(event.twapId, event);
      }
    }
    for (const event of newest.values()) this.applyStatus(event, now);
  }

  private applyStatus(event: TwapStatusEvent, now: number): void {
    const ended = isTerminal(event.status);
    let entry = this.book.get(event.twapId);

    if (!entry) {
      // A stale ended event (snapshot replay) would only be evicted again.
      if (ended && event.time + ENDED_TTL_MS <= now) return;
      entry = this.createEntry(event.twapId, false, now);
    } else if (entry.status !== undefined) {
      const statusAt = entry.statusAt ?? 0;
      if (isEnded(entry)) {
        // Final: a replayed or older 'activated' never reopens it, the newer ended event wins.
        if (!ended || event.time <= statusAt) return;
      } else if (!ended && event.time <= statusAt) {
        return; // the same activation replayed
      }
    }

    entry.status = event.status;
    entry.statusAt = event.time;
    entry.coin = event.coin;
    entry.user = event.user;
    entry.side = event.side;
    entry.sz = event.sz;
    entry.minutes = event.minutes;
    entry.reduceOnly = event.reduceOnly;
    entry.randomize = event.randomize;
    entry.startTime = event.startTime;

    if (ended) {
      // The ended event carries the final totals.
      entry.executedSz = event.executedSz;
      entry.executedNtl = event.executedNtl;
      this.markExact(entry);
      this.markShown(entry); // a TWAP cancelled before its first slice is still worth telling
    } else if (!entry.exact && this.connectedSince !== null && event.startTime >= this.connectedSince + EXACT_MARGIN_MS) {
      // Started on this connection, past the margin: every slice came through this socket.
      this.markExact(entry);
    }
    this.fullDirty.add(entry.twapId);
  }

  /** From now on clients hold this entry: it is sent whole, and a pending removal no longer applies. */
  private markShown(entry: BookEntry): void {
    if (entry.shown) return;
    entry.shown = true;
    this.fullDirty.add(entry.twapId);
    this.removed.delete(entry.twapId);
  }

  private markExact(entry: BookEntry): void {
    entry.exact = true;
    entry.buffer = null;
    entry.bufferDroppedUpTo = 0;
  }

  private createEntry(twapId: number, exact: boolean, now: number): BookEntry {
    const entry: BookEntry = {
      twapId,
      executedSz: 0,
      executedNtl: 0,
      fills: 0,
      lastFillAt: null,
      lastPx: null,
      exact,
      createdAt: now,
      buffer: exact ? null : [],
      bufferDroppedUpTo: 0,
      shown: false,
    };
    this.book.set(twapId, entry);
    this.fullDirty.add(twapId);
    return entry;
  }

  private handleConnection(connected: boolean, at: number): void {
    this.epoch++;
    this.upstreamDirty = true;

    if (connected) {
      this.connectedSince = at;
      this.attempted.clear();
      this.pending.clear();
      this.seedFetches = 0;
      // One discovery per connection, and no sooner than a cooldown after the last one.
      const dueAt = this.lastDiscoveryAt === null ? 0 : this.lastDiscoveryAt + SEED_EPOCH_MIN_INTERVAL_MS;
      this.discovery = { dueAt, tries: 0, done: false };
      logDeduplicator.info(`${CONTEXT}: Upstream connected`, dueAt > this.deps().now() ? { discoveryDueAt: dueAt } : undefined);
      this.requestSweep();
      return;
    }

    this.connectedSince = null;
    this.discovery = null;
    this.pending.clear();
    // Fills are missed while the socket is down: what the running entries
    // hold may be short, until they are seeded again after the reconnect.
    for (const entry of this.book.values()) {
      if (isEnded(entry)) continue;
      entry.exact = false;
      entry.buffer = [];
      entry.bufferDroppedUpTo = 0;
      this.progressDirty.add(entry.twapId);
    }
    logDeduplicator.warn(`${CONTEXT}: Upstream disconnected`);
  }

  // ============================================================================
  // SEEDING — /twaps/:id summaries for TWAPs that started before this connection
  // ============================================================================

  private requestSweep(): void {
    this.runSweep().catch((error: unknown) => {
      logDeduplicator.error(`${CONTEXT}: Seeding sweep error`, { error: errorMessage(error) });
    });
  }

  /**
   * One sweep (at connect, then every 60 s). It never reads the REST list
   * except for the connection's discovery: that read (the shared REST walk,
   * hundreds of credits) happens once per connection, no sooner than
   * SEED_EPOCH_MIN_INTERVAL_MS after the last one, and a failed read is
   * retried by the next sweeps (DISCOVERY_MAX_TRIES). Once the discovery is
   * through, a sweep only retries the /twaps/:id fetches that failed and
   * seeds the book entries that need it. One sweep at a time. Public for tests.
   */
  public async runSweep(): Promise<void> {
    if (this.sweeping || !this.started || this.connectedSince === null) return;
    this.sweeping = true;
    const epoch = this.epoch;
    let fetched = 0;
    try {
      const discovery = this.discovery;
      if (discovery && !discovery.done && discovery.tries < DISCOVERY_MAX_TRIES && this.deps().now() >= discovery.dueAt) {
        await this.discover(discovery, epoch);
      }
      // No seeding before the discovery is through (or given up): a reconnect inside the cooldown leaves its entries non-exact.
      const open = this.epoch === epoch && this.discovery !== null && (this.discovery.done || this.discovery.tries >= DISCOVERY_MAX_TRIES);
      const queue = open ? this.collectSeedCandidates() : [];
      let cursor = 0;
      let failures = 0;
      const deps = this.deps();

      const worker = async (): Promise<void> => {
        while (cursor < queue.length) {
          if (this.epoch !== epoch || !this.started) return;
          if (failures >= SEED_MAX_CONSECUTIVE_FAILURES || this.seedFetches >= SEED_FETCH_CAP) return;
          const twapId = queue[cursor++];
          if (!this.shouldSeed(twapId)) continue;
          if (!this.takeHourlyFetch()) return;

          this.seedFetches++;
          fetched++;
          try {
            const raw = await deps.fetchTwap(twapId);
            failures = 0;
            if (this.epoch !== epoch) return; // the connection moved on: the buffer it merges with is gone
            if (this.mergeSeed(twapId, raw)) this.pending.delete(twapId);
          } catch (error) {
            failures++;
            logDeduplicator.warn(`${CONTEXT}: Seed fetch failed`, { error: errorMessage(error) });
          }
          if (deps.seedGapMs > 0) await sleep(deps.seedGapMs);
        }
      };
      await Promise.all(Array.from({ length: SEED_CONCURRENCY }, () => worker()));

      if (fetched > 0) {
        logDeduplicator.info(`${CONTEXT}: Seeding sweep done`, { candidates: queue.length, fetched, totalFetches: this.seedFetches });
      }
    } catch (error) {
      logDeduplicator.error(`${CONTEXT}: Seeding sweep error`, { error: errorMessage(error) });
    } finally {
      this.sweeping = false;
    }
    // The connection changed while this sweep ran: its successor was skipped as "already sweeping".
    if (this.epoch !== epoch && this.connectedSince !== null) this.requestSweep();
  }

  /** Room in the rolling hourly cap for one more /twaps/:id fetch; takes it. Logs once when the cap is hit. */
  private takeHourlyFetch(): boolean {
    const now = this.deps().now();
    while (this.fetchLog.length > 0 && this.fetchLog[0] <= now - HOUR_MS) this.fetchLog.shift();
    if (this.fetchLog.length >= SEED_HOURLY_CAP) {
      if (!this.hourlyCapLogged) {
        this.hourlyCapLogged = true;
        logDeduplicator.warn(`${CONTEXT}: Hourly seeding cap reached`, { cap: SEED_HOURLY_CAP });
      }
      return false;
    }
    this.hourlyCapLogged = false;
    this.fetchLog.push(now);
    return true;
  }

  /**
   * The connection's one read of the REST list of running TWAPs: it names the
   * TWAPs that started before the socket (to seed), and, when the list is
   * complete, the book entries whose end event was lost in a gap (REST knows
   * how those ended). A failed read leaves `done` unset: the next sweep retries.
   */
  private async discover(discovery: Discovery, epoch: number): Promise<void> {
    const since = this.connectedSince;
    if (since === null) return;
    discovery.tries++;
    const { source } = this.deps();

    const rows: IndexerTwap[] = [];
    let complete = false;
    let readable = false;
    try {
      const current = await source.getTwapSource();
      rows.push(...current.running);
      if (current.deepAt.running === null) {
        complete = true; // the first page is not full: nothing is deeper
        readable = true;
      } else {
        const deep: IndexerTwapSourceDeep = await source.getTwapSourceDeep();
        if (deep.running) {
          rows.push(...deep.running.rows);
          complete = true;
          readable = true;
        }
      }
    } catch (error) {
      logDeduplicator.warn(`${CONTEXT}: Running TWAPs unavailable`, { error: errorMessage(error), tries: discovery.tries });
    }
    if (this.epoch !== epoch) return;

    const boundary = since + EXACT_MARGIN_MS;
    for (const row of rows) {
      if (typeof row.coin !== 'string' || isSpotCoin(row.coin)) continue;
      const start = parseUtcMs(row.startTime);
      if (start === null || start >= boundary) continue;
      this.pending.add(row.twapId);
    }

    if (!readable) {
      if (discovery.tries >= DISCOVERY_MAX_TRIES) {
        logDeduplicator.error(`${CONTEXT}: Running TWAPs list unreadable, discovery given up for this connection`, { tries: discovery.tries });
      }
      return;
    }
    discovery.done = true;
    this.lastDiscoveryAt = this.deps().now();
    if (complete) this.dropLostEnds(new Set(rows.map((row) => row.twapId)), since);
  }

  /**
   * Entries that started well before the connection and are not in the
   * complete REST list of running TWAPs ended while the socket was down (or
   * before it): their end event is lost, REST knows how they ended. Only
   * 'activated' ones: the list holds nothing else.
   */
  private dropLostEnds(restRunning: Set<number>, since: number): void {
    const limit = since - LOST_END_MARGIN_MS;
    let dropped = 0;
    for (const [twapId, entry] of this.book) {
      if (entry.status !== 'activated' || entry.startTime === undefined || entry.startTime >= limit) continue;
      if (restRunning.has(twapId)) continue;
      this.remove(twapId);
      dropped++;
    }
    if (dropped > 0) logDeduplicator.info(`${CONTEXT}: Dropped TWAPs whose end was missed`, { dropped });
  }

  /** TWAPs to seed: the discovered ones not done yet, and the book entries that started before the exact boundary. */
  private collectSeedCandidates(): number[] {
    const since = this.connectedSince;
    if (since === null) return [];
    const boundary = since + EXACT_MARGIN_MS;
    const ids = new Set<number>();

    for (const twapId of this.pending) {
      if (this.shouldSeed(twapId)) ids.add(twapId);
      else this.pending.delete(twapId);
    }
    for (const entry of this.book.values()) {
      if (entry.startTime === undefined || entry.startTime >= boundary) continue;
      if (this.shouldSeed(entry.twapId)) ids.add(entry.twapId);
    }
    return [...ids];
  }

  private shouldSeed(twapId: number): boolean {
    const entry = this.book.get(twapId);
    if (entry) {
      if (isEnded(entry) || entry.exact) return false;
      if (entry.coin !== undefined && isSpotCoin(entry.coin)) return false;
    }
    const attempt = this.attempted.get(twapId);
    if (attempt === 'empty') return false;
    // Seeded, then evicted as idle: a later fill re-creates it non-exact and is seeded again.
    if (attempt === 'done' && !entry) return false;
    return true;
  }

  private parsePayload(raw: unknown): { summary: FillSummary | null; meta: SeedMeta | null; spot: boolean } {
    if (typeof raw !== 'object' || raw === null) return { summary: null, meta: null, spot: false };
    const payload = raw as { coin?: unknown; meta?: unknown; fills?: unknown; data?: { meta?: unknown; fills?: unknown } };
    const meta = this.parseMeta(payload.meta ?? payload.data?.meta);
    const coin = meta?.coin ?? (typeof payload.coin === 'string' ? payload.coin : null);
    const spot = coin !== null && isSpotCoin(coin);
    return { summary: this.parseSummary(payload.fills ?? payload.data?.fills), meta, spot };
  }

  private parseMeta(raw: unknown): SeedMeta | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const m = raw as Record<string, unknown>;
    return {
      status: typeof m.status === 'string' ? m.status : null,
      coin: typeof m.coin === 'string' ? m.coin : null,
      user: typeof m.user === 'string' ? m.user.toLowerCase() : null,
      side: m.side === 'A' || m.side === 'B' ? m.side : null,
      sz: finite(m.sz),
      executedSz: finite(m.executedSz),
      executedNtl: finite(m.executedNtl),
      minutes: finite(m.minutes),
      reduceOnly: typeof m.reduceOnly === 'boolean' ? m.reduceOnly : null,
      randomize: typeof m.randomize === 'boolean' ? m.randomize : null,
      startTime: parseUtcMs(m.startTime),
      updatedAt: parseUtcMs(m.updatedAt),
    };
  }

  private parseSummary(fills: unknown): FillSummary | null {
    if (typeof fills !== 'object' || fills === null) return null;

    const f = fills as Record<string, unknown>;
    const fillCount = finite(f.fillCount);
    const totalSz = finite(f.totalSz);
    const totalNotional = finite(f.totalNotional);
    if (fillCount === null || fillCount < 0) return null;
    if (fillCount === 0) return { fillCount: 0, totalSz: 0, totalNotional: 0, lastFillAt: null };
    // Fills without a usable last-fill time cannot be told apart from the socket's.
    const lastFillAt = parseUtcMs(f.lastFill);
    if (totalSz === null || totalNotional === null || lastFillAt === null) return null;
    return { fillCount, totalSz, totalNotional, lastFillAt };
  }

  /**
   * Replace an entry's executed amounts by the REST summary plus the socket
   * fills it did not cover (those after the summary's last fill), then it is
   * exact. A TWAP REST already reports as ended takes its final state instead
   * (its end event was missed). Returns false when the fetch must be retried
   * on a later sweep.
   */
  private mergeSeed(twapId: number, raw: unknown): boolean {
    const existing = this.book.get(twapId);
    if (existing && (isEnded(existing) || existing.exact)) {
      this.attempted.set(twapId, 'done');
      return true;
    }

    const { summary, meta, spot } = this.parsePayload(raw);
    // Spot summaries are empty: nothing to seed, no retry this epoch.
    if (spot) {
      this.attempted.set(twapId, 'empty');
      return true;
    }
    if (meta?.status && isTerminal(meta.status)) {
      this.applyEndedMeta(twapId, existing, meta, summary);
      this.attempted.set(twapId, 'done');
      return true;
    }
    // Nothing usable: leave it non-exact, no retry this epoch.
    if (!summary) {
      this.attempted.set(twapId, 'empty');
      return true;
    }

    const buffered = existing?.buffer ?? [];
    const covered = summary.lastFillAt;
    if (existing && existing.bufferDroppedUpTo > (covered ?? 0)) {
      return false; // the buffer lost fills the summary lacks: retry on a later sweep, when REST has caught up
    }
    const extra = covered === null ? buffered : buffered.filter((fill) => fill.time > covered);

    // A TWAP with no fill at all is not worth an entry of its own.
    if (!existing && summary.fillCount + extra.length === 0) {
      this.attempted.set(twapId, 'done');
      return true;
    }

    const entry = existing ?? this.createEntry(twapId, true, this.deps().now());
    let sz = summary.totalSz;
    let ntl = summary.totalNotional;
    let lastFillAt = summary.lastFillAt;
    let lastPx = entry.lastPx;
    for (const fill of extra) {
      sz += fill.sz;
      ntl += fill.ntl;
      if (lastFillAt === null || fill.time >= lastFillAt) {
        lastFillAt = fill.time;
        lastPx = fill.px;
      }
    }
    entry.executedSz = sz;
    entry.executedNtl = ntl;
    entry.fills = summary.fillCount + extra.length;
    entry.lastFillAt = lastFillAt;
    entry.lastPx = lastPx;
    this.markExact(entry);
    this.progressDirty.add(twapId);
    if (entry.fills > 0) this.markShown(entry);
    this.attempted.set(twapId, 'done');
    return true;
  }

  /** REST says the TWAP ended: its meta holds the final status and totals, the static fields fill what the entry lacks. */
  private applyEndedMeta(twapId: number, existing: BookEntry | undefined, meta: SeedMeta, summary: FillSummary | null): void {
    const now = this.deps().now();
    const endedAt = meta.updatedAt ?? now;
    // Too old to be kept: it would only be evicted again.
    if (!existing && endedAt + ENDED_TTL_MS <= now) return;

    const entry = existing ?? this.createEntry(twapId, true, now);
    entry.status = meta.status ?? entry.status;
    entry.statusAt = endedAt;
    if (entry.coin === undefined && meta.coin !== null) entry.coin = meta.coin;
    if (entry.user === undefined && meta.user !== null) entry.user = meta.user;
    if (entry.side === undefined && meta.side !== null) entry.side = meta.side;
    if (entry.sz === undefined && meta.sz !== null) entry.sz = meta.sz;
    if (entry.minutes === undefined && meta.minutes !== null) entry.minutes = meta.minutes;
    if (entry.reduceOnly === undefined && meta.reduceOnly !== null) entry.reduceOnly = meta.reduceOnly;
    if (entry.randomize === undefined && meta.randomize !== null) entry.randomize = meta.randomize;
    if (entry.startTime === undefined && meta.startTime !== null) entry.startTime = meta.startTime;
    // The final totals are authoritative.
    if (meta.executedSz !== null) entry.executedSz = meta.executedSz;
    if (meta.executedNtl !== null) entry.executedNtl = meta.executedNtl;
    if (summary && summary.fillCount > 0) {
      entry.fills = summary.fillCount;
      entry.lastFillAt = summary.lastFillAt;
    }
    this.markExact(entry);
    this.markShown(entry);
    this.fullDirty.add(twapId);
  }

  // ============================================================================
  // FLUSH & EVICTION
  // ============================================================================

  /** Evict, then build and send one delta when something changed and somebody listens. Public for tests. */
  public flush(): void {
    const now = this.deps().now();
    if (now - this.lastEvictAt >= EVICT_INTERVAL_MS) {
      this.lastEvictAt = now;
      this.evict(now);
    }

    if (this.listeners.size === 0) {
      // Nobody to tell: the next subscriber starts from a snapshot.
      this.fullDirty.clear();
      this.progressDirty.clear();
      this.removed.clear();
      this.upstreamDirty = false;
      return;
    }
    if (this.fullDirty.size === 0 && this.progressDirty.size === 0 && this.removed.size === 0 && !this.upstreamDirty) return;

    const entries: TwapLivePatch[] = [];
    for (const twapId of this.fullDirty) {
      const entry = this.book.get(twapId);
      if (entry?.shown) entries.push(this.toEntry(entry));
    }
    for (const twapId of this.progressDirty) {
      if (this.fullDirty.has(twapId)) continue;
      const entry = this.book.get(twapId);
      if (!entry?.shown) continue;
      entries.push({
        twapId,
        executedSz: entry.executedSz,
        executedNtl: entry.executedNtl,
        fills: entry.fills,
        lastFillAt: entry.lastFillAt,
        lastPx: entry.lastPx,
        exact: entry.exact,
      });
    }
    const delta: TwapLiveDelta = { entries, removed: [...this.removed], upstream: this.upstream(), at: now };
    this.fullDirty.clear();
    this.progressDirty.clear();
    this.removed.clear();
    this.upstreamDirty = false;

    for (const listener of this.listeners) {
      try {
        listener(delta);
      } catch (error) {
        logDeduplicator.error(`${CONTEXT}: Delta listener error`, { error: errorMessage(error) });
      }
    }
  }

  private evict(now: number): void {
    for (const [twapId, entry] of this.book) {
      if (this.isExpired(entry, now)) this.remove(twapId);
    }
    // Hard cap, oldest first (Map order is insertion order).
    for (const twapId of this.book.keys()) {
      if (this.book.size <= MAX_ENTRIES) break;
      this.remove(twapId);
    }
  }

  private isExpired(entry: BookEntry, now: number): boolean {
    if (isEnded(entry)) return now - (entry.statusAt ?? entry.createdAt) > ENDED_TTL_MS;
    // Never filled two minutes after its start: a failed bot, not a TWAP to show.
    if (entry.fills === 0 && now > (entry.startTime ?? entry.createdAt) + ZERO_FILL_TTL_MS) return true;
    if (entry.status !== undefined && entry.startTime !== undefined && entry.minutes !== undefined) {
      return now > entry.startTime + entry.minutes * 60_000 + RUNNING_GRACE_MS;
    }
    // Progress-only (or a running entry without its schedule): idle for 30 minutes.
    return now - Math.max(entry.lastFillAt ?? 0, entry.createdAt) > PROGRESS_ONLY_TTL_MS;
  }

  private remove(twapId: number): void {
    const entry = this.book.get(twapId);
    this.book.delete(twapId);
    this.fullDirty.delete(twapId);
    this.progressDirty.delete(twapId);
    // Clients are told only about what they may hold.
    if (entry?.shown) this.removed.add(twapId);
  }

  // ============================================================================
  // HELPERS
  // ============================================================================

  private toEntry(entry: BookEntry): TwapLiveEntry {
    const out: TwapLiveEntry = {
      twapId: entry.twapId,
      executedSz: entry.executedSz,
      executedNtl: entry.executedNtl,
      fills: entry.fills,
      lastFillAt: entry.lastFillAt,
      lastPx: entry.lastPx,
      exact: entry.exact,
    };
    if (entry.status !== undefined) out.status = entry.status;
    if (entry.coin !== undefined) out.coin = entry.coin;
    if (entry.user !== undefined) out.user = entry.user;
    if (entry.side !== undefined) out.side = entry.side;
    if (entry.sz !== undefined) out.sz = entry.sz;
    if (entry.minutes !== undefined) out.minutes = entry.minutes;
    if (entry.reduceOnly !== undefined) out.reduceOnly = entry.reduceOnly;
    if (entry.randomize !== undefined) out.randomize = entry.randomize;
    if (entry.startTime !== undefined) out.startTime = entry.startTime;
    if (entry.statusAt !== undefined) out.statusAt = entry.statusAt;
    return out;
  }

  private upstream(): TwapLiveUpstream {
    return { connected: this.connectedSince !== null, since: this.connectedSince };
  }

  /** No callback may throw out of the socket's message loop or a timer. */
  private guard(what: string, fn: () => void): void {
    try {
      fn();
    } catch (error) {
      logDeduplicator.error(`${CONTEXT}: ${what} handler error`, { error: errorMessage(error) });
    }
  }

  private deps(): TwapLiveDeps {
    if (!this.resolved) {
      const overrides = this.overrides;
      this.resolved = {
        client: overrides.client ?? HypeDexerLiveDataWSClient.getInstance(),
        source: overrides.source ?? IndexerTwapsService.getInstance(),
        fetchTwap: overrides.fetchTwap ?? ((twapId: number) => IndexerTwapsService.getInstance().getTwap(String(twapId))),
        now: overrides.now ?? Date.now,
        seedGapMs: overrides.seedGapMs ?? DEFAULT_SEED_GAP_MS,
      };
    }
    return this.resolved;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
