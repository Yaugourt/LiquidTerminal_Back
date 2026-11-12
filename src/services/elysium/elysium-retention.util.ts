/**
 * Pure helpers for what is kept of elysium_tx, the table every Elysium figure
 * starts from, and for what stands in for the part that is not kept. No I/O.
 *
 * Three things, each with its own module, share the rules below:
 *
 * - the history facts (ElysiumFactsRepository): what the pages show "since the
 *   first block" (the first and last call of a contract, the methods an address
 *   uses most, the wallets of a project) is added up once per UTC day, when the
 *   day is final, into small tables. A page then reads those tables and only
 *   the days after them from elysium_tx;
 * - the partitions (ElysiumPartitionRepository): elysium_tx is split in one
 *   table per UTC day, so that a day can be dropped as a whole;
 * - the keep (ELYSIUM_TX_KEEP_DAYS): how many days of elysium_tx stay. Unset,
 *   everything stays.
 */
import { ROLLUP_KEEP_DAYS } from './elysium-rollup.util';

const DAY_MS = 86_400_000;

/**
 * A closed UTC day is final once it ended this many days ago: nothing writes
 * to it any more. The daily comparison with the provider re-reads the last
 * CHECK_DAYS (7) closed days and can add, change or remove their rows; a day
 * is folded into the history facts only after that, with two days to spare (a
 * unit test holds the two constants together). (A row that still arrives
 * for a final day, a re-read of old windows after a rewind, is added to the
 * facts by its own insert: see ElysiumIngestRepository.insertTxs.)
 */
export const FACTS_FINAL_DAYS = 10;

/**
 * An insert whose oldest row is older than this takes the slow path that also
 * moves the history facts. Two days short of FACTS_FINAL_DAYS: every row of a
 * day that can be folded is older than this by a day at least, whatever the
 * hour and whatever a process's clock is off by.
 */
export const LATE_ROW_AGE_MS = (FACTS_FINAL_DAYS - 2) * DAY_MS;

/**
 * The fewest days of elysium_tx that can be kept: what the views can still read
 * from it. The widest go back 60 days (the fees over 30 days and the 30 days
 * before them, whose first, partial day is always read from elysium_tx itself),
 * a day whose rollup is missing is read from it too, and the rollups are kept
 * ROLLUP_KEEP_DAYS days.
 */
export const TX_KEEP_MIN_DAYS = ROLLUP_KEEP_DAYS + 2;

export function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function dayStartMs(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

/** The UTC day after `day` (YYYY-MM-DD). */
export function nextDay(day: string): string {
  return dayKey(dayStartMs(day) + DAY_MS);
}

/** The UTC day before `day` (YYYY-MM-DD). */
export function previousDay(day: string): string {
  return dayKey(dayStartMs(day) - DAY_MS);
}

/**
 * Days of elysium_tx to keep: ELYSIUM_TX_KEEP_DAYS, never under the floor the
 * views need. Null when it is not set (or not a positive whole number):
 * everything is kept, nothing is ever dropped.
 */
export function txKeepDays(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = (env.ELYSIUM_TX_KEEP_DAYS ?? '').trim();
  if (!/^\d+$/.test(raw)) return null;
  const asked = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(asked) || asked <= 0) return null;
  return Math.max(asked, TX_KEEP_MIN_DAYS);
}

/**
 * The newest UTC day that is final at `now`, given where the tx stream stands:
 * the day that ended FACTS_FINAL_DAYS days ago or more, and that the stream's
 * own backfill has passed. Null while the stream has not caught up once (its
 * history is still being loaded, any day can still receive rows) or has no
 * cursor.
 */
export function finalDay(now: Date, tx: { cursor: Date | null; backfillDone: boolean } | null): string | null {
  if (!tx || !tx.backfillDone || !tx.cursor) return null;
  const today = Math.floor(now.getTime() / DAY_MS) * DAY_MS;
  const byClock = today - FACTS_FINAL_DAYS * DAY_MS;
  // A stream that stands still (the provider stalled for days) holds the facts back with it.
  const byCursor = Math.floor(tx.cursor.getTime() / DAY_MS) * DAY_MS - FACTS_FINAL_DAYS * DAY_MS;
  return dayKey(Math.min(byClock, byCursor));
}

