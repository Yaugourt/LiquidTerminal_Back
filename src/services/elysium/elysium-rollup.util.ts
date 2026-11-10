/**
 * Pure helpers of the Elysium day rollups: which days can be built, and how a
 * time window splits between rollup days and raw transactions. No I/O.
 *
 * A rollup day is a whole UTC day of elysium_tx summed once the day is over.
 * A window is then read as: the whole days that are built, from the rollups;
 * everything else (its partial first day, today, a day not built yet) from
 * elysium_tx, exactly as before. The two parts never overlap and together
 * cover the window, so the figures are the ones the raw table alone gives.
 */

const DAY_MS = 86_400_000;

/** Days of call rollups kept by default: the widest reads go back 60 days (economics, fees 30d and its previous 30d). */
export const ROLLUP_KEEP_DAYS = 63;
/** The fewest days worth keeping: the 7-day views and their sender lists. */
export const ROLLUP_MIN_KEEP_DAYS = 10;
/**
 * Caller lists are built for the days a 30-day window can need, and dropped a
 * little later than that: a reader that planned with a day keeps finding it.
 */
export const ROLLUP_CALLERS_BUILD_DAYS = 32;
export const ROLLUP_CALLERS_KEEP_DAYS = 34;
/** Sender lists per selector: the method views go back 7 days. */
export const ROLLUP_SENDERS_BUILD_DAYS = 8;
export const ROLLUP_SENDERS_KEEP_DAYS = 10;

/**
 * Days of rollups kept: ELYSIUM_ROLLUP_KEEP_DAYS, 63 by default, never under
 * 10. The rollups take disk (a row per called address, selector and day); a
 * shorter span frees it, and the only cost is speed: a window that reaches
 * past the kept days reads those days from elysium_tx, as it did before.
 */
export function rollupKeepDays(): number {
  const raw = Number.parseInt(process.env.ELYSIUM_ROLLUP_KEEP_DAYS ?? '', 10);
  if (!Number.isFinite(raw) || raw <= 0) return ROLLUP_KEEP_DAYS;
  return Math.max(ROLLUP_MIN_KEEP_DAYS, raw);
}
/** A day is built once the tx stream is this far past its end (the stream re-reads its last 20 s). */
export const ROLLUP_CLOSE_MARGIN_MS = 10 * 60_000;
/**
 * A target's callers of a day are listed when it got at least this many
 * transactions that day. Below it they are read from elysium_tx: at most this
 * many rows per target and day, through the (to_addr, block_time) index.
 */
export const ROLLUP_CALLER_SET_MIN_TXS = 500;

export interface RollupDayCoverage {
  /** elysium_caller_set / elysium_caller_day hold this day. */
  callers: boolean;
  /** elysium_method_sender_day holds this day. */
  senders: boolean;
}

/** What a read needs from a rollup day: the call sums alone, or also one of the sender lists. */
export type RollupNeed = 'calls' | 'callers' | 'senders';

export interface RollupPlan {
  /** Whole UTC days (YYYY-MM-DD, ascending) read from the rollups. */
  days: string[];
  /** The rest of the window, read from elysium_tx: [from, to) ranges, ascending, never touching. */
  raw: Array<{ from: Date; to: Date }>;
}

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function utcDayStart(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

/**
 * Splits [start, end) between the built days it wholly contains and raw
 * ranges. `coverage` holds the built, non-dirty days. An empty or inverted
 * window gives an empty plan.
 */
export function planRollupWindow(
  start: Date,
  end: Date,
  coverage: ReadonlyMap<string, RollupDayCoverage>,
  need: RollupNeed = 'calls'
): RollupPlan {
  const plan: RollupPlan = { days: [], raw: [] };
  const from = start.getTime();
  const to = end.getTime();
  if (!(from < to)) return plan;

  for (let day = utcDayStart(from); day < to; day += DAY_MS) {
    const segFrom = Math.max(from, day);
    const segTo = Math.min(to, day + DAY_MS);
    const whole = segFrom === day && segTo === day + DAY_MS;
    const built = whole ? coverage.get(dayKey(day)) : undefined;
    const usable = built !== undefined && (need === 'calls' || (need === 'callers' ? built.callers : built.senders));
    if (usable) {
      plan.days.push(dayKey(day));
      continue;
    }
    const last = plan.raw[plan.raw.length - 1];
    if (last && last.to.getTime() === segFrom) last.to = new Date(segTo);
    else plan.raw.push({ from: new Date(segFrom), to: new Date(segTo) });
  }
  return plan;
}

/**
 * The days whose rollups may be built, newest first: over, within the kept
 * span, not before the first day of the chain, and far enough behind the tx
 * stream's cursor that the stream is done with them.
 */
export function closedRollupDays(cursor: Date | null, now: Date, genesis: Date, keepDays = rollupKeepDays()): string[] {
  if (!cursor) return [];
  const today = utcDayStart(now.getTime());
  const first = Math.max(utcDayStart(genesis.getTime()), today - keepDays * DAY_MS);
  const out: string[] = [];
  for (let day = today - DAY_MS; day >= first; day -= DAY_MS) {
    if (day + DAY_MS + ROLLUP_CLOSE_MARGIN_MS <= cursor.getTime()) out.push(dayKey(day));
  }
  return out;
}

/** Whether `day` (YYYY-MM-DD) is one of the last `days` UTC days before today. */
export function isWithinDays(day: string, now: Date, days: number): boolean {
  const today = utcDayStart(now.getTime());
  const t = Date.parse(`${day}T00:00:00Z`);
  return t >= today - days * DAY_MS && t < today;
}

/** The first UTC day (YYYY-MM-DD) kept by a table that keeps `keepDays` days before today. */
export function firstKeptDay(now: Date, keepDays: number): string {
  return dayKey(utcDayStart(now.getTime()) - keepDays * DAY_MS);
}
