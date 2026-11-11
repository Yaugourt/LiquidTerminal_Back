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
const GAP_CONFIRM_MS = 30 * MINUTE_MS;
/** Whole re-reads of one day, at most: past that the difference is not one a re-read removes. */
const MAX_REREADS = 2;
/** Work per run, so the stream's lock never outlives its time. */
const TICK_BUDGET_MS = 40_000;
/**
 * Slots read again per UTC day, all days together: two whole days. A re-read is the one costly
 * thing here (a slot is every transaction of ten minutes); this keeps a provider whose daily
 * figures stopped agreeing with its own list from being read over and over. Kept in memory: a
 * restart gives the allowance back.
 */
const SLOTS_PER_UTC_DAY_MAX = 2 * SLOTS;
/** A slot whose own statements fail this many times is given up, so the day's re-read can end. */
const SLOT_FAILURES_MAX = 3;

/*
 * Removing rows. A row we hold and the provider does not list is removed only when all of this
 * holds, because a provider that is recovering or re-indexing can look exactly like a chain
 * that dropped transactions (a short list, a 404 on the row, a lower daily count):
 *   - the day holds more rows than the provider counts, and never more rows are removed than
 *     that excess;
 *   - the provider's list of the slot is not empty, and at most UNLISTED_PER_SLOT_MAX of our
 *     rows are missing from it (more is not a reorganisation: the slot is left as it is);
 *   - the provider answered "not found" for the row itself twice, REMOVE_CONFIRM_MS apart, each
 *     time after a fresh read of the slot's list.
 * A row removed wrongly all the same comes back: the day then holds fewer rows than the
 * provider counts, and is read again. ELYSIUM_DAY_CHECK_REMOVE=false turns removal off alone.
 */
const UNLISTED_PER_SLOT_MAX = 50;
const REMOVE_CONFIRM_MS = 10 * MINUTE_MS;
/** Rows remembered as "not found once", waiting for their second look. */
const SUSPECTS_MAX = 5_000;

/**
 * What a slot of a day's re-read is marked with, one character per slot in `progress`:
 * '0' to read; 'i' read (rows inserted, flags applied) without its unlisted rows having been
 * settled, either because the day had no excess then or because they wait for their second
 * look; '1' done; 'x' given up after its statements failed.
 */
type SlotMark = '0' | 'i' | '1' | 'x';

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
 * A day that differs for 30 minutes is read again in ten-minute slots, the emptiest of ours
 * first (a hole is a stretch with nothing in it), and the re-read stops as soon as the counts
 * agree. Each slot does three things: rows the provider lists and we lack are inserted by the
 * stream's own statement; rows whose spam flag, outcome, block or gas the provider changed
 * since are brought in line; and, when the day holds more rows than the provider counts, the
 * ones it does not list are settled (see "Removing rows" above): what a chain reorganisation
 * leaves behind. Where the re-read stands is kept with the day, so it spans runs and restarts.
 * A day still different once every slot is read stays marked `unrepaired`, and is read again
 * whole at most once more, if the provider's figures for it change.
 */
export class ElysiumDayCheckService {
  private readonly repo = ElysiumCheckRepository.getInstance();
  /** When the provider's daily figures were last read (this process). */
  private providerReadAt = 0;
  /** Slots read again during the current UTC day (this process). */
  private slotsRead = { day: '', count: 0 };
  /** Days the provider's last answer did not list: nothing to compare them with until it does. */
  private readonly notListed = new Set<string>();
  /** Rows the provider answered "not found" for once, and when: removed only on a second such answer, later. */
  private readonly suspects = new Map<string, number>();
  /** Slots (`day:slot`) not to read again before a time: the ones waiting for a second look. */
  private readonly slotNotBefore = new Map<string, number>();
  /** Failures of a slot's own statements (`day:slot`). */
  private readonly slotFailures = new Map<string, number>();

  constructor(private readonly io: DayCheckIo) {}

  /** Whether rows the provider no longer lists are removed (ELYSIUM_DAY_CHECK_REMOVE, on by default). */
  public static isRemovalEnabled(): boolean {
    return (process.env.ELYSIUM_DAY_CHECK_REMOVE ?? 'true').trim().toLowerCase() !== 'false';
  }

