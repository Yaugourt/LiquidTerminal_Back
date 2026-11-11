import type { ElysiumProviderDay } from '../../clients/hypedexer/rest/elysium/elysium-indexer.client';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { rawLogger } from '../../utils/logger';
import { ElysiumCheckRepository } from '../../repositories/prisma/prisma.elysium-check.repository';
import type { DayCheckRow, DayCheckStatus, DayCounts } from '../../repositories/prisma/prisma.elysium-check.repository';
import type { IngestRejects } from './elysium-ingest-rejects';
import { ELYSIUM_GENESIS, MINUTE_MS, utcDay } from './elysium-ingest.util';
import type { TxRow } from './elysium-ingest.util';

const DAY_MS = 86_400_000;
const SLOT_MS = 10 * MINUTE_MS;
const SLOTS = 144;

/** Closed days compared with the provider: its figures for an older day no longer move. */
export const CHECK_DAYS = 7;
/** A day is compared once the tx stream and the provider's head are this far past its end (the rollups wait as long). */
const DAY_SETTLE_MS = 10 * MINUTE_MS;
/** How often the comparison runs when every day is equal. */
const CHECK_INTERVAL_MS = 30 * MINUTE_MS;
/** How soon it runs again while a day differs, or its re-read has more to do. */
const CHECK_RETRY_MS = 5 * MINUTE_MS;
/** The provider's daily figures are read again at least this often, to see a day it revised. */
const PROVIDER_REREAD_MS = 6 * 60 * MINUTE_MS;
/** ...and never more often than this, whatever differs. */
const PROVIDER_MIN_GAP_MS = 5 * MINUTE_MS;
/**
 * A difference has to last this long before the day is read again: the provider's own count of
 * a day can trail its rows by a few minutes, and a re-read of a whole day is up to 300,000
 * credits.
 */
const GAP_CONFIRM_MS = 15 * MINUTE_MS;
/** Whole re-reads of one day, at most: past that the difference is not one a re-read removes. */
const MAX_REREADS = 2;
/** Work per run, so the stream's lock never outlives its time. */
const TICK_BUDGET_MS = 40_000;
/**
 * Transactions of one slot we hold and the provider does not list, at most, for them to be
 * looked up one by one and removed. More than that is not a reorganisation of the chain: the
 * slot is left alone and the day ends as unrepaired, for someone to look at.
 */
const UNLISTED_PER_SLOT_MAX = 50;
/**
 * Slots read again per UTC day, all days together: two whole days. A re-read is the one costly
 * thing here (a slot is every transaction of ten minutes); this keeps a provider whose daily
 * figures stopped agreeing with its own list from being read over and over.
 */
const SLOTS_PER_UTC_DAY_MAX = 2 * SLOTS;

/** What the check needs from the ingestion service it runs in. */
export interface DayCheckIo {
  ensureRunning(): void;
  /** One turn of the throttle every provider call of the ingestion shares. */
  wait(): Promise<void>;
  /** The provider's last indexed block time, null when not known. */
  head(): Promise<Date | null>;
  /** The tx stream's cursor, null when it never ran. */
  txCursor(): Promise<Date | null>;
  fetchDaily(days: number): Promise<ElysiumProviderDay[]>;
  /** Every transaction the provider lists in [start, end] (both inclusive, as it filters), page by page, normalised. */
  pageTxs(start: Date, end: Date, onPage: (rows: TxRow[]) => Promise<void>): Promise<void>;
  /** The stream's own insert (missing rows, with everything derived from them); returns the rows added. */
  insertTxs(rows: TxRow[]): Promise<number>;
  txListed(hash: string): Promise<boolean>;
  rejects: IngestRejects;
}

