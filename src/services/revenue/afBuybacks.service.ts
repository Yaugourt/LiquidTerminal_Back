import { BaseApiService } from '../../core/base.api.service';
import { redisService } from '../../core/redis.service';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { OnDemandSnapshot } from '../../utils/onDemandSnapshot';
import { RY_ASSISTANCE_FUND } from './reserve-yield.ledger';

const DAY_MS = 86_400_000;
/** The HYPE/USDC spot pair the fund buys on. */
const HYPE_SPOT_COIN = '@107';

/** `userFillsByTime` row, the fields read here. */
interface RawFill {
  coin: string;
  px: string;
  sz: string;
  side: string;
  time: number;
  tid: number;
}

export interface AfBuybackTotals {
  /** HYPE bought. */
  hype: number;
  /** USD spent (size × price of each buy). */
  usd: number;
  /** Buy fills. */
  fills: number;
}

export interface AfBuybackDay extends AfBuybackTotals {
  /** UTC midnight, epoch ms. */
  time: number;
}

export interface AfBuybackFill {
  time: number;
  px: number;
  sz: number;
}

export interface AfBuybacksSnapshot {
  /**
   * Completed UTC days of the window, oldest first. Only days read whole are
   * listed: a day Hyperliquid no longer holds whole is left out, not zeroed.
   */
  days: AfBuybackDay[];
  /** The running UTC day so far. */
  today: AfBuybackDay;
  /** The running day's latest buys, newest first. */
  recent: AfBuybackFill[];
  /** Completed days the window spans (`days` holds at most this many). */
  windowDays: number;
  /** Epoch ms of the running day's last read. */
  lastUpdate: number;
}

export class AfBuybacksUnavailableError extends Error {
  constructor() {
    super('Assistance Fund buybacks unavailable');
    this.name = 'AfBuybacksUnavailableError';
  }
}

interface RunningDay {
  start: number;
  totals: AfBuybackTotals;
  /** tids counted so far (the overlap re-reads some). */
  seen: Set<number>;
  /** Latest fill time read, any coin or side. */
  lastTime: number;
  recent: AfBuybackFill[];
}

interface RunningDayView {
  start: number;
  totals: AfBuybackTotals;
  recent: AfBuybackFill[];
  readAt: number;
}

class HyperliquidFillsClient extends BaseApiService {
  constructor() {
    super((process.env.HYPERLIQUID_API_URL || 'https://api.hyperliquid.xyz') + '/info');
  }

  /** Fills from `startTime` to `endTime` (both inclusive), oldest first, 2,000 at most. */
  userFillsByTime(user: string, startTime: number, endTime: number): Promise<RawFill[]> {
    return this.post<RawFill[]>('', { type: 'userFillsByTime', user, startTime, endTime });
  }
}

const utcDayStart = (time: number): number => Math.floor(time / DAY_MS) * DAY_MS;

/** Weight Hyperliquid charges a `userFillsByTime` read: 20, plus 1 per 20 fills returned. */
const readWeight = (rows: number): number => 20 + Math.ceil(rows / 20);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });

const isTotals = (value: unknown): value is AfBuybackTotals => {
  const v = value as AfBuybackTotals | null;
  return (
    typeof v === 'object' && v !== null &&
    Number.isFinite(v.hype) && v.hype >= 0 &&
    Number.isFinite(v.usd) && v.usd >= 0 &&
    Number.isInteger(v.fills) && v.fills >= 0
  );
};

/** HYPE buys of `fills` that fall in the UTC day starting at `dayStart`. */
function addBuybacks(
  totals: AfBuybackTotals,
  fills: RawFill[],
  dayStart: number,
  onBuy?: (fill: AfBuybackFill) => void
): void {
  for (const f of fills) {
    if (f.time < dayStart || f.time >= dayStart + DAY_MS) continue;
    if (f.coin !== HYPE_SPOT_COIN || f.side !== 'B') continue;
    const sz = parseFloat(f.sz);
    const px = parseFloat(f.px);
    if (!Number.isFinite(sz) || !Number.isFinite(px)) continue;
    totals.hype += sz;
    totals.usd += sz * px;
    totals.fills++;
    onBuy?.({ time: f.time, px, sz });
  }
}