  /** One run; resolves to the delay until the next. */
  public async tick(): Promise<number> {
    const deadline = Date.now() + TICK_BUDGET_MS;
    const [cursor, head] = [await this.io.txCursor(), await this.io.head()];
    // Without the provider's head nothing says its day is complete: wait for it.
    if (!cursor || !head) return CHECK_RETRY_MS;
    const days = daysToCheck(Math.min(cursor.getTime(), head.getTime()), CHECK_DAYS, ELYSIUM_GENESIS);
    if (days.length === 0) return CHECK_INTERVAL_MS;

    let checks = new Map((await this.repo.listChecks(days[0])).map((c) => [c.day, c]));
    // A day never compared (and that the provider lists), or one that differs and may still be
    // put right. One marked unrepaired is only looked at again when the provider's figures are
    // read on schedule.
    const open = (d: string): boolean => {
      const status = checks.get(d)?.status;
      return (status === undefined && !this.notListed.has(d)) || status === 'gap' || status === 'repairing';
    };
    const sinceRead = Date.now() - this.providerReadAt;
    if ((days.some(open) && sinceRead >= PROVIDER_MIN_GAP_MS) || sinceRead >= PROVIDER_REREAD_MS) {
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
      if (!p) {
        this.notListed.add(day);
        continue;
      }
      this.notListed.delete(day);
      const theirs: DayCounts = { txs: p.txs, spam: p.spam, bridge: p.bridge };
      const prev = checks.get(day);
      const unchanged = prev !== undefined && equal(prev.provider, theirs);
      // A day already equal to figures that have not moved: nothing to count again.
      if (prev?.status === 'ok' && unchanged) continue;
      const ours = await this.repo.ourDayCounts(day);
      let status: DayCheckStatus;
      if (equal(ours, theirs)) status = 'ok';
      // A re-read under way goes on with the figures as they now are: what it has read stays read.
      else if (prev?.status === 'repairing') status = 'repairing';
      // One that could not make the day equal stands while the provider says the same.
      else if (unchanged && prev.status === 'unrepaired') status = 'unrepaired';
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
   * Reads again the slots of `check.day` that are left to read, until the day is equal, the
   * slots run out or the run's time does. Resolves to true when there is nothing more to do in
   * this run (the day is equal, the re-read is over, or what is left has to wait), false when
   * the run stopped for lack of time and should go on at once.
   */
  private async reread(check: DayCheckRow, deadline: number): Promise<boolean> {
    const day = check.day;
    const dayStart = Date.parse(`${day}T00:00:00.000Z`);
    const progress = (check.progress && check.progress.length === SLOTS ? check.progress : '0'.repeat(SLOTS)).split('') as SlotMark[];
    if (check.status !== 'repairing') {
      await this.repo.saveProgress(day, { status: 'repairing', progress: progress.join(''), added: 0, corrected: 0, removed: 0 });
      void rawLogger.info('Elysium check: reading a day again', { day });
    }
    // Counted from the table, slot by slot, in one pass a run: the rollup of a day being changed
    // is not to be trusted here, and a slot that changes is counted again on its own.
    const counts = await this.repo.slotCounts(day);
    let ours = counts.reduce(plus, { txs: 0, spam: 0, bridge: 0 });
    if (equal(ours, check.provider)) return this.finish(day, 'ok', ours);

    for (;;) {
      const slot = this.nextSlot(day, progress, counts, total(ours) > total(check.provider));
      if (slot === 'none') break;
      // Only slots waiting for their second look are left: come back for them.
      if (slot === 'later') return true;
      this.io.ensureRunning();
      if (Date.now() >= deadline) return false;
      // Out of the day's allowance: the re-read waits where it is (its progress is kept).
      if (this.slotBudgetSpent()) return true;
      this.slotsRead.count += 1;

      const start = new Date(dayStart + slot * SLOT_MS);
      const end = new Date(dayStart + (slot + 1) * SLOT_MS);
      let done: { added: number; corrected: number; removed: number; mark: SlotMark; ours: DayCounts };
      try {
        done = await this.readSlot(day, slot, start, end, counts[slot], ours, check.provider);
      } catch (error) {
        await this.slotFailed(day, slot, progress, error);
        throw error;
      }
      this.slotFailures.delete(`${day}:${slot}`);
      progress[slot] = done.mark;
      counts[slot] = plus(counts[slot], minus(done.ours, ours));
      ours = done.ours;
      const changed = done.added + done.corrected + done.removed > 0;
      const isEqual = changed && equal(ours, check.provider);
      await this.repo.saveProgress(day, {
        status: isEqual ? 'ok' : 'repairing',
        progress: isEqual ? null : progress.join(''),
        ours: changed ? ours : undefined,
        added: done.added,
        corrected: done.corrected,
        removed: done.removed,
      });
      if (isEqual) {
        void rawLogger.info('Elysium check: day equal to the provider again', { day });
        return true;
      }
    }
    return this.finish(day, 'unrepaired', ours);
  }

  /**
   * The next slot to read: first the ones never read, the emptiest of ours first (a hole left by
   * a cursor is a stretch with nothing in it); then, while the day holds more rows than the
   * provider counts, the ones read without their unlisted rows having been settled (they were
   * read before the day's holes were filled, or they wait for their second look). 'later' when
   * all that is left is waiting, 'none' when nothing is.
   */
  private nextSlot(day: string, progress: SlotMark[], counts: DayCounts[], excess: boolean): number | 'later' | 'none' {
    const now = Date.now();
    const waiting = (slot: number): boolean => (this.slotNotBefore.get(`${day}:${slot}`) ?? 0) > now;
    const of = (mark: SlotMark): number[] => progress.map((m, slot) => (m === mark ? slot : -1)).filter((slot) => slot >= 0);
    const fresh = of('0').sort((a, b) => total(counts[a]) - total(counts[b]) || a - b);
    if (fresh.length > 0) return fresh[0];
    if (!excess) return 'none';
    const unsettled = of('i');
    const ready = unsettled.find((slot) => !waiting(slot));
    if (ready !== undefined) return ready;
    return unsettled.length > 0 ? 'later' : 'none';
  }

  /** Reads one slot again: what it added, corrected and removed, the day's counts after it, and how to mark it. */
  private async readSlot(
    day: string,
    slot: number,
    start: Date,
    end: Date,
    before: DayCounts,
    oursBefore: DayCounts,
    provider: DayCounts
  ): Promise<{ added: number; corrected: number; removed: number; mark: SlotMark; ours: DayCounts }> {
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
    let slotNow = added + corrected > 0 ? await this.repo.rangeCounts(start, end) : before;
    let ours = plus(minus(oursBefore, before), slotNow);

    // More rows than the provider counts for the day: the ones it does not list in this slot.
    const excess = total(ours) - total(provider);
    let removed = 0;
    let mark: SlotMark = 'i';
    if (excess > 0 && ElysiumDayCheckService.isRemovalEnabled()) {
      const unlisted = await this.settleUnlisted(day, slot, start, end, listed, excess);
      removed = unlisted.removed;
      mark = unlisted.waiting ? 'i' : '1';
      if (removed > 0) {
        slotNow = await this.repo.rangeCounts(start, end);
        ours = plus(minus(oursBefore, before), slotNow);
      }
    } else if (excess > 0) {
      mark = '1';
    }
    return { added, corrected, removed, mark, ours };
  }

  /**
   * A slot whose read failed. A failure of the provider is not the slot's: the run fails and is
   * tried again. Any other (a statement of ours that fails, that times out) counts against the
   * slot, which is given up after SLOT_FAILURES_MAX of them, so that one slot cannot hold the
   * day, and the days after it, for good.
   */
  private async slotFailed(day: string, slot: number, progress: SlotMark[], error: unknown): Promise<void> {
    if (isProviderFailure(error)) return;
    const key = `${day}:${slot}`;
    const failures = (this.slotFailures.get(key) ?? 0) + 1;
    if (failures < SLOT_FAILURES_MAX) {
      this.slotFailures.set(key, failures);
      return;
    }
    this.slotFailures.delete(key);
    progress[slot] = 'x';
    const message = error instanceof Error ? error.message : String(error);
    this.io.rejects.note('check', 'day-gap', `${day} slot ${slot}: given up after ${failures} failures (${message.slice(0, 120)})`);
    logDeduplicator.warn('Elysium check: a slot was given up', { day, slot });
    try {
      await this.repo.saveProgress(day, { status: 'repairing', progress: progress.join(''), added: 0, corrected: 0, removed: 0 });
    } catch {
      // The mark is tried again with the slot's next failure.
    }
  }

  /** Ends a re-read that has nothing left to read, or found the day already equal. */
  private async finish(day: string, status: 'ok' | 'unrepaired', ours: DayCounts): Promise<boolean> {
    await this.repo.saveProgress(day, { status, progress: null, ours, added: 0, corrected: 0, removed: 0, wholeReread: status === 'unrepaired' });
    if (status === 'unrepaired') {
      this.io.rejects.note('check', 'day-gap', `${day}: still different after a whole re-read (ours ${describe(ours)})`);
      logDeduplicator.warn('Elysium check: a day is still different after a whole re-read', { day, ours: describe(ours) });
    }
    return true;
  }

  /**
   * The transactions we hold in the slot that the provider's list of it does not have (see
   * "Removing rows" above for when one is removed). Resolves to what was removed, and whether
   * some rows wait for their second look.
   */
  private async settleUnlisted(
    day: string,
    slot: number,
    start: Date,
    end: Date,
    listed: Set<string>,
    excess: number
  ): Promise<{ removed: number; waiting: boolean }> {
    const unlisted = (await this.repo.txHashesBetween(start, end)).filter((h) => !listed.has(h));
    if (unlisted.length === 0) return { removed: 0, waiting: false };
    if (listed.size === 0 || unlisted.length > UNLISTED_PER_SLOT_MAX) {
      const why = listed.size === 0 ? 'the provider lists nothing for this slot' : 'too many for a reorganisation';
      this.io.rejects.note('check', 'day-gap', `${day} ${start.toISOString()}: ${unlisted.length} rows the provider does not list, left as they are (${why})`);
      return { removed: 0, waiting: false };
    }
    const now = Date.now();
    const confirmed: string[] = [];
    let waiting = false;
    for (const hash of unlisted) {
      this.io.ensureRunning();
      await this.io.wait();
      if (await this.io.txListed(hash)) {
        this.suspects.delete(hash);
        continue;
      }
      const since = this.suspects.get(hash);
      if (since !== undefined && now - since >= REMOVE_CONFIRM_MS) {
        confirmed.push(hash);
        continue;
      }
      if (since === undefined) {
        if (this.suspects.size >= SUSPECTS_MAX) {
          const oldest = this.suspects.keys().next().value;
          if (oldest !== undefined) this.suspects.delete(oldest);
        }
        this.suspects.set(hash, now);
      }
      waiting = true;
    }
    if (waiting) this.slotNotBefore.set(`${day}:${slot}`, now + REMOVE_CONFIRM_MS);
    // Never more than the day holds in excess of what the provider counts.
    const gone = confirmed.slice(0, excess);
    if (gone.length === 0) return { removed: 0, waiting };
    const removed = await this.repo.removeTxs(gone);
    for (const hash of gone) this.suspects.delete(hash);
    this.io.rejects.note('check', 'reorg', `${day}: ${gone[0]} no longer on the chain`, removed);
    logDeduplicator.warn('Elysium check: transactions the provider no longer lists were removed', { day, removed });
    return { removed, waiting };
  }
}

/**
 * True for a failure of the provider or of the way to it (an HTTP error, its breaker open, a
 * timeout, a page that announced more rows and carried none), and for a run that was ended on
 * purpose (the service stopping, the tick given up at its time limit), as opposed to a failure
 * of our own statements on this slot.
 *
 * The HTTP clients turn a request that got no answer in time into a plain `Request timeout`:
 * it was not recognised here, so three slow answers of the provider on one slot were taken for
 * three failures of ours, and the slot was given up.
 */
export function isProviderFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (
    ['HttpApiError', 'OutboundCapacityError', 'AbortError', 'TimeoutError', 'PageIncompleteError', 'PageCapError', 'IngestStoppedError', 'TickGivenUpError'].includes(
      error.name
    )
  ) {
    return true;
  }
  return /circuit breaker is open|request timeout|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(error.message);
}