const equal = (a: DayCounts, b: DayCounts): boolean => a.txs === b.txs && a.spam === b.spam && a.bridge === b.bridge;
const plus = (a: DayCounts, b: DayCounts): DayCounts => ({ txs: a.txs + b.txs, spam: a.spam + b.spam, bridge: a.bridge + b.bridge });
const minus = (a: DayCounts, b: DayCounts): DayCounts => ({ txs: a.txs - b.txs, spam: a.spam - b.spam, bridge: a.bridge - b.bridge });
const total = (c: DayCounts): number => c.txs + c.spam;
const describe = (c: DayCounts): string => `${c.txs} txs, ${c.spam} spam, ${c.bridge} bridge`;

/** The closed UTC days to compare, oldest first: the last `days` whose end both `upTo` times have passed. */
export function daysToCheck(upTo: number, days: number, genesis: Date): string[] {
  const lastClosed = Math.floor((upTo - DAY_SETTLE_MS) / DAY_MS) * DAY_MS - DAY_MS;
  const first = Math.floor(genesis.getTime() / DAY_MS) * DAY_MS;
  const out: string[] = [];
  for (let d = lastClosed - (days - 1) * DAY_MS; d <= lastClosed; d += DAY_MS) {
    if (d >= first) out.push(utcDay(new Date(d)));
  }
  return out;
}

/**
 * Compares each closed day of elysium_tx with the provider's own daily figures, and reads a day
 * that differs again until it is equal.
 *
 * Nothing checked that a day was complete. The streams move their cursor after each window,
 * empty or not, and the only guard is the head the provider announces: if its transaction list
 * stops while that head moves on, every window reads nothing and the cursor leaves a hole for
 * good (the outage of 17 October). The provider's /stats/daily gives, for 3 credits, the count
 * of each day: equal to ours to the unit on the 9 closed days compared on 2026-11-11.
 *
 * A day that differs for 15 minutes is read again in ten-minute slots, the emptiest of ours
 * first (a hole is a stretch with nothing in it), and the re-read stops as soon as the counts
 * agree. Each slot does three things: rows the provider lists and we lack are inserted by the
 * stream's own statement; rows whose spam flag, outcome or gas the provider changed since are
 * brought in line; and, when we hold more rows than the provider counts, the ones it does not
 * list are looked up one by one and removed with everything derived from them (what a chain
 * reorganisation leaves behind). Where the re-read stands is kept with the day, so it spans
 * runs and restarts. A day still different after two whole re-reads stays marked `unrepaired`.
 */
export class ElysiumDayCheckService {
  private readonly repo = ElysiumCheckRepository.getInstance();
  /** When the provider's daily figures were last read (this process). */
  private providerReadAt = 0;
  /** Slots read again during the current UTC day (this process). */
  private slotsRead = { day: '', count: 0 };

  constructor(private readonly io: DayCheckIo) {}

  /** One run; resolves to the delay until the next. */
  public async tick(): Promise<number> {
    const deadline = Date.now() + TICK_BUDGET_MS;
    const [cursor, head] = [await this.io.txCursor(), await this.io.head()];
    // Without the provider's head nothing says its day is complete: wait for it.
    if (!cursor || !head) return CHECK_RETRY_MS;
    const days = daysToCheck(Math.min(cursor.getTime(), head.getTime()), CHECK_DAYS, ELYSIUM_GENESIS);
    if (days.length === 0) return CHECK_INTERVAL_MS;

    let checks = new Map((await this.repo.listChecks(days[0])).map((c) => [c.day, c]));
    // A day never compared, or one that differs and may still be put right. One marked
    // unrepaired is only looked at again when the provider's figures are read on schedule.
    const open = (d: string): boolean => {
      const status = checks.get(d)?.status;
      return status === undefined || status === 'gap' || status === 'repairing';
    };
    const pending = days.some(open);
    const sinceRead = Date.now() - this.providerReadAt;
    if ((pending && sinceRead >= PROVIDER_MIN_GAP_MS) || sinceRead >= PROVIDER_REREAD_MS) {
      await this.compare(days, checks);
      checks = new Map((await this.repo.listChecks(days[0])).map((c) => [c.day, c]));
    }

    // One day at a time, the oldest first.
    const now = Date.now();
    const target = days
      .map((d) => checks.get(d))
      .find(
        (c): c is DayCheckRow =>
          c !== undefined &&
          (c.status === 'repairing' || (c.status === 'gap' && c.rereads < MAX_REREADS && c.gapSince !== null && now - c.gapSince.getTime() >= GAP_CONFIRM_MS))
      );
    if (target && !this.slotBudgetSpent()) {
      const done = await this.reread(target, deadline);
      return done ? CHECK_RETRY_MS : 0;
    }
    return days.some((d) => checks.get(d)?.status === 'gap') ? CHECK_RETRY_MS : CHECK_INTERVAL_MS;
  }

