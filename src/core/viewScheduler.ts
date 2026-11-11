import { randomUUID } from 'crypto';
import { redisService } from './redis.service';
import { logDeduplicator } from '../utils/logDeduplicator';
import { positiveIntEnv } from '../utils/env';

/** How often a view is computed. */
export interface ViewCadence {
  /** Seconds between two computations while the view is being asked for. */
  activeS: number;
  /** Seconds between two when nobody asks; 0: not kept warm, computed only while asked. */
  idleS: number;
  /** Takes tens of seconds: at most one such view is computed at a time. */
  heavy?: boolean;
  /**
   * Takes milliseconds: a request that finds it without a value computes it
   * on the spot instead of waiting for the scheduler (a status must answer in
   * the first seconds of a process too).
   */
  cheap?: boolean;
}

/** A view and how to compute it. `key` is also where its value is stored. */
export interface ViewDef<T> {
  key: string;
  compute: () => Promise<T>;
  cadence: ViewCadence;
}

/** A view's value, with the moment the computation that produced it started. */
export class ViewResult<T> {
  constructor(
    public readonly data: T,
    /** ISO time the value is "as of": when its computation began. */
    public readonly computedAt: string,
    /** Seconds between two computations while the view is watched. */
    public readonly refreshEveryS: number
  ) {}
}

/** The view has no value yet and its first computation is not done: come back shortly. */
export class ViewWarmingError extends Error {
  constructor(public readonly retryAfterS: number) {
    super('VIEW_WARMING_UP');
    this.name = 'ViewWarmingError';
  }
}

/** A computation did not end within its deadline: its slot is given back, its result (if any ever comes) is still kept. */
export class ViewDeadlineError extends Error {
  constructor() {
    super('VIEW_COMPUTATION_DEADLINE');
    this.name = 'ViewDeadlineError';
  }
}

interface Waiter {
  resolve: () => void;
  timer: NodeJS.Timeout;
}

interface ViewState {
  def: ViewDef<unknown>;
  /** The last value this process holds, and when its computation started; undefined before the first one is known. */
  value: unknown;
  at: number | null;
  /** Whether the stored value was looked for (once, and again when the held one is overdue). */
  loaded: boolean;
  checkedAt: number;
  /** Looks at the store that failed in a row: after two, the view is computed without it. */
  loadFailures: number;
  /** A cheap view being computed for the requests that found it without a value. */
  inline: Promise<void> | null;
  /** Last request for it, in this process. */
  askedAt: number;
  running: boolean;
  lastDurationMs: number | null;
  failures: number;
  retryAt: number;
  lastError: string | null;
  waiters: Waiter[];
}

/** Views computed at once. */
const MAX_CONCURRENT = positiveIntEnv('VIEW_SCHEDULER_CONCURRENCY', 2);
/** A view asked for within this long is "watched": the pages poll every 60 to 120 s. */
const ACTIVE_WINDOW_MS = 300_000;
/** How long a request waits for the first computation of a view that has no value at all. */
const COLD_WAIT_MS = 20_000;
/**
 * How long a value is kept in Redis: what is served, with its age, if the scheduler falls
 * behind. A day for the views kept warm, six hours for the ones computed only while asked.
 */
const KEEP_WARM_S = 24 * 3600;
const KEEP_ON_DEMAND_S = 6 * 3600;
const LOCK_TTL_S = 120;
const LOCK_RENEW_MS = 45_000;
const TICK_MS = 1_000;
/** An overdue value held here is looked for again in the store at most this often (another instance may have computed it). */
const RECHECK_MS = 5_000;
const RETRY_MIN_MS = 15_000;
const RETRY_MAX_MS = 600_000;
/**
 * The least time between the end of a computation and the start of the next one of the same
 * view: as long as it took, 5 s at least, never more than its period. A view that takes longer
 * than its period (a slow database) would otherwise be due again the moment it ends and run
 * back to back, which is the overload feeding itself.
 */
const MIN_GAP_MS = 5_000;
/**
 * The longest a computation may hold its slot. Past it the slot and the lock are given back
 * and the view is retried later; a query that never answers (a connection gone silent) must
 * not take one of the two slots for good, and with it every other view. Above what the
 * statements themselves are allowed (10 min on the aggregates' pool) for the heavy ones.
 */
