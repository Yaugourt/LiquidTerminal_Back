import { ElysiumIngestRepository } from '../../repositories/prisma/prisma.elysium.repository';
import { ElysiumRollupRepository } from '../../repositories/prisma/prisma.elysium-rollup.repository';
import { ElysiumWindowRepository } from '../../repositories/prisma/prisma.elysium-window.repository';
import { prismaHistorical } from '../../core/prisma.historical.service';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { tickStep } from './elysium-tick';
import { ELYSIUM_GENESIS } from './elysium-ingest.util';
import { planWindow, readRollupCoverage, windowsEnabled } from './elysium-rollup.reader';
import {
  closedRollupDays,
  closedRollupHours,
  firstKeptDay,
  HOUR_KEEP_SLACK,
  HOUR_MS,
  HOUR_RECENT_KEEP,
  isWithinDays,
  keptRollupHours,
  nextRollupWakeMs,
  ROLLUP_CALLERS_BUILD_DAYS,
  ROLLUP_CALLERS_KEEP_DAYS,
  rollupKeepDays,
  ROLLUP_SENDERS_BUILD_DAYS,
  ROLLUP_SENDERS_KEEP_DAYS,
  utcHourStart,
  WINDOW_SPANS,
} from './elysium-rollup.util';
import { windowTarget, windowWork } from './elysium-window.util';

/** Next pass when every closed day is built: a new day closes once in 24 h, a dirty one is rare. */
const IDLE_INTERVAL_MS = 5 * 60_000;
/** Pause between two days while several are waiting (first start, or after a long stop). */
const BACKLOG_INTERVAL_MS = 5_000;
/** Old days are dropped at most this often. */
const PRUNE_EVERY_MS = 6 * 3_600_000;
/** A drop that failed is tried again after this long. */
const PRUNE_RETRY_MS = 30 * 60_000;
/** A day whose build failed is left alone for this long, doubled at each failure, up to RETRY_MAX_MS. */
const RETRY_MIN_MS = 5 * 60_000;
const RETRY_MAX_MS = 6 * 3_600_000;
/** Hours built in one pass at most, and the time one pass gives them: the rest waits for the next pass, 5 s later. */
const HOURS_PER_PASS = 12;
const HOURS_PASS_BUDGET_MS = 60_000;
/** Old hours are dropped at most this often. */
const HOUR_PRUNE_EVERY_MS = 3_600_000;
/** The classes of a window table's rows are looked at again this often when nothing else touched the table. */
const RECLASSIFY_EVERY_MS = 5 * 60_000;
const DAY_MS = 86_400_000;

/**
 * Builds the Elysium rollups from elysium_tx, one pass at a time, run by the
 * ingestion's scheduler under its Redis lock. A pass does, in this order:
 *
 * 1. the hours that closed, and the older ones the windows' edges need
 *    (wantedRollupHours): a few seconds each, several per pass;
 * 2. the window tables (elysium_target_window, one per span): brought to what
 *    a window of that span holds now when an hour or a day was added, their
 *    classes looked at again otherwise;
 * 3. one closed UTC day, newest first: minutes, once a day.
 *
 * The first passes after this ships build the kept history.
 *
 * A day whose build fails is set aside for a while and the next pass builds
 * the next day that waits: the newest day used to be tried again on every
 * pass, so one day that kept failing held every older one, and the dropping
 * of old days with them.
 *
 * Nothing reads a day before it is built: until then the analytics read that
 * day from elysium_tx, as they always did. A failed or late build costs speed,
 * never a figure.
 */
export class ElysiumRollupService {
  private static instance: ElysiumRollupService;