/** The days from the one after `through` (or `first` when nothing was folded) to `upTo`, ascending, at most `max`. */
export function daysToFold(through: string | null, first: string, upTo: string | null, max: number): string[] {
  if (upTo === null) return [];
  const out: string[] = [];
  let day = through === null ? first : nextDay(through);
  while (day <= upTo && out.length < max) {
    out.push(day);
    day = nextDay(day);
  }
  return out;
}

/** Name of the table that holds one UTC day of elysium_tx. */
export function partitionName(day: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`Invalid partition day: ${day}`);
  return `elysium_tx_d${day.replace(/-/g, '')}`;
}

/** The day a partition name stands for, or null when it is not one of ours. */
export function partitionDay(name: string): string | null {
  const m = /^elysium_tx_d(\d{4})(\d{2})(\d{2})$/.exec(name);
  if (!m) return null;
  const day = `${m[1]}-${m[2]}-${m[3]}`;
  const start = dayStartMs(day);
  // Eight digits that are not a date (a month 13) name no day.
  return Number.isFinite(start) && dayKey(start) === day ? day : null;
}

/** How many days ahead of today a partition is made: an insert never waits for its table. */
export const PARTITIONS_AHEAD_DAYS = 3;

/** Today and the next PARTITIONS_AHEAD_DAYS days, from `from` on (the day the split starts). */
export function partitionDaysWanted(now: Date, from: string): string[] {
  const today = Math.floor(now.getTime() / DAY_MS) * DAY_MS;
  const out: string[] = [];
  for (let i = 0; i <= PARTITIONS_AHEAD_DAYS; i++) {
    const day = dayKey(today + i * DAY_MS);
    if (day >= from) out.push(day);
  }
  return out;
}

/**
 * The first UTC day kept at `now` for a keep of `keepDays`: that many whole
 * days before today stay, and today.
 */
export function firstKeptTxDay(now: Date, keepDays: number): string {
  const today = Math.floor(now.getTime() / DAY_MS) * DAY_MS;
  return dayKey(today - keepDays * DAY_MS);
}

export interface TxPartition {
  name: string;
  /** First instant held (epoch ms); null for the table of everything before the split. */
  fromMs: number | null;
  /** First instant not held (epoch ms). */
  toMs: number;
}

/**
 * The partitions that can be dropped at `now`, oldest first: each wholly before
 * the first kept day, wholly inside what the history facts hold (`factsThrough`:
 * the last day folded, for every fact), wholly behind the copy of the senders
 * (`sendersThroughMs`: where that copy stands, null while it has not been
 * through the history), and, inside the span the day rollups cover, only when
 * its days' rollups are built (`builtDays`): a view that finds a day's rollup
 * missing reads that day from elysium_tx.
 *
 * Only the oldest ones in a row: the list stops at the first part that has to
 * stay. What elysium_tx holds is then always "everything from its oldest part
 * on", with no day missing in between, which is what the insert, the rollup
 * builder and the status go by.
 */
export function partitionsToDrop(
  parts: readonly TxPartition[],
  now: Date,
  keepDays: number,
  factsThrough: string | null,
  sendersThroughMs: number | null,
  builtDays: ReadonlySet<string>
): TxPartition[] {
  if (factsThrough === null || sendersThroughMs === null) return [];
  const firstKept = dayStartMs(firstKeptTxDay(now, keepDays));
  const factsEnd = dayStartMs(factsThrough) + DAY_MS;
  const today = Math.floor(now.getTime() / DAY_MS) * DAY_MS;
  const rollupFrom = today - ROLLUP_KEEP_DAYS * DAY_MS;
  const out: TxPartition[] = [];
  for (const p of [...parts].sort((a, b) => a.toMs - b.toMs)) {
    if (p.toMs > firstKept || p.toMs > factsEnd || p.toMs > sendersThroughMs) break;
    // Every day of it that a view can still ask the rollups for must be built.
    let built = true;
    for (let day = Math.max(p.fromMs ?? rollupFrom, rollupFrom); day < p.toMs; day += DAY_MS) {
      if (!builtDays.has(dayKey(day))) built = false;
    }
    if (!built) break;
    out.push(p);
  }
  return out;
}