  private slotBudgetSpent(): boolean {
    const today = utcDay(new Date(Date.now()));
    if (this.slotsRead.day !== today) this.slotsRead = { day: today, count: 0 };
    return this.slotsRead.count >= SLOTS_PER_UTC_DAY_MAX;
  }

  /** Reads the provider's daily figures and records each day's comparison. */
  private async compare(days: string[], checks: Map<string, DayCheckRow>): Promise<void> {
    this.io.ensureRunning();
    await this.io.wait();
    // Two days more than compared: the answer starts at the current day.
    const provider = new Map((await this.io.fetchDaily(CHECK_DAYS + 2)).map((d) => [d.day, d]));
    this.providerReadAt = Date.now();
    for (const day of days) {
      const p = provider.get(day);
      if (!p) continue;
      const theirs: DayCounts = { txs: p.txs, spam: p.spam, bridge: p.bridge };
      const prev = checks.get(day);
      const unchanged = prev !== undefined && equal(prev.provider, theirs);
      // A day already equal to figures that have not moved: nothing to count again.
      if (prev?.status === 'ok' && unchanged) continue;
      const ours = await this.repo.ourDayCounts(day);
      let status: DayCheckStatus;
      if (equal(ours, theirs)) status = 'ok';
      // A re-read under way, or one that could not make the day equal, stands while the provider says the same.
      else if (unchanged && (prev.status === 'repairing' || prev.status === 'unrepaired')) status = prev.status;
      // Read again whole as often as allowed: no further re-read will change it.
      else if (prev !== undefined && prev.rereads >= MAX_REREADS) status = 'unrepaired';
      else status = 'gap';
      await this.repo.saveComparison(day, theirs, ours, status);
      if (status === 'gap' && prev?.status !== 'gap') {
        this.io.rejects.note('check', 'day-gap', `${day}: ours ${describe(ours)}; provider ${describe(theirs)}`);
        logDeduplicator.warn('Elysium check: a closed day differs from the provider', {
          day,
          ours: describe(ours),
          provider: describe(theirs),
        });
      }
    }
  }