/**
 * The Assistance Fund's HYPE buybacks per UTC day, from its fills
 * (`userFillsByTime`). The browser used to post one read per day of a 14-day
 * window every 5 minutes (~4.4 MB per visit, Hyperliquid never compresses),
 * and the totals were wrong: a read returns 2,000 fills at most, which busy
 * days exceed (5,421 on 2026-10-04, cut at 10:57), and Hyperliquid only keeps
 * the fund's fills back to a horizon (2026-09-26 17:49 on 2026-10-08), so the
 * oldest days of the window came back empty or partial and were averaged in.
 *
 * - A completed day is read whole (pages of 2,000, ties deduped by tid) once
 *   it has been over for SETTLE_MS, then kept only if Hyperliquid's oldest
 *   fill, read after it, is no later than the day's start: a day past the
 *   horizon is left out. Kept days go to Redis (KEEP_DAYS), so the window
 *   fills up beyond the horizon over time.
 * - The running day is read incrementally (fills since the last one, with an
 *   overlap), at most once per FRESH_MS whatever the number of readers.
 * - Completed days are read in the background, newest first, paced to
 *   MAX_WEIGHT_PER_MINUTE: the backend's pollers already use about half of
 *   the IP's 1,200 a minute, and a 2,000-fill page weighs 120.
 */
export class AfBuybacksService {
  private static instance: AfBuybacksService;

  /** Completed days served: the window ends yesterday. */
  public static readonly WINDOW_DAYS = 13;
  /** The running day is read again at most this often. */
  private static readonly FRESH_MS = 60_000;
  /** Past this age the running day is not served. */
  private static readonly MAX_STALE_MS = 15 * 60_000;
  /** Fills per `userFillsByTime` response, at most. */
  private static readonly PAGE_SIZE = 2_000;
  /** Pages read for one range, at most (40,000 fills). */
  private static readonly MAX_PAGES = 20;
  /** Each running-day read starts this long before the last fill read (deduped by tid). */
  private static readonly OVERLAP_MS = 30_000;
  /** A finished day is read whole once it has been over this long. */
  private static readonly SETTLE_MS = 60_000;
  /** Completed days read before each horizon check (one check per batch). */
  private static readonly DAYS_PER_BATCH = 4;
  /** Weight the background reads may spend a minute. */
  private static readonly MAX_WEIGHT_PER_MINUTE = 300;
  /** A failed background read is retried after this. */
  private static readonly RETRY_AFTER_MS = 5 * 60_000;
  private static readonly RECENT_FILLS = 12;
  /** Days kept in Redis; older ones are dropped on the next write. */
  private static readonly KEEP_DAYS = 35;
  private static readonly STORE_KEY = 'hype:af-buybacks:days:v1';
  private static readonly STORE_TTL_SECONDS = AfBuybacksService.KEEP_DAYS * 86_400;

  private readonly client = new HyperliquidFillsClient();
  /** Completed days read whole, by UTC midnight. */
  private readonly days = new Map<number, AfBuybackTotals>();
  /** Completed days that started before Hyperliquid's horizon: never readable whole again. */
  private readonly unreadable = new Set<number>();
  private storeLoad: Promise<void> | null = null;
  private running: RunningDay | null = null;
  private readonly runningDay = new OnDemandSnapshot<RunningDayView>(() => this.readRunningDay(), {
    freshMs: AfBuybacksService.FRESH_MS,
    maxStaleMs: AfBuybacksService.MAX_STALE_MS,
  });
  private backfill: Promise<void> | null = null;
  private backfillRetryAt = 0;
  /** Background reads wait until then (weight spent so far, at MAX_WEIGHT_PER_MINUTE). */
  private paceUntil = 0;

  private constructor() {}

  public static getInstance(): AfBuybacksService {
    if (!AfBuybacksService.instance) {
      AfBuybacksService.instance = new AfBuybacksService();
    }
    return AfBuybacksService.instance;
  }

  public async getBuybacks(): Promise<AfBuybacksSnapshot> {
    await this.loadStore();
    const todayStart = utcDayStart(Date.now());

    let run = await this.runningDay.get();
    if (run && run.start !== todayStart) {
      // The day turned: the previous day's running total is not today's.
      // clear() also detaches a refresh started before midnight, so this
      // get() reads today instead of joining it.
      this.runningDay.clear();
      run = await this.runningDay.get();
    }
    if (!run || run.start !== todayStart) {
      throw new AfBuybacksUnavailableError();
    }

    this.startBackfill(todayStart);

    const days: AfBuybackDay[] = [];
    for (let i = AfBuybacksService.WINDOW_DAYS; i >= 1; i--) {
      const start = todayStart - i * DAY_MS;
      const totals = this.days.get(start);
      if (totals) days.push({ time: start, ...totals });
    }
    return {
      days,
      today: { time: run.start, ...run.totals },
      recent: run.recent,
      windowDays: AfBuybacksService.WINDOW_DAYS,
      lastUpdate: run.readAt,
    };
  }

