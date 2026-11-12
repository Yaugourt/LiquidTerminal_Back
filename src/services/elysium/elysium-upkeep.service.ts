import { ELYSIUM_PROJECTS } from '../../constants/elysium-projects';
import { ElysiumFactsRepository } from '../../repositories/prisma/prisma.elysium-facts.repository';
import { ElysiumPartitionRepository, LEGACY_PARTITION } from '../../repositories/prisma/prisma.elysium-partition.repository';
import { ElysiumIngestRepository, type ElysiumStream } from '../../repositories/prisma/prisma.elysium.repository';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { ELYSIUM_GENESIS } from './elysium-ingest.util';
import {
  dayKey,
  dayStartMs,
  FACTS_FINAL_DAYS,
  finalDay,
  nextDay,
  partitionDaysWanted,
  partitionsToDrop,
  txKeepDays,
} from './elysium-retention.util';
import { ROLLUP_KEEP_DAYS } from './elysium-rollup.util';
import { tickStep } from './elysium-tick';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Next pass when nothing waits. */
const IDLE_INTERVAL_MS = MINUTE_MS;
/** Next pass while a history is still being copied or folded. */
const BACKLOG_INTERVAL_MS = 5_000;
/** What one pass gives each of its jobs before leaving the rest to the next pass. */
const JOB_BUDGET_MS = 30_000;

/**
 * Every pass looks at the rows of the last two hours again: a swap or a trade is read from the
 * logs by its own stream, which can be behind the transactions' by a few minutes.
 */
const SENDER_RECENT_MS = 2 * HOUR_MS;
/**
 * And, a few times a day, at the days the daily comparison with the provider can still add
 * transactions to: a row whose transaction arrives that late gets its sender then.
 */
const SENDER_SWEEP_EVERY_MS = 6 * HOUR_MS;
const SENDER_SWEEP_MS = (FACTS_FINAL_DAYS - 1) * DAY_MS;
/** Days of history copied per transaction, and the overlap between two of them. */
const SENDER_HISTORY_STEP_MS = 2 * DAY_MS;
const SENDER_HISTORY_OVERLAP_MS = 2 * MINUTE_MS;

/** The split of elysium_tx starts at the UTC day this many days ahead: the check of every row has until then. */
const SPLIT_LEAD_DAYS = 2;
/** A bound closer than this is given up for a later one (a check not verified in time, a split that found the table busy for hours). */
const SPLIT_MIN_LEAD_MS = 6 * HOUR_MS;
/** The day tables that can be dropped: this many a pass, the rest on the next ones. */
const DROPS_PER_PASS = 2;
/** Postgres 14 brought the detach that does not block the table's readers: the split is not started on an older server. */
const SPLIT_MIN_SERVER_VERSION = 140000;

/** The directory's contracts (lower case), once each. */
export function directoryContracts(): string[] {
  return [...new Set(ELYSIUM_PROJECTS.flatMap((p) => p.contracts.map((c) => c.address.toLowerCase())))].sort();
}

/**
 * What the ingestion does besides reading the provider, so that elysium_tx can
 * be kept short: one pass a minute, run by the ingestion's scheduler under its
 * Redis lock like a stream. A pass does, each on its own (one that fails is
 * recorded under its own name and does not keep the others from running):
 *
 * 1. `txsender`: copies the sender of their transaction onto the swaps, trades
 *    and launches read from its logs (ElysiumFactsRepository.copyTxSenders);
 * 2. `facts`: folds the UTC days that became final into the history facts,
 *    one day per transaction, and brings the directory's contracts up to the
 *    same day.
 *
 * 3. `txparts`: once ELYSIUM_TX_SPLIT_ENABLED=true, splits elysium_tx in one
 *    table per UTC day (once: see ElysiumPartitionRepository); then keeps the
 *    tables of the days ahead made, and, when a keep is set
 *    (ELYSIUM_TX_KEEP_DAYS), drops the days older than it that nothing reads
 *    any more.
 *
 * The first passes after this ships go through the whole history, a few days
 * per pass. Until they are through, the pages read what is missing from
 * elysium_tx, as they did before: a pass that is late or fails costs speed,
 * never a figure.
 */
