import { ELYSIUM_PROJECTS } from '../../constants/elysium-projects';
import { ElysiumFactsRepository } from '../../repositories/prisma/prisma.elysium-facts.repository';
import { ElysiumIngestRepository, type ElysiumStream } from '../../repositories/prisma/prisma.elysium.repository';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { ELYSIUM_GENESIS } from './elysium-ingest.util';
import { dayStartMs, FACTS_FINAL_DAYS, finalDay, nextDay } from './elysium-retention.util';
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
 * The first passes after this ships go through the whole history, a few days
 * per pass. Until they are through, the pages read what is missing from
 * elysium_tx, as they did before: a pass that is late or fails costs speed,
 * never a figure.
 */
export class ElysiumUpkeepService {
  private static instance: ElysiumUpkeepService;

  private readonly states = ElysiumIngestRepository.getInstance();
  private readonly facts = ElysiumFactsRepository.getInstance();
  private lastSenderSweepAt = 0;

  public static getInstance(): ElysiumUpkeepService {
    if (!ElysiumUpkeepService.instance) ElysiumUpkeepService.instance = new ElysiumUpkeepService();
    return ElysiumUpkeepService.instance;
  }

  public static isEnabled(): boolean {
    return (process.env.ELYSIUM_UPKEEP_ENABLED ?? 'true').trim().toLowerCase() !== 'false';
  }

  /** One pass. Resolves to the delay before the next one. */
  public async tick(): Promise<number> {
    const now = new Date(Date.now());
    const tx = await this.states.getState('tx');
    let more = false;
    more = (await this.job('txsender', () => this.copySenders(now, tx?.cursor ?? null))) || more;
    more = (await this.job('facts', () => this.foldFacts(now, tx))) || more;
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
}
