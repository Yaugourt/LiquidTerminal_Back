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
 * at once and one heavy view at a time, the most overdue first. A view that
 * fails keeps its last value and is retried later.
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
   * The view's last value. Never computes: a view without a value waits for
   * the scheduler's first computation, COLD_WAIT_MS at most, then answers
   * ViewWarmingError.
   */
  public async read<T>(def: ViewDef<T>): Promise<ViewResult<T>> {
    const view = this.ensure(def);
    const now = Date.now();
    view.askedAt = now;
    await this.refreshFromStore(view, now);
    if (view.at === null) {
      this.pump();
      await this.waitForValue(view);
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
    try {
      if (!redisService.isHealthy()) {
        // Nothing can be found there: the view is computed rather than waited for.
        view.loaded = true;
        return;
      }
      const raw = await redisService.get(`${view.def.key}:swr`);
      view.loaded = true;
      if (!raw) return;
      const entry = JSON.parse(raw) as { at?: unknown; value?: unknown };
      if (typeof entry.at !== 'number' || !('value' in entry)) return;
      if (view.at === null || entry.at > view.at) {
        view.value = entry.value;
        view.at = entry.at;
        // Whoever was waiting for a first value has one.
        this.release(view);
      }
    } catch (error) {
      logDeduplicator.warn('View scheduler: stored value unreadable', {
        view: view.def.key,
        errorType: error instanceof Error ? error.name : typeof error,
      });
    }
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
   * How overdue a view is, as a multiple of its period; 0 when it is not due.
   * A view without a value is due at once when someone waits for it or it is
   * to be kept warm, ahead of every view that only needs a newer value.
   */
  private urgency(view: ViewState, now: number): number {
    if (view.running || now < view.retryAt) return 0;
    const period = this.period(view, now);
    if (view.at === null) {
      if (view.waiters.length > 0) return Number.MAX_VALUE;
      return Number.isFinite(period) && view.loaded ? Number.MAX_VALUE / 2 : 0;
    }
    const overdue = (now - view.at) / period;
    return overdue >= 1 ? overdue : 0;
  }

  /** Starts as many due views as there are free slots, the most overdue first. */
  private pump(): void {
    if (!this.started) return;
    const now = Date.now();
    // What the previous process (or another instance) left is looked for before a view is called cold.
    for (const view of this.views.values()) {
      if (!view.loaded && now - view.checkedAt >= RECHECK_MS) void this.refreshFromStore(view, now);
    }
    while (this.running < MAX_CONCURRENT) {
      let next: ViewState | null = null;
      let nextUrgency = 0;
      for (const view of this.views.values()) {
        if (view.def.cadence.heavy && this.heavyRunning > 0) continue;
        const urgency = this.urgency(view, now);
        // Equally overdue: the light one first, it frees its slot sooner.
        if (urgency > nextUrgency || (urgency === nextUrgency && urgency > 0 && next?.def.cadence.heavy && !view.def.cadence.heavy)) {
          next = view;
          nextUrgency = urgency;
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
        } catch {
          // Redis unusable: computed without the lock rather than not at all.
          locked = false;
        }
        if (!locked && redisService.isHealthy()) {
          // Another instance is computing it: its value is looked for shortly.
          elsewhere = true;
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
      const data = await view.def.compute();
      await this.keep(view, data, startedAt);
      view.lastDurationMs = Date.now() - startedAt;
      view.failures = 0;
      view.retryAt = 0;
      view.lastError = null;
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