export class ElysiumUpkeepService {
  private static instance: ElysiumUpkeepService;

  private readonly states = ElysiumIngestRepository.getInstance();
  private readonly facts = ElysiumFactsRepository.getInstance();
  private readonly parts = ElysiumPartitionRepository.getInstance();
  private lastSenderSweepAt = 0;
  private analyzedDay = '';

  public static getInstance(): ElysiumUpkeepService {
    if (!ElysiumUpkeepService.instance) ElysiumUpkeepService.instance = new ElysiumUpkeepService();
    return ElysiumUpkeepService.instance;
  }

  public static isEnabled(): boolean {
    return (process.env.ELYSIUM_UPKEEP_ENABLED ?? 'true').trim().toLowerCase() !== 'false';
  }

  /**
   * Whether this process may split elysium_tx by day: only when ELYSIUM_TX_SPLIT_ENABLED=true.
   * Off by default on purpose: the releases before this one cannot write to a split table
   * (their insert names a conflict column the split table has no index on), so the split is
   * switched on once going back to them is no longer wanted. A table already split stays split
   * and looked after whatever the variable says.
   */
  public static isSplitEnabled(): boolean {
    return (process.env.ELYSIUM_TX_SPLIT_ENABLED ?? 'false').trim().toLowerCase() === 'true';
  }

  /** One pass. Resolves to the delay before the next one. */
  public async tick(): Promise<number> {
    const now = new Date(Date.now());
    const tx = await this.states.getState('tx');
    let more = false;
    more = (await this.job('txsender', () => this.copySenders(now, tx?.cursor ?? null))) || more;
    more = (await this.job('facts', () => this.foldFacts(now, tx))) || more;
    more = (await this.job('txparts', () => this.keepPartitions(now))) || more;
    return more ? BACKLOG_INTERVAL_MS : IDLE_INTERVAL_MS;
  }