  /**
   * Reads again the slots of `check.day` not yet read, until the day is equal, the slots run
   * out or the run's time does. Resolves to true when this re-read is over (equal or not).
   */
  private async reread(check: DayCheckRow, deadline: number): Promise<boolean> {
    const day = check.day;
    const dayStart = Date.parse(`${day}T00:00:00.000Z`);
    const progress = (check.progress && check.progress.length === SLOTS ? check.progress : '0'.repeat(SLOTS)).split('');
    if (check.status !== 'repairing') {
      await this.repo.saveProgress(day, { status: 'repairing', progress: progress.join(''), added: 0, corrected: 0, removed: 0 });
      void rawLogger.info('Elysium check: reading a day again', { day });
    }
    // Counted from the table, slot by slot, in one pass a run: the rollup of a day being changed
    // is not to be trusted here, and a slot that changes is counted again on its own.
    const counts = await this.repo.slotCounts(day);
    let ours = counts.reduce(plus, { txs: 0, spam: 0, bridge: 0 });
    if (equal(ours, check.provider)) return this.finish(day, 'ok', ours);

    // The emptiest of our slots first: a hole left by a cursor is a stretch with nothing in it.
    const order = progress
      .map((done, slot) => ({ done, slot }))
      .filter((s) => s.done !== '1')
      .sort((a, b) => total(counts[a.slot]) - total(counts[b.slot]) || a.slot - b.slot)
      .map((s) => s.slot);

    for (const slot of order) {
      this.io.ensureRunning();
      if (Date.now() >= deadline) return false;
      // Out of the day's allowance: the re-read waits where it is (its progress is kept).
      if (this.slotBudgetSpent()) return true;
      this.slotsRead.count += 1;
      const start = new Date(dayStart + slot * SLOT_MS);
      const end = new Date(dayStart + (slot + 1) * SLOT_MS);
      const listed = new Set<string>();
      let added = 0;
      let corrected = 0;
      await this.io.pageTxs(start, end, async (rows) => {
        // The provider's window includes its last second, which belongs to the next slot.
        const inSlot = rows.filter((r) => Date.parse(r.block_time) < end.getTime());
        for (const r of inSlot) listed.add(r.tx_hash);
        added += await this.io.insertTxs(inSlot);
        corrected += await this.repo.applyTxFlags(inSlot);
      });
      // More rows here than the provider counts for the day: the ones it does not list in this slot.
      const removed = total(ours) + added > total(check.provider) ? await this.removeUnlisted(day, start, end, listed) : 0;
      progress[slot] = '1';
      const changed = added + corrected + removed > 0;
      if (changed) {
        const after = await this.repo.rangeCounts(start, end);
        ours = plus(minus(ours, counts[slot]), after);
        counts[slot] = after;
      }
      const isEqual = changed && equal(ours, check.provider);
      await this.repo.saveProgress(day, {
        status: isEqual ? 'ok' : 'repairing',
        progress: isEqual ? null : progress.join(''),
        ours: changed ? ours : undefined,
        added,
        corrected,
        removed,
      });
      if (isEqual) {
        void rawLogger.info('Elysium check: day equal to the provider again', { day });
        return true;
      }
    }
    return this.finish(day, 'unrepaired', ours);
  }

  /** Ends a re-read that read every slot, or found the day already equal. */
  private async finish(day: string, status: 'ok' | 'unrepaired', ours: DayCounts): Promise<boolean> {
    await this.repo.saveProgress(day, { status, progress: null, ours, added: 0, corrected: 0, removed: 0, wholeReread: status === 'unrepaired' });
    if (status === 'unrepaired') {
      this.io.rejects.note('check', 'day-gap', `${day}: still different after a whole re-read (ours ${describe(ours)})`);
      logDeduplicator.warn('Elysium check: a day is still different after a whole re-read', { day, ours: describe(ours) });
    }
    return true;
  }

  /**
   * The transactions we hold in the slot that the provider's list of it does not have: each is
   * asked for by its hash, and removed only when the provider answers that it does not exist.
   */
  private async removeUnlisted(day: string, start: Date, end: Date, listed: Set<string>): Promise<number> {
    const unlisted = (await this.repo.txHashesBetween(start, end)).filter((h) => !listed.has(h));
    if (unlisted.length === 0) return 0;
    if (unlisted.length > UNLISTED_PER_SLOT_MAX) {
      this.io.rejects.note('check', 'day-gap', `${day} ${start.toISOString()}: ${unlisted.length} rows the provider does not list, left as they are`);
      return 0;
    }
    const gone: string[] = [];
    for (const hash of unlisted) {
      this.io.ensureRunning();
      await this.io.wait();
      if (!(await this.io.txListed(hash))) gone.push(hash);
    }
    if (gone.length === 0) return 0;
    const removed = await this.repo.removeTxs(gone);
    this.io.rejects.note('check', 'reorg', `${day}: ${gone[0]} no longer on the chain`, removed);
    logDeduplicator.warn('Elysium check: transactions the provider no longer lists were removed', { day, removed });
    return removed;
  }
}
