import { ElysiumIngestRepository } from '../../repositories/prisma/prisma.elysium.repository';
import { ElysiumRollupRepository } from '../../repositories/prisma/prisma.elysium-rollup.repository';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { ELYSIUM_GENESIS } from './elysium-ingest.util';
import {
  closedRollupDays,
  firstKeptDay,
  isWithinDays,
  ROLLUP_CALLERS_BUILD_DAYS,
  ROLLUP_CALLERS_KEEP_DAYS,
  rollupKeepDays,
  ROLLUP_SENDERS_BUILD_DAYS,
  ROLLUP_SENDERS_KEEP_DAYS,
} from './elysium-rollup.util';

/** Next pass when every closed day is built: a new day closes once in 24 h, a dirty one is rare. */
const IDLE_INTERVAL_MS = 5 * 60_000;
/** Pause between two days while several are waiting (first start, or after a long stop). */
const BACKLOG_INTERVAL_MS = 5_000;
/** Old days are dropped at most this often. */
const PRUNE_EVERY_MS = 6 * 3_600_000;
/** A day whose build failed is left alone for this long, doubled at each failure, up to RETRY_MAX_MS. */
const RETRY_MIN_MS = 5 * 60_000;
const RETRY_MAX_MS = 6 * 3_600_000;

/**
 * Builds the Elysium day rollups: one closed UTC day per pass, newest first,
 * from elysium_tx. Run by the ingestion's scheduler (one pass at a time, under
 * its Redis lock); the first passes after this ships build the kept history.
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
  private lastPruneAt = 0;
  /** Days whose build failed: how often, when to try again, and what the last failure said. */
  private readonly failed = new Map<string, { failures: number; retryAt: number; message: string }>();

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
    if (failing) await this.states.recordError('rollup', `${failing[0]}: ${failing[1].message}`);
    else await this.states.advance('rollup', { cursor: now });
  }

  /** One pass. Resolves to the delay before the next one. */
  public async tick(): Promise<number> {
    const now = new Date(Date.now());
    const cursor = (await this.states.getState('tx'))?.cursor ?? null;
    const closed = closedRollupDays(cursor, now, ELYSIUM_GENESIS);
    const keep = rollupKeepDays();

    // Old days are dropped on schedule, whatever waits to be built.
    if (now.getTime() - this.lastPruneAt >= PRUNE_EVERY_MS) {
      this.lastPruneAt = now.getTime();
      const removed = await this.repo.prune({
        calls: firstKeptDay(now, keep),
        callers: firstKeptDay(now, Math.min(keep, ROLLUP_CALLERS_KEEP_DAYS)),
        senders: firstKeptDay(now, Math.min(keep, ROLLUP_SENDERS_KEEP_DAYS)),
      });
      if (removed > 0) logDeduplicator.info('Elysium rollups: old days dropped', { rows: removed });
    }

    const known = new Map((await this.repo.listDays(firstKeptDay(now, keep))).map((d) => [d.day, d]));
    const pending = closed.filter((day) => {
      const state = known.get(day);
      return !state || !state.built || state.dirty;
    });
    // A day that is built again, or left the kept range, is no longer a failing one.
    for (const day of this.failed.keys()) if (!pending.includes(day)) this.failed.delete(day);

    const ready = pending.filter((day) => (this.failed.get(day)?.retryAt ?? 0) <= now.getTime());
    if (ready.length === 0) {
      await this.passed(now);
      return IDLE_INTERVAL_MS;
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
      return ready.length > 1 ? BACKLOG_INTERVAL_MS : IDLE_INTERVAL_MS;
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
    return pending.length > 1 || result === 'dirty' ? BACKLOG_INTERVAL_MS : IDLE_INTERVAL_MS;
  }
}