  /**
   * Runs one job of the pass. Its failure is recorded under its own name (the status route and
   * the alerts show it) and the pass goes on. Resolves to whether the job has more to do now.
   */
  private async job(name: ElysiumStream, run: () => Promise<boolean>): Promise<boolean> {
    try {
      const more = await run();
      tickStep();
      return more;
    } catch (error) {
      // A tick that was given up stops here, as every tick does.
      if (error instanceof Error && error.name === 'TickGivenUpError') throw error;
      const message = error instanceof Error ? error.message : String(error);
      try {
        await this.states.recordError(name, message.slice(0, 500));
      } catch {
        // The database is unreachable: the warning below is the only trace.
      }
      logDeduplicator.warn('Elysium upkeep: job failed', { job: name, errorType: error instanceof Error ? error.name : typeof error });
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // 1. The transaction's sender on swaps, trades and launches
  // ---------------------------------------------------------------------------

  private async copySenders(now: Date, txCursor: Date | null): Promise<boolean> {
    // elysium_tx is complete up to the tx stream's cursor: past it, a transaction may simply not be there yet.
    if (!txCursor) return false;
    const target = new Date(Math.min(now.getTime(), txCursor.getTime()));
    const state = await this.states.getState('txsender');

    let copied = await this.facts.copyTxSenders(new Date(target.getTime() - SENDER_RECENT_MS), target);
    tickStep();
    if (now.getTime() - this.lastSenderSweepAt >= SENDER_SWEEP_EVERY_MS && state?.backfillDone) {
      const swept = await this.facts.copyTxSenders(new Date(target.getTime() - SENDER_SWEEP_MS), target);
      copied = { swaps: copied.swaps + swept.swaps, trades: copied.trades + swept.trades, launches: copied.launches + swept.launches };
      this.lastSenderSweepAt = now.getTime();
      tickStep();
    }
    let rows = copied.swaps + copied.trades + copied.launches;

    if (state?.backfillDone) {
      await this.states.advance('txsender', { cursor: target, addRows: rows });
      return false;
    }
    // The history, oldest first, a few days per transaction.
    const startedAt = Date.now();
    let from = state?.cursor ?? ELYSIUM_GENESIS;
    let done = from.getTime() >= target.getTime();
    while (!done && Date.now() - startedAt < JOB_BUDGET_MS) {
      const to = new Date(Math.min(from.getTime() + SENDER_HISTORY_STEP_MS, target.getTime()));
      const step = await this.facts.copyTxSenders(new Date(from.getTime() - SENDER_HISTORY_OVERLAP_MS), to);
      rows += step.swaps + step.trades + step.launches;
      from = to;
      done = to.getTime() >= target.getTime();
      await this.states.advance('txsender', { cursor: to, addRows: rows, ...(done ? { backfillDone: true } : {}) });
      rows = 0;
      tickStep();
    }
    if (done) logDeduplicator.info('Elysium upkeep: transaction senders copied over the whole history');
    return !done;
  }

  // ---------------------------------------------------------------------------
  // 2. History facts
  // ---------------------------------------------------------------------------

  private async foldFacts(now: Date, tx: { cursor: Date | null; backfillDone: boolean } | null): Promise<boolean> {
    const contracts = directoryContracts();
    await this.facts.ensureState();
    await this.facts.registerProjectContracts(contracts);
    const upTo = finalDay(now, tx);
    // The tx stream is still loading its history: any day can still receive rows.
    if (upTo === null) return false;
    const first = await this.facts.firstTxDay();
    if (first === null) return false;

    const startedAt = Date.now();
    const within = (): boolean => Date.now() - startedAt < JOB_BUDGET_MS;
    let standing = await this.facts.standing(contracts);

    // The days every address is folded by, one per transaction.
    let history = standing.history;
    let folded = 0;
    for (;;) {
      const day: string = history === null ? first : nextDay(history);
      if (day > upTo || !within()) break;
      const fromMs = Date.now();
      const result = await this.facts.foldHistoryDay(day, history === null);
      tickStep();
      if (result === 'moved') {
        // Another process folded meanwhile: its figure is read again on the next pass.
        break;
      }
      history = day;
      folded += 1;
      logDeduplicator.info('Elysium upkeep: day folded into the history facts', { day, ms: Date.now() - fromMs });
    }

    // The directory's contracts, the ones furthest behind first.
    let projectsBehind = standing.projectsThrough === null || standing.projectsThrough < upTo;
    while (projectsBehind && within()) {
      const fromMs = Date.now();
      const result = await this.facts.foldProjectContracts(contracts, upTo, first);
      tickStep();
      projectsBehind = result.behind;
      if (result.moved > 0) {
        logDeduplicator.info('Elysium upkeep: directory contracts folded', { contracts: result.moved, behind: result.behind, ms: Date.now() - fromMs });
      } else if (!result.behind) {
        break;
      }
    }

    standing = await this.facts.standing(contracts);
    const historyDone = standing.history !== null ? standing.history >= upTo : first > upTo;
    const projectsDone = standing.projectsThrough !== null ? standing.projectsThrough >= upTo : first > upTo;
    const through = [standing.history, standing.projectsThrough].every((d) => d !== null)
      ? [standing.history as string, standing.projectsThrough as string].sort()[0]
      : null;
    await this.states.advance('facts', {
      // The end of the last day every fact holds.
      ...(through ? { cursor: new Date(dayStartMs(through) + DAY_MS) } : {}),
      addRows: folded,
      backfillDone: historyDone && projectsDone,
    });
    return !(historyDone && projectsDone);
  }

  // ---------------------------------------------------------------------------
  // 3. elysium_tx split by day, and what is kept of it
  // ---------------------------------------------------------------------------

  private async keepPartitions(now: Date): Promise<boolean> {
    let layout = await this.parts.layout();

    if (!layout.partitioned) {
      if (!ElysiumUpkeepService.isSplitEnabled()) {
        // A keep that cannot be applied is said, not silently ignored: days are only dropped from a split table.
        if (txKeepDays() !== null) {
          throw new Error('ELYSIUM_TX_KEEP_DAYS is set but elysium_tx is not split by day: set ELYSIUM_TX_SPLIT_ENABLED=true');
        }
        return false;
      }
      if ((await this.parts.serverVersion()) < SPLIT_MIN_SERVER_VERSION) {
        throw new Error('elysium_tx is not split by day: the database server is older than Postgres 14');
      }
      const today = Math.floor(now.getTime() / DAY_MS) * DAY_MS;
      const pending = layout.pending;
      if (!pending || pending.cutMs - now.getTime() < SPLIT_MIN_LEAD_MS) {
        const cutMs = today + SPLIT_LEAD_DAYS * DAY_MS;
        const step = await this.parts.prepare(cutMs);
        if (step === 'done') logDeduplicator.info('Elysium upkeep: split of elysium_tx prepared', { from: dayKey(cutMs) });
        return true;
      }
      if (!pending.validated) {
        const fromMs = Date.now();
        await this.parts.validate();
        logDeduplicator.info('Elysium upkeep: every row of elysium_tx checked against the split bound', { ms: Date.now() - fromMs });
        return true;
      }
      const days = partitionDaysWanted(now, dayKey(pending.cutMs));
      const step = await this.parts.split(pending.cutMs, days);
      if (step === 'busy') return true;
      this.parts.forgetFloor();
      logDeduplicator.info('Elysium upkeep: elysium_tx is split by day', { from: dayKey(pending.cutMs), days: days.length });
      layout = await this.parts.layout();
    }

    // A detach that was interrupted half-way is finished first.
    for (const name of layout.detaching) {
      await this.parts.drop(name, 'detaching');
      logDeduplicator.info('Elysium upkeep: part of elysium_tx dropped', { part: name });
      tickStep();
    }

    // The tables of today and of the days ahead.
    const legacy = layout.parts.find((p) => p.fromMs === null);
    const firstOwnDay = layout.parts.reduce<number | null>((m, p) => (p.fromMs !== null && (m === null || p.fromMs < m) ? p.fromMs : m), null);
    const splitFrom = legacy ? legacy.toMs : firstOwnDay;
    if (splitFrom !== null) {
      for (const day of partitionDaysWanted(now, dayKey(splitFrom))) {
        const start = dayStartMs(day);
        if (layout.parts.some((p) => (p.fromMs === null || p.fromMs <= start) && start < p.toMs)) continue;
        if (await this.parts.ensureDay(day)) logDeduplicator.info('Elysium upkeep: day table made', { day });
        tickStep();
      }
    }

    // Statistics for the planner, once a UTC day: autovacuum does not look at the parent of the parts.
    const todayKey = dayKey(now.getTime());
    if (this.analyzedDay !== todayKey) {
      await this.parts.analyze();
      this.analyzedDay = todayKey;
      tickStep();
    }

    // The days older than the keep, when one is set and nothing reads them any more.
    let dropped = 0;
    let left = 0;
    // Without the day rollups the widest views read elysium_tx itself: the keep's floor is then higher.
    const rollups = (process.env.ELYSIUM_ROLLUPS_ENABLED ?? 'true').trim().toLowerCase() !== 'false';
    const keep = txKeepDays(process.env, rollups);
    if (keep !== null) {
      const standing = await this.facts.standing(directoryContracts());
      const through =
        standing.history !== null && standing.projectsThrough !== null
          ? [standing.history, standing.projectsThrough].sort()[0]
          : null;
      const built = await this.parts.builtRollupDays(ROLLUP_KEEP_DAYS + 2);
      const candidates = partitionsToDrop(layout.parts, now, keep, through, built);
      left = candidates.length;
      for (const part of candidates.slice(0, DROPS_PER_PASS)) {
        await this.parts.drop(part.name, 'attached');
        this.parts.forgetFloor();
        dropped += 1;
        left -= 1;
        logDeduplicator.info('Elysium upkeep: part of elysium_tx dropped', {
          part: part.name === LEGACY_PARTITION ? 'everything before the split' : part.name,
          upTo: new Date(part.toMs).toISOString(),
          keepDays: keep,
        });
        tickStep();
      }
    }

    const after = dropped > 0 ? await this.parts.layout() : layout;
    const floor = after.parts[0]?.fromMs ?? null;
    await this.states.advance('txparts', {
      ...(floor !== null ? { cursor: new Date(floor) } : {}),
      setRows: after.parts.length,
      backfillDone: true,
    });
    return left > 0;
  }
}