  private readonly states = ElysiumIngestRepository.getInstance();
  private readonly repo = ElysiumRollupRepository.getInstance();
  private readonly windows = ElysiumWindowRepository.getInstance();
  private lastPruneAt = 0;
  private lastHourPruneAt = 0;
  /** Days whose build failed: how often, when to try again, and what the last failure said. */
  private readonly failed = new Map<string, { failures: number; retryAt: number; message: string }>();
  /** Hours whose build failed, the same way (keyed by the hour's start, epoch ms). */
  private readonly failedHours = new Map<number, { failures: number; retryAt: number; message: string }>();
  /** The last failure of each window table's upkeep (key 0: the pass over the classes), until it works again. */
  private readonly windowErrors = new Map<number, string>();
  private reclassifiedAt = 0;

  public static getInstance(): ElysiumRollupService {
    if (!ElysiumRollupService.instance) {
      ElysiumRollupService.instance = new ElysiumRollupService();
    }
    return ElysiumRollupService.instance;
  }

  public static isEnabled(): boolean {
    return (process.env.ELYSIUM_ROLLUPS_ENABLED ?? 'true').trim().toLowerCase() !== 'false';
  }

  /**
   * Records how the pass ended: clears the builder's last error (shown by the status route), or
   * keeps the one of a day that still fails, so that it stays visible while other days are built.
   */
  private async passed(now: Date): Promise<void> {
    const failing = [...this.failed.entries()].sort((a, b) => a[0].localeCompare(b[0])).pop();
    const failingHour = [...this.failedHours.entries()].sort((a, b) => a[0] - b[0]).pop();
    const failingWindow = [...this.windowErrors.entries()][0];
    if (failing) await this.states.recordError('rollup', `${failing[0]}: ${failing[1].message}`);
    else if (failingHour) await this.states.recordError('rollup', `${new Date(failingHour[0]).toISOString()}: ${failingHour[1].message}`);
    else if (failingWindow) await this.states.recordError('rollup', `window ${failingWindow[0] || 'classes'}: ${failingWindow[1]}`);
    else await this.states.advance('rollup', { cursor: now });
  }