const LIGHT_DEADLINE_MS = 180_000;
const HEAVY_DEADLINE_MS = 720_000;

const RELEASE_LOCK = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;
const RENEW_LOCK = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('expire', KEYS[1], ARGV[2]) else return 0 end`;

/**
 * Computes slow, shared aggregates on the server's own schedule.
 *
 * These views used to be recomputed when a visitor asked for one that was
 * older than a minute: the visits decided what ran, and how many at once. One
 * tab opening after a quiet night started every view together on a pool of 10
 * connections; a 7-day aggregate that takes 25 s was started again every
 * minute; and a value nobody had asked for was served, hours old, to the first
 * visitor without its age.
 *
 * Here a request never starts a computation. It reads the last value, with
 * the time it is as of, and marks the view as watched. The scheduler computes
 * each view at its own period (shorter while watched), at most MAX_CONCURRENT
 * at once and one heavy view at a time. Order: a view someone is waiting for
 * with nothing to show, then the views kept warm, the most overdue first, then
 * the ones computed only while asked (they never delay the others). A view
 * that fails or passes its deadline keeps its last value and is retried later.
 *
 * The value lives in this process and in Redis (`<key>:swr`, the format the
 * views were stored in before: a deploy finds them there). Redis down: the
 * views keep being computed and served from memory. A lock per view keeps two
 * instances from computing the same one.
 */
export class ViewScheduler {
  private static instance: ViewScheduler;
  private readonly views = new Map<string, ViewState>();
  private running = 0;
  private heavyRunning = 0;
  private timer: NodeJS.Timeout | null = null;
  private started = false;

  public static getInstance(): ViewScheduler {
    if (!ViewScheduler.instance) ViewScheduler.instance = new ViewScheduler();
    return ViewScheduler.instance;
  }

  /** Starts computing: until then requests are served what is stored, and nothing is computed. */
  public start(): void {
    if (this.started) return;
    this.started = true;
    this.timer = setInterval(() => this.pump(), TICK_MS);
    this.timer.unref?.();
    this.pump();
  }

  public stop(): void {
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const view of this.views.values()) this.release(view);
  }

  /** Makes a view known (and kept warm when its cadence says so) without asking for it. */
  public register<T>(def: ViewDef<T>): void {
    this.ensure(def);
  }

  /**
   * Counts a view as asked for without reading it: for a view that another
   * one is built from, so that both follow the same visitors.
   */
  public watch<T>(def: ViewDef<T>): void {
    this.ensure(def).askedAt = Date.now();
  }

  /**
   * The view's last value. Never computes (a cheap view apart, when it has no
   * value): a view without a value waits for the scheduler's first
   * computation, COLD_WAIT_MS at most, then answers ViewWarmingError.
   */
  public async read<T>(def: ViewDef<T>): Promise<ViewResult<T>> {
    const view = this.ensure(def);
    const now = Date.now();
    view.askedAt = now;
    this.expire(view, now);
    await this.refreshFromStore(view, now);
    if (view.at === null) {
      if (view.def.cadence.cheap) {
        await this.computeInline(view);
      } else {
        // Its computation just failed and waits for its retry: said at once, not after a wait that cannot succeed.
        if (view.failures > 0 && !view.running && now < view.retryAt) {
          throw new ViewWarmingError(Math.min(60, Math.max(1, Math.ceil((view.retryAt - now) / 1000))));
        }
        this.pump();
        await this.waitForValue(view);
      }
      if (view.at === null) throw new ViewWarmingError(5);
    }
    return new ViewResult(view.value as T, new Date(view.at).toISOString(), view.def.cadence.activeS);
  }

  /**
   * For a view read from inside another view's computation: its stored value,
   * or computed right here when it has none. Waiting for the scheduler there
   * would hold one of its slots while asking it for another.
   */
  public async readOrCompute<T>(def: ViewDef<T>): Promise<T> {
    const view = this.ensure(def);
    await this.refreshFromStore(view, Date.now());
    if (view.at === null) {
      const startedAt = Date.now();
      const data = await def.compute();
      // A scheduled computation may have landed meanwhile: keep the newer one.
      if (view.at === null || view.at < startedAt) await this.keep(view, data, startedAt);
    }
    return view.value as T;
  }

  /** Where each view stands: for the status route. */
  public describe(): Array<Record<string, unknown>> {
    const now = Date.now();
    return [...this.views.values()]
      .map((view) => ({
        view: view.def.key,
        computedAt: view.at === null ? null : new Date(view.at).toISOString(),
        ageS: view.at === null ? null : Math.round((now - view.at) / 1000),
        everyS: Number.isFinite(this.period(view, now)) ? this.period(view, now) / 1000 : null,
        watched: now - view.askedAt <= ACTIVE_WINDOW_MS,
        running: view.running,
        lastDurationMs: view.lastDurationMs,
        lastError: view.lastError,
      }))
      .sort((a, b) => String(a.view).localeCompare(String(b.view)));
  }

  private ensure<T>(def: ViewDef<T>): ViewState {
    let view = this.views.get(def.key);
    if (!view) {
      view = {
        def: def as ViewDef<unknown>,
        value: undefined,
        at: null,
        loaded: false,
        checkedAt: 0,
        loadFailures: 0,
        inline: null,
        askedAt: 0,
        running: false,
        lastDurationMs: null,
        failures: 0,
        retryAt: 0,
        lastError: null,
        waiters: [],
      };
      this.views.set(def.key, view);
    } else {
      // The same view, described again by its caller: the latest closure is the one to run.
      view.def = def as ViewDef<unknown>;
    }
    return view;
  }

  /** The period in force: the active one while the view is watched, else the idle one (never, when it has none). */
  private period(view: ViewState, now: number): number {
    if (now - view.askedAt <= ACTIVE_WINDOW_MS) return view.def.cadence.activeS * 1000;
    return view.def.cadence.idleS > 0 ? view.def.cadence.idleS * 1000 : Infinity;
  }

  /**
   * Looks in the store for a value newer than the one held: the first time a
   * view is met (what the previous process left), and now and then when the
   * held one is overdue and not being computed here (another instance may
   * have computed it). A failed read changes nothing.
   */
  private async refreshFromStore(view: ViewState, now: number, force = false): Promise<void> {
    const overdue = view.at !== null && now - view.at > this.period(view, now);
    if (!force && view.loaded && !(overdue && !view.running && now - view.checkedAt >= RECHECK_MS)) return;
    view.checkedAt = now;
    if (!redisService.isHealthy()) {
      // Nothing can be found there: the view is computed rather than waited for.
      view.loaded = true;
      return;
    }
    let raw: string | null;
    try {
      // The client itself: the service's own get answers "no value" for a failed read too,
      // and a view the store does hold would be taken for one that was never computed.
      raw = await redisService.getClient().get(`${view.def.key}:swr`);
      view.loadFailures = 0;
    } catch (error) {
      view.loadFailures += 1;
      // Looked for again shortly; after two failed looks the view is computed without the store.
      if (view.loadFailures >= 2) view.loaded = true;
      logDeduplicator.warn('View scheduler: stored value unreadable', {
        view: view.def.key,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      return;
    }
    view.loaded = true;
    if (!raw) return;
    try {
      const entry = JSON.parse(raw) as { at?: unknown; value?: unknown };
      if (typeof entry.at !== 'number' || !('value' in entry)) return;
      if (view.at === null || entry.at > view.at) {
        view.value = entry.value;
        view.at = entry.at;
        // Whoever was waiting for a first value has one.
        this.release(view);
      }
    } catch {
      // Not a value of ours: as if there were none.
    }
  }

  /**
   * A view computed only while asked keeps no value past what its stored copy
   * lasts: left alone for hours, it is computed again before it is served, not
   * served hours old from this process's memory.
   */
  private expire(view: ViewState, now: number): void {
    if (view.def.cadence.idleS > 0 || view.at === null || view.running) return;
    if (now - view.at <= KEEP_ON_DEMAND_S * 1000) return;
    view.value = undefined;
    view.at = null;
    view.loaded = false;
    view.checkedAt = 0;
  }

  /** Computes a cheap view for the requests that found it without a value, once for all of them. */
  private computeInline(view: ViewState): Promise<void> {
    view.inline ??= (async () => {
      const startedAt = Date.now();
      try {
        const data = await view.def.compute();
        if (view.at === null || view.at < startedAt) await this.keep(view, data, startedAt);
      } finally {
        view.inline = null;
      }
    })();
    return view.inline;
  }

  /** Holds a computed value here and stores it; a failed store leaves it served from memory. */
  private async keep(view: ViewState, data: unknown, startedAt: number): Promise<void> {
    view.value = data;
    view.at = startedAt;
    view.loaded = true;
    try {
      if (redisService.isHealthy()) {
        const keepS = view.def.cadence.idleS > 0 ? KEEP_WARM_S : KEEP_ON_DEMAND_S;
        await redisService.set(`${view.def.key}:swr`, JSON.stringify({ at: startedAt, value: data }), keepS);
      }
    } catch (error) {
      logDeduplicator.warn('View scheduler: value not stored', {
        view: view.def.key,
        errorType: error instanceof Error ? error.name : typeof error,
      });
    }
  }

  private waitForValue(view: ViewState): Promise<void> {
    return new Promise((resolve) => {
      const waiter: Waiter = {
        resolve,
        timer: setTimeout(() => {
          view.waiters = view.waiters.filter((w) => w !== waiter);
          resolve();
        }, COLD_WAIT_MS),
      };
      waiter.timer.unref?.();
      view.waiters.push(waiter);
    });
  }

  private release(view: ViewState): void {
    for (const waiter of view.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }

  /**
   * Whether a view is due, and how it ranks: `tier` 0 for a view someone is
   * waiting for with nothing to show, 1 for a view kept warm, 2 for one
   * computed only while asked; `score` is how overdue it is, as a multiple of
   * its period. Null when it is not due.
   */
  private rank(view: ViewState, now: number): { tier: number; score: number } | null {
    if (view.running || view.inline || now < view.retryAt) return null;
    const period = this.period(view, now);
    const keptWarm = view.def.cadence.idleS > 0;
    if (view.at === null) {
      if (view.waiters.length > 0) return { tier: 0, score: 1 };
      // Without a value and to be kept warm or watched: due as soon as the store was looked at.
      return Number.isFinite(period) && view.loaded ? { tier: keptWarm ? 1 : 2, score: Number.MAX_VALUE } : null;
    }
    const overdue = (now - view.at) / period;
    return overdue >= 1 ? { tier: keptWarm ? 1 : 2, score: overdue } : null;
  }

  /** Starts as many due views as there are free slots, in the order `rank` gives. */
  private pump(): void {
    if (!this.started) return;
    const now = Date.now();
    // What the previous process (or another instance) left is looked for before a view is called cold.
    for (const view of this.views.values()) {
      if (!view.loaded && now - view.checkedAt >= RECHECK_MS) void this.refreshFromStore(view, now);
    }
    // Until the store has been looked at for every view kept warm, it is not known which of them
    // are due: the views computed only while asked wait for that, they come after them.
    let warmUnknown = false;
    for (const view of this.views.values()) {
      if (view.def.cadence.idleS > 0 && !view.loaded) warmUnknown = true;
    }
    while (this.running < MAX_CONCURRENT) {
      let next: ViewState | null = null;
      let best: { tier: number; score: number } | null = null;
      for (const view of this.views.values()) {
        const rank = this.rank(view, now);
        if (!rank) continue;
        if (rank.tier === 2 && warmUnknown) continue;
        // One heavy view at a time, unless someone is waiting on this one with nothing to show.
        if (view.def.cadence.heavy && this.heavyRunning > 0 && rank.tier > 0) continue;
        const better =
          !best ||
          rank.tier < best.tier ||
          (rank.tier === best.tier &&
            (rank.score > best.score ||
              // Equally due: the light one first, it frees its slot sooner.
              (rank.score === best.score && Boolean(next?.def.cadence.heavy) && !view.def.cadence.heavy)));
        if (better) {
          next = view;
          best = rank;
        }
      }
      if (!next) return;
      void this.run(next);
    }
  }

  private async run(view: ViewState): Promise<void> {
    const heavy = Boolean(view.def.cadence.heavy);
    view.running = true;
    this.running += 1;
    if (heavy) this.heavyRunning += 1;
    const startedAt = Date.now();
    const lockKey = `lock:${view.def.key}:swr`;
    const token = randomUUID();
    let locked = false;
    // True when another instance holds the view: nothing was computed here, its waiters keep waiting.
    let elsewhere = false;
    let renewal: NodeJS.Timeout | undefined;
    try {
      if (redisService.isHealthy()) {
        try {
          locked = Boolean(await redisService.getClient().set(lockKey, token, 'EX', LOCK_TTL_S, 'NX'));
          // Refused, not failed: another instance holds it and is computing the view.
          elsewhere = !locked;
        } catch {
          // The lock cannot be taken at all (Redis refusing writes, a failover): computed
          // without it rather than not at all.
          locked = false;
        }
        if (elsewhere) {
          // Its value is looked for shortly.
          view.retryAt = startedAt + RECHECK_MS;
          view.loaded = false;
          view.checkedAt = 0;
          return;
        }
      }
      if (locked) {
        renewal = setInterval(() => {
          void Promise.resolve(redisService.getClient().eval(RENEW_LOCK, 1, lockKey, token, String(LOCK_TTL_S))).catch(() => undefined);
        }, LOCK_RENEW_MS);
        renewal.unref?.();
      }
      // With the lock in hand: another instance may have just computed it. Its value is taken,
      // and nothing is computed here if that leaves the view up to date.
      if (locked) {
        const known = view.at;
        await this.refreshFromStore(view, startedAt, true);
        if (view.at !== null && view.at !== known && startedAt - view.at < this.period(view, startedAt)) return;
      }
      const computing = view.def.compute();
      let deadline: NodeJS.Timeout | undefined;
      let data: unknown;
      try {
        data = await Promise.race([
          computing,
          new Promise<never>((_, reject) => {
            deadline = setTimeout(() => reject(new ViewDeadlineError()), heavy ? HEAVY_DEADLINE_MS : LIGHT_DEADLINE_MS);
            deadline.unref?.();
          }),
        ]);
      } catch (error) {
        if (error instanceof ViewDeadlineError) {
          // Left behind, not cancelled: if it does end, its value is still the newest there is.
          computing.then(
            (late) => {
              if (view.at === null || view.at < startedAt) void this.keep(view, late, startedAt).then(() => this.release(view));
            },
            () => undefined
          );
        }
        throw error;
      } finally {
        if (deadline) clearTimeout(deadline);
      }
      await this.keep(view, data, startedAt);
      const ended = Date.now();
      view.lastDurationMs = ended - startedAt;
      view.failures = 0;
      view.lastError = null;
      // Not again before a pause as long as it took (see MIN_GAP_MS).
      const period = this.period(view, ended);
      view.retryAt = ended + Math.min(Number.isFinite(period) ? period : RETRY_MAX_MS, Math.max(MIN_GAP_MS, view.lastDurationMs));
    } catch (error) {
      view.failures += 1;
      view.lastDurationMs = Date.now() - startedAt;
      view.lastError = error instanceof Error ? error.name : typeof error;
      // The last value keeps being served; tried again later, further apart each time.
      view.retryAt = Date.now() + Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.min(view.failures - 1, 6));
      logDeduplicator.warn('View scheduler: computation failed', {
        view: view.def.key,
        errorType: view.lastError,
        failures: view.failures,
      });
    } finally {
      if (renewal) clearInterval(renewal);
      if (locked) void Promise.resolve(redisService.getClient().eval(RELEASE_LOCK, 1, lockKey, token)).catch(() => undefined);
      view.running = false;
      this.running -= 1;
      if (heavy) this.heavyRunning -= 1;
      if (!elsewhere) this.release(view);
      this.pump();
    }
  }
}

export const viewScheduler = ViewScheduler.getInstance();
