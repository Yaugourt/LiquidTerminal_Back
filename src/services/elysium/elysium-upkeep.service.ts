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
 * Every step of the copy starts two hours before where the last one ended: a swap or a trade is
 * read from the logs by its own stream, which can be behind the transactions' by a few minutes.
 */
const SENDER_RECENT_MS = 2 * HOUR_MS;
/**
 * And, a few times a day, at the days the daily comparison with the provider can still add
 * transactions to: a row whose transaction arrives that late gets its sender then.
 */
const SENDER_SWEEP_EVERY_MS = 6 * HOUR_MS;
const SENDER_SWEEP_MS = (FACTS_FINAL_DAYS - 1) * DAY_MS;
/** Time copied per transaction while the copy has ground to cover; halved when a step fails, down to an hour. */
const SENDER_HISTORY_STEP_MS = 2 * DAY_MS;
const SENDER_MIN_STEP_MS = HOUR_MS;

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
  private senderStepMs = SENDER_HISTORY_STEP_MS;
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
    more = (await this.job('txsender', () => this.copySenders(now, tx))) || more;
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

  private async copySenders(now: Date, tx: { cursor: Date | null; backfillDone: boolean } | null): Promise<boolean> {
    // elysium_tx is complete up to the tx stream's cursor: past it, a transaction may simply not be there yet.
    const txCursor = tx?.cursor ?? null;
    if (!txCursor) return false;
    const target = new Date(Math.min(now.getTime(), txCursor.getTime()));
    const state = await this.states.getState('txsender');
    let rows = 0;

    // A few times a day, the days the daily comparison can still add transactions to.
    if (state?.backfillDone && now.getTime() - this.lastSenderSweepAt >= SENDER_SWEEP_EVERY_MS) {
      const swept = await this.facts.copyTxSenders(new Date(target.getTime() - SENDER_SWEEP_MS), target);
      rows += swept.swaps + swept.trades + swept.launches;
      this.lastSenderSweepAt = now.getTime();
      tickStep();
    }

    // From where the last pass stopped to where the tx stream stands, a few days per
    // transaction, and the cursor only ever moves to the end of what was copied: the first
    // start goes through the whole history this way, and so does the catch-up after the tx
    // stream stood still for days and then read them in a few minutes. Each step starts two
    // hours before where the last one ended (a swap is read from the logs by its own stream,
    // which can be behind the transactions'), so a pass with nothing new still looks at the
    // last two hours again.
    const startedAt = Date.now();
    let from = new Date(Math.min((state?.cursor ?? ELYSIUM_GENESIS).getTime(), target.getTime()));
    let reached = false;
    do {
      const to = new Date(Math.min(from.getTime() + this.senderStepMs, target.getTime()));
      let step: Awaited<ReturnType<ElysiumFactsRepository['copyTxSenders']>>;
      try {
        step = await this.facts.copyTxSenders(new Date(from.getTime() - SENDER_RECENT_MS), to);
      } catch (error) {
        // A step that cannot end (its time limit, on a cold disk) is tried again half as long.
        this.senderStepMs = Math.max(SENDER_MIN_STEP_MS, Math.floor(this.senderStepMs / 2));
        throw error;
      }
      this.senderStepMs = Math.min(SENDER_HISTORY_STEP_MS, this.senderStepMs * 2);
      rows += step.swaps + step.trades + step.launches;
      from = to;
      reached = to.getTime() >= target.getTime();
      // Done once: the copy has been through everything the tx stream holds, and that stream
      // has itself been through the chain's history (before that, "everything" is a few hours).
      const done = reached && Boolean(tx?.backfillDone);
      await this.states.advance('txsender', { cursor: to, addRows: rows, ...(done && !state?.backfillDone ? { backfillDone: true } : {}) });
      if (done && !state?.backfillDone) logDeduplicator.info('Elysium upkeep: transaction senders copied over the whole history');
      rows = 0;
      tickStep();
    } while (!reached && Date.now() - startedAt < JOB_BUDGET_MS);
    return !reached;
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
        // A transaction dated at or after the bound (a row with an absurd time, stored long ago)
        // would fail the check of every row, pass after pass: said by name instead.
        const newest = await this.parts.newestTxMs();
        if (newest !== null && newest >= cutMs) {
          throw new Error(`elysium_tx is not split by day: it holds a transaction dated ${new Date(newest).toISOString()}, after the split bound`);
        }
        const step = await this.parts.prepare(cutMs);
        if (step === 'done') logDeduplicator.info('Elysium upkeep: split of elysium_tx prepared', { from: dayKey(cutMs) });
        // Busy: the table could not be had for an instant. Tried again at the next pass, a
        // minute later, not at once: each try makes every statement on the table wait behind it.
        return step === 'done';
      }
      if (!pending.validated) {
        const fromMs = Date.now();
        await this.parts.validate();
        logDeduplicator.info('Elysium upkeep: every row of elysium_tx checked against the split bound', { ms: Date.now() - fromMs });
        return true;
      }
      const days = partitionDaysWanted(now, dayKey(pending.cutMs));
      const step = await this.parts.split(pending.cutMs, days);
      if (step === 'busy') return false;
      this.parts.forgetFloor();
      logDeduplicator.info('Elysium upkeep: elysium_tx is split by day', { from: dayKey(pending.cutMs), days: days.length });
      layout = await this.parts.layout();
    }

    // The tables of today and of the days ahead, before anything that can fail below.
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

    // A drop that stopped half-way is finished: a detach that was interrupted, or a part taken
    // out whose table was not dropped (the process ended between the two statements).
    for (const name of layout.detaching) {
      await this.parts.drop(name, 'detaching');
      logDeduplicator.info('Elysium upkeep: part of elysium_tx dropped', { part: name });
      tickStep();
    }
    for (const name of layout.orphans) {
      await this.parts.drop(name, 'orphan');
      logDeduplicator.info('Elysium upkeep: table of a part already taken out dropped', { part: name });
      tickStep();
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
    const keep = txKeepDays();
    if (keep !== null) {
      const standing = await this.facts.standing(directoryContracts());
      const through =
        standing.history !== null && standing.projectsThrough !== null
          ? [standing.history, standing.projectsThrough].sort()[0]
          : null;
      // Where the copy of the senders stands: a swap whose transaction is dropped before its
      // sender was copied would lose it for good.
      const senders = await this.states.getState('txsender');
      const sendersThrough = senders?.backfillDone && senders.cursor ? senders.cursor.getTime() : null;
      const built = await this.parts.builtRollupDays(ROLLUP_KEEP_DAYS + 2);
      const candidates = partitionsToDrop(layout.parts, now, keep, through, sendersThrough, built);
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