  /** Fills since the last read (whole day on the first), added to the running day. */
  private async readRunningDay(): Promise<RunningDayView> {
    const now = Date.now();
    const start = utcDayStart(now);
    const run: RunningDay =
      this.running && this.running.start === start
        ? this.running
        : { start, totals: { hype: 0, usd: 0, fills: 0 }, seen: new Set(), lastTime: start, recent: [] };

    try {
      const from = Math.max(start, run.lastTime - AfBuybacksService.OVERLAP_MS);
      const fills = (await this.readFills(from, now, false)).filter((f) => {
        if (f.time < start || run.seen.has(f.tid)) return false;
        run.seen.add(f.tid);
        if (f.time > run.lastTime) run.lastTime = f.time;
        return true;
      });
      addBuybacks(run.totals, fills, start, (buy) => run.recent.push(buy));
      run.recent.sort((a, b) => b.time - a.time);
      run.recent.length = Math.min(run.recent.length, AfBuybacksService.RECENT_FILLS);
      this.running = run;
      return { start, totals: { ...run.totals }, recent: run.recent.slice(), readAt: now };
    } catch (error) {
      logDeduplicator.error('Failed to read the Assistance Fund fills', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /** Reads the window's missing completed days in the background, one run at a time. */
  private startBackfill(todayStart: number): void {
    if (this.backfill || Date.now() < this.backfillRetryAt) return;
    const missing = this.missingDays(todayStart);
    if (!missing.length) return;

    this.backfill = this.readCompletedDays(missing)
      .catch((error) => {
        this.backfillRetryAt = Date.now() + AfBuybacksService.RETRY_AFTER_MS;
        logDeduplicator.warn('Failed to read Assistance Fund buyback days', {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.backfill = null;
      });
  }

  /** Completed days of the window neither held nor known unreadable, newest first. */
  private missingDays(todayStart: number): number[] {
    const now = Date.now();
    const missing: number[] = [];
    for (let i = 1; i <= AfBuybacksService.WINDOW_DAYS; i++) {
      const start = todayStart - i * DAY_MS;
      if (this.days.has(start) || this.unreadable.has(start)) continue;
      if (now < start + DAY_MS + AfBuybacksService.SETTLE_MS) continue;
      missing.push(start);
    }
    return missing;
  }

  /** Newest day alone first (it lands in seconds), then the rest in batches. */
  private async readCompletedDays(starts: number[]): Promise<void> {
    const [newest, ...rest] = starts;
    await this.readAndKeep([newest]);
    for (let i = 0; i < rest.length; i += AfBuybacksService.DAYS_PER_BATCH) {
      await this.readAndKeep(rest.slice(i, i + AfBuybacksService.DAYS_PER_BATCH));
    }
  }

  /**
   * Reads each day whole, then Hyperliquid's oldest fill: the horizon only
   * moves forward, so a horizon read afterwards no later than a day's start
   * proves every fill of that day was there when the day was read.
   */
  private async readAndKeep(starts: number[]): Promise<void> {
    const read = new Map<number, AfBuybackTotals>();
    for (const start of starts) {
      const totals: AfBuybackTotals = { hype: 0, usd: 0, fills: 0 };
      addBuybacks(totals, await this.readFills(start, start + DAY_MS - 1, true), start);
      read.set(start, totals);
    }

    const horizon = await this.readHorizon();
    for (const [start, totals] of read) {
      if (horizon <= start) this.days.set(start, totals);
      else this.unreadable.add(start);
    }
    logDeduplicator.info('Assistance Fund buyback days read', {
      kept: [...read.keys()].filter((start) => this.days.has(start)).length,
      pastHorizon: [...read.keys()].filter((start) => this.unreadable.has(start)).length,
    });
    await this.saveStore();
  }

  /** Time of the oldest fill Hyperliquid still serves for the fund. */
  private async readHorizon(): Promise<number> {
    await this.waitForBudget();
    const rows = await this.client.userFillsByTime(RY_ASSISTANCE_FUND, 0, Date.now());
    if (!Array.isArray(rows)) throw new Error('Unexpected userFillsByTime payload');
    this.charge(readWeight(rows.length));
    return rows.reduce((oldest, f) => Math.min(oldest, f.time), Infinity);
  }

  /**
   * Every fill from `startTime` to `endTime`: pages of PAGE_SIZE, each one
   * starting at the last fill time of the previous one (fills of that
   * millisecond come again and are deduped by tid). `paced` reads wait for
   * the background weight budget; all reads count against it.
   */
  private async readFills(startTime: number, endTime: number, paced: boolean): Promise<RawFill[]> {
    const fills: RawFill[] = [];
    const seen = new Set<number>();
    let from = startTime;
    for (let page = 0; page < AfBuybacksService.MAX_PAGES; page++) {
      if (paced) await this.waitForBudget();
      const rows = await this.client.userFillsByTime(RY_ASSISTANCE_FUND, from, endTime);
      if (!Array.isArray(rows)) throw new Error('Unexpected userFillsByTime payload');
      this.charge(readWeight(rows.length));

      for (const f of rows) {
        if (seen.has(f.tid)) continue;
        seen.add(f.tid);
        fills.push(f);
      }
      if (rows.length < AfBuybacksService.PAGE_SIZE) return fills;

      const last = rows.reduce((latest, f) => Math.max(latest, f.time), from);
      if (last <= from) throw new Error('A full page of fills within one millisecond');
      from = last;
    }
    throw new Error(`More than ${AfBuybacksService.MAX_PAGES} pages of fills`);
  }

  /** Books `weight` against the background budget. */
  private charge(weight: number): void {
    this.paceUntil =
      Math.max(this.paceUntil, Date.now()) + (weight / AfBuybacksService.MAX_WEIGHT_PER_MINUTE) * 60_000;
  }

  private async waitForBudget(): Promise<void> {
    const wait = this.paceUntil - Date.now();
    if (wait > 0) await sleep(wait);
  }

  /**
   * Kept days from Redis, once Redis could be read: while it can't, the next
   * request tries again (meanwhile the days are read from Hyperliquid, as far
   * as its horizon allows).
   */
  private loadStore(): Promise<void> {
    if (!this.storeLoad) {
      this.storeLoad = this.readStoredDays().then((stored) => {
        if (!stored) {
          this.storeLoad = null;
          return;
        }
        this.adoptDays(stored);
      });
    }
    return this.storeLoad;
  }

  /** Stored days not held in memory. */
  private adoptDays(stored: Map<number, AfBuybackTotals>): void {
    for (const [start, totals] of stored) {
      if (!this.days.has(start)) this.days.set(start, totals);
    }
  }

  /** The kept days; null when Redis can't be read (mget tells it apart from nothing stored). */
  private async readStoredDays(): Promise<Map<number, AfBuybackTotals> | null> {
    const values = await redisService.mget([AfBuybacksService.STORE_KEY]);
    if (!values) return null;
    const stored = new Map<number, AfBuybackTotals>();
    try {
      const raw = values[0];
      if (!raw) return stored;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const [key, value] of Object.entries(parsed)) {
        const start = Number(key);
        if (Number.isInteger(start) && start % DAY_MS === 0 && isTotals(value)) {
          stored.set(start, { hype: value.hype, usd: value.usd, fills: value.fills });
        }
      }
    } catch (error) {
      logDeduplicator.warn('AfBuybacksService: failed to read the kept days', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return stored;
  }

  /**
   * Kept days merged with what is in Redis (another instance may have read
   * some, or the boot read failed). Skipped while Redis can't be read: the
   * days stay in memory and go with the next save.
   */
  private async saveStore(): Promise<void> {
    const stored = await this.readStoredDays();
    if (!stored) {
      logDeduplicator.warn('AfBuybacksService: Redis unreadable, kept days not saved');
      return;
    }
    this.adoptDays(stored);
    const cutoff = utcDayStart(Date.now()) - AfBuybacksService.KEEP_DAYS * DAY_MS;
    const merged: Record<string, AfBuybackTotals> = {};
    for (const [start, totals] of this.days) {
      if (start >= cutoff) merged[start] = totals;
      else this.days.delete(start);
    }
    await redisService.set(
      AfBuybacksService.STORE_KEY,
      JSON.stringify(merged),
      AfBuybacksService.STORE_TTL_SECONDS
    );
  }
}