  /**
   * The hours that wait for their rollup, the most pressing first, a few per pass. Resolves to
   * whether some are left for the next pass.
   */
  private async buildHours(now: Date, cursor: Date | null): Promise<boolean> {
    const closed = closedRollupHours(cursor, now, ELYSIUM_GENESIS);
    if (closed.length === 0) return false;
    const known = new Map((await this.repo.listHours(Math.min(...closed))).map((h) => [h.hour, h]));
    const pending = closed.filter((hour) => {
      const state = known.get(hour);
      return !state || !state.built || state.dirty;
    });
    for (const hour of this.failedHours.keys()) if (!pending.includes(hour)) this.failedHours.delete(hour);
    const ready = pending.filter((hour) => (this.failedHours.get(hour)?.retryAt ?? 0) <= now.getTime());

    const startedAt = Date.now();
    let built = 0;
    let left = ready.length;
    for (const hour of ready) {
      if (built >= HOURS_PER_PASS || Date.now() - startedAt >= HOURS_PASS_BUDGET_MS) break;
      left -= 1;
      try {
        const result = await this.repo.buildHour(hour);
        if (result === 'busy') return true;
        this.failedHours.delete(hour);
        if (result === 'built') built += 1;
        else left += 1;
      } catch (error) {
        const failures = (this.failedHours.get(hour)?.failures ?? 0) + 1;
        const message = error instanceof Error ? error.message : String(error);
        this.failedHours.set(hour, {
          failures,
          retryAt: Date.now() + Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** (failures - 1)),
          message: message.slice(0, 300),
        });
        logDeduplicator.warn('Elysium rollups: hour build failed', {
          hour: new Date(hour).toISOString(),
          failures,
          errorType: error instanceof Error ? error.name : typeof error,
        });
      }
      // Each hour is a piece of work of its own for the tick's time limit.
      tickStep();
    }
    if (built > 0) logDeduplicator.info('Elysium rollups: hours pass', { built, waiting: left, ms: Date.now() - startedAt });
    return left > 0;
  }

  /**
   * The window tables: each one brought to what a window of its span holds now, when it
   * differs enough (windowWork), and its classes looked at again every few minutes otherwise.
   * `pendingDays`: the closed days that wait for their rollup. Resolves to whether a table has
   * to be tried again shortly.
   */
  private async maintainWindows(now: Date, pendingDays: string[]): Promise<boolean> {
    if (!windowsEnabled()) return false;
    let again = false;
    let coverage: Awaited<ReturnType<typeof readRollupCoverage>>;
    try {
      coverage = await readRollupCoverage(now, { db: prismaHistorical });
    } catch {
      // Logged by the reader. The tables stay as they are, and the days are still built.
      return true;
    }
    const today = Math.floor(now.getTime() / DAY_MS) * DAY_MS;
    for (const span of WINDOW_SPANS) {
      try {
        const plan = planWindow(new Date(now.getTime() - span * DAY_MS), now, coverage);
        const target = windowTarget(plan, coverage.built);
        if (!target) continue;
        // No day of the window waits for its rollup: the table is not started, nor its base moved, while one does.
        const firstDay = new Date(today - span * DAY_MS).toISOString().slice(0, 10);
        const settled = !pendingDays.some((day) => day >= firstDay);
        const state = coverage.windows.get(span);
        const work = windowWork(state, target, coverage.built, coverage.epoch, now, settled);
        if (work.refresh) {
          const startedAt = Date.now();
          const result = await this.windows.refresh(span, target, { rebase: work.rebase });
          if (result !== 'refreshed') again = true;
          logDeduplicator.info('Elysium rollups: window pass', {
            span,
            result,
            rebase: work.rebase,
            days: target.days.length,
            hours: target.hours.length,
            ms: Date.now() - startedAt,
          });
        }
        this.windowErrors.delete(span);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.windowErrors.set(span, message.slice(0, 300));
        logDeduplicator.warn('Elysium rollups: window upkeep failed', { span, errorType: error instanceof Error ? error.name : typeof error });
      }
      tickStep();
    }
    // The classes of the rows, every few minutes: one pass for all the tables.
    if (Date.now() - this.reclassifiedAt >= RECLASSIFY_EVERY_MS) {
      try {
        const changed = await this.windows.reclassify();
        if (changed !== 'busy') {
          this.reclassifiedAt = Date.now();
          if (changed.size > 0) logDeduplicator.info('Elysium rollups: window classes', { changed: Object.fromEntries(changed) });
        }
        this.windowErrors.delete(0);
      } catch (error) {
        this.windowErrors.set(0, (error instanceof Error ? error.message : String(error)).slice(0, 300));
        logDeduplicator.warn('Elysium rollups: window classes not looked at', { errorType: error instanceof Error ? error.name : typeof error });
      }
      tickStep();
    }
    return again;
  }

  /** One pass. Resolves to the delay before the next one. */
  public async tick(): Promise<number> {
    const now = new Date(Date.now());
    const cursor = (await this.states.getState('tx'))?.cursor ?? null;
    const closed = closedRollupDays(cursor, now, ELYSIUM_GENESIS);
    const keep = rollupKeepDays();

    // Old days are dropped on schedule, whatever waits to be built. A drop that fails is tried
    // again half an hour later, and does not keep this pass from building: it used to count as
    // done for six hours, and to end the pass there.
    if (now.getTime() - this.lastPruneAt >= PRUNE_EVERY_MS) {
      try {
        const removed = await this.repo.prune({
          calls: firstKeptDay(now, keep),
          callers: firstKeptDay(now, Math.min(keep, ROLLUP_CALLERS_KEEP_DAYS)),
          senders: firstKeptDay(now, Math.min(keep, ROLLUP_SENDERS_KEEP_DAYS)),
        });
        this.lastPruneAt = now.getTime();
        if (removed > 0) logDeduplicator.info('Elysium rollups: old days dropped', { rows: removed });
      } catch (error) {
        this.lastPruneAt = now.getTime() - PRUNE_EVERY_MS + PRUNE_RETRY_MS;
        logDeduplicator.warn('Elysium rollups: old days not dropped, tried again later', {
          errorType: error instanceof Error ? error.name : typeof error,
        });
      }
      // The drop and the build are two pieces of work: the tick's time limit counts each on its own.
      tickStep();
    }

    // The hours kept are the ones the builder wants and a few before them; the rest goes, once an hour.
    if (now.getTime() - this.lastHourPruneAt >= HOUR_PRUNE_EVERY_MS) {
      try {
        const before = utcHourStart(now.getTime()) - (HOUR_RECENT_KEEP + HOUR_KEEP_SLACK) * HOUR_MS;
        const removed = await this.repo.pruneHours(before, [...keptRollupHours(now, ELYSIUM_GENESIS)]);
        this.lastHourPruneAt = now.getTime();
        if (removed > 0) logDeduplicator.info('Elysium rollups: old hours dropped', { rows: removed });
      } catch (error) {
        this.lastHourPruneAt = now.getTime() - HOUR_PRUNE_EVERY_MS + PRUNE_RETRY_MS;
        logDeduplicator.warn('Elysium rollups: old hours not dropped, tried again later', {
          errorType: error instanceof Error ? error.name : typeof error,
        });
      }
      tickStep();
    }

    const known = new Map((await this.repo.listDays(firstKeptDay(now, keep))).map((d) => [d.day, d]));
    const pending = closed.filter((day) => {
      const state = known.get(day);
      return !state || !state.built || state.dirty;
    });
    // A day that is built again, or left the kept range, is no longer a failing one.
    for (const day of this.failed.keys()) if (!pending.includes(day)) this.failed.delete(day);

    // Hours, then the window tables that read them: seconds of work that every view waits on,
    // done before the day, which takes minutes and comes once in 24 hours.
    const hoursLeft = await this.buildHours(now, cursor);
    const windowsAgain = await this.maintainWindows(now, pending);
    const soon = hoursLeft || windowsAgain;

    const ready = pending.filter((day) => (this.failed.get(day)?.retryAt ?? 0) <= now.getTime());
    if (ready.length === 0) {
      await this.passed(now);
      return soon ? BACKLOG_INTERVAL_MS : nextRollupWakeMs(new Date(Date.now()), IDLE_INTERVAL_MS);
    }

    const day = ready[0];
    const startedAt = Date.now();
    let result: Awaited<ReturnType<ElysiumRollupRepository['buildDay']>>;
    try {
      result = await this.repo.buildDay(day, {
        callers: isWithinDays(day, now, ROLLUP_CALLERS_BUILD_DAYS),
        senders: isWithinDays(day, now, ROLLUP_SENDERS_BUILD_DAYS),
      });
    } catch (error) {
      const failures = (this.failed.get(day)?.failures ?? 0) + 1;
      const message = error instanceof Error ? error.message : String(error);
      this.failed.set(day, {
        failures,
        retryAt: Date.now() + Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** (failures - 1)),
        message: message.slice(0, 300),
      });
      logDeduplicator.warn('Elysium rollups: day build failed', { day, failures, errorType: error instanceof Error ? error.name : typeof error });
      await this.passed(now);
      // The other days that wait are built meanwhile.
      return ready.length > 1 || soon ? BACKLOG_INTERVAL_MS : nextRollupWakeMs(new Date(Date.now()), IDLE_INTERVAL_MS);
    }
    this.failed.delete(day);
    logDeduplicator.info('Elysium rollups: day pass', {
      day,
      result,
      ms: Date.now() - startedAt,
      waiting: pending.length - (result === 'built' ? 1 : 0),
    });
    await this.passed(now);
    if (result === 'busy') return IDLE_INTERVAL_MS;
    // A day just built moves the window tables: the next pass, 5 s later, brings them to it.
    return BACKLOG_INTERVAL_MS;
  }
}
