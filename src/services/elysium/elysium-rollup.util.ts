/**
 * Pure helpers of the Elysium rollups: which days and hours can be built, and
 * how a time window splits between rollup days, rollup hours and raw
 * transactions. No I/O.
 *
 * A rollup day is a whole UTC day of elysium_tx summed once the day is over; a
 * rollup hour is the same for a whole UTC hour, kept only where a window's
 * edges fall. A window is read as: the whole days that are built, from the day
 * rollups; of the rest (its partial first day, today, a day not built yet),
 * the whole hours that are built, from the hour rollups; and what is left
 * from elysium_tx. The parts never overlap and together cover the window, so
 * the figures are the ones the raw table alone gives.
 */

const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;

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
 * 10 (never under 63 once a keep is set on elysium_tx itself). The rollups take disk (a row per called address, selector and day); a
 * shorter span frees it, and the only cost is speed: a window that reaches
 * past the kept days reads those days from elysium_tx, as it did before.
 */
export function rollupKeepDays(): number {
  const raw = Number.parseInt(process.env.ELYSIUM_ROLLUP_KEEP_DAYS ?? '', 10);
  if (!Number.isFinite(raw) || raw <= 0) return ROLLUP_KEEP_DAYS;
  // With a keep set on elysium_tx (ELYSIUM_TX_KEEP_DAYS), its old days are dropped and the
  // rollups are all that is left of them: a rollup day dropped then could not be built again,
  // so the span is never shortened below the default.
  if (/^\d+$/.test((process.env.ELYSIUM_TX_KEEP_DAYS ?? '').trim())) return Math.max(ROLLUP_KEEP_DAYS, raw);
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

/**
 * An hour is built once the tx stream is this far past its end. Shorter than a day's margin: a
 * transaction that arrives later marks its hour to be rebuilt, and an hour is a small build.
 */
export const HOUR_CLOSE_MARGIN_MS = 3 * 60_000;
/**
 * Hours kept behind the clock: the last day (the 24-hour windows), yesterday while its day
 * rollup is not built, and a margin.
 */
export const HOUR_RECENT_KEEP = 50;
/** An hour that left what the builder wants is kept this many hours more: a window table may still hold it. */
export const HOUR_KEEP_SLACK = 3;
/** The windows that have a table of their own (elysium_target_window), in days. */
export const WINDOW_SPANS = [1, 7, 30] as const;
export type WindowSpan = (typeof WINDOW_SPANS)[number];

export interface RollupDayCoverage {
  /** elysium_caller_set / elysium_caller_day hold this day. */
  callers: boolean;
  /** elysium_method_sender_day holds this day. */
  senders: boolean;
}

/** What a read needs from a rollup day: the call sums alone, or also one of the sender lists. */
export type RollupNeed = 'calls' | 'callers' | 'senders';

export interface RollupPlan {
  /** Whole UTC days (YYYY-MM-DD, ascending) read from the day rollups. */
  days: string[];
  /** Whole UTC hours (epoch ms of their start, ascending) read from the hour rollups. */
  hours: number[];
  /** The rest of the window, read from elysium_tx: [from, to) ranges, ascending, never touching. */
  raw: Array<{ from: Date; to: Date }>;
}

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function utcDayStart(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

/** Start of the UTC hour `ms` falls in (epoch ms). */
export function utcHourStart(ms: number): number {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

/**
 * Splits [start, end) between the built days it wholly contains, the built
 * hours the rest wholly contains, and raw ranges. `coverage` holds the built,
 * non-dirty days; `hours` the built, non-dirty hours (epoch ms of their
 * start), used only by a read of the call sums: the hour rollups hold no
 * sender list. An empty or inverted window gives an empty plan.
 */
export function planRollupWindow(
  start: Date,
  end: Date,
  coverage: ReadonlyMap<string, RollupDayCoverage>,
  need: RollupNeed = 'calls',
  hours?: { has(hour: number): boolean }
): RollupPlan {
  const plan: RollupPlan = { days: [], hours: [], raw: [] };
  const from = start.getTime();
  const to = end.getTime();
  if (!(from < to)) return plan;

  const raw = (segFrom: number, segTo: number): void => {
    const last = plan.raw[plan.raw.length - 1];
    if (last && last.to.getTime() === segFrom) last.to = new Date(segTo);
    else plan.raw.push({ from: new Date(segFrom), to: new Date(segTo) });
  };

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
    if (need !== 'calls' || !hours) {
      raw(segFrom, segTo);
      continue;
    }
    // The part of this day the window holds, hour by hour.
    for (let hour = utcHourStart(segFrom); hour < segTo; hour += HOUR_MS) {
      const partFrom = Math.max(segFrom, hour);
      const partTo = Math.min(segTo, hour + HOUR_MS);
      if (partFrom === hour && partTo === hour + HOUR_MS && hours.has(hour)) plan.hours.push(hour);
      else raw(partFrom, partTo);
    }
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

/**
 * The hours whose rollup the builder wants at `now` (epoch ms of their start),
 * the most pressing first:
 * - the last HOUR_RECENT_KEEP hours: today, the first partial day of a 24-hour
 *   window, and yesterday until its day rollup is built;
 * - for each longer window, the hours after the one its start falls in, to
 *   the end of the next UTC day: the rest of the window's first, partial day,
 *   and the day that becomes the first one at the next midnight, built ahead.
 * Nothing before the first hour of the chain, nothing that has not ended.
 */
export function wantedRollupHours(now: Date, genesis: Date): number[] {
  const nowMs = now.getTime();
  const current = utcHourStart(nowMs);
  const first = utcHourStart(genesis.getTime());
  // How soon each hour is used: hours ago for the recent ones, hours past the window's start for the others.
  const urgency = new Map<number, number>();
  const want = (hour: number, score: number): void => {
    if (hour < first || hour >= current) return;
    const known = urgency.get(hour);
    if (known === undefined || score < known) urgency.set(hour, score);
  };
  for (let i = 1; i <= HOUR_RECENT_KEEP; i++) want(current - i * HOUR_MS, i);
  for (const span of WINDOW_SPANS) {
    if (span === 1) continue;
    // The hour the window's start falls in is never whole in the window: the first one that is, is the next.
    const startHour = utcHourStart(nowMs - span * DAY_MS);
    const until = utcDayStart(startHour) + 2 * DAY_MS;
    for (let hour = startHour + HOUR_MS, i = 0; hour < until; hour += HOUR_MS, i++) want(hour, i);
  }
  return [...urgency.entries()].sort((a, b) => a[1] - b[1] || b[0] - a[0]).map(([hour]) => hour);
}

/** Of the wanted hours, those the tx stream is done with: its cursor is HOUR_CLOSE_MARGIN_MS past their end. */
export function closedRollupHours(cursor: Date | null, now: Date, genesis: Date): number[] {
  if (!cursor) return [];
  return wantedRollupHours(now, genesis).filter((hour) => hour + HOUR_MS + HOUR_CLOSE_MARGIN_MS <= cursor.getTime());
}

/**
 * The hours whose rows are kept at `now`: the wanted ones, and the HOUR_KEEP_SLACK hours before
 * each run of them, which a window table refreshed a little earlier may still be standing for.
 */
export function keptRollupHours(now: Date, genesis: Date): Set<number> {
  const kept = new Set<number>();
  for (const hour of wantedRollupHours(now, genesis)) {
    for (let i = 0; i <= HOUR_KEEP_SLACK; i++) kept.add(hour - i * HOUR_MS);
  }
  return kept;
}

/**
 * When the builder next has something to do if nothing is waiting now: at the next hour's
 * close (its end plus the margin, a few seconds later), at the next UTC midnight (the days of
 * every window move then, and the window tables with them), and no later than `idleMs`.
 */
export function nextRollupWakeMs(now: Date, idleMs: number): number {
  const nowMs = now.getTime();
  const slack = 5_000;
  let close = utcHourStart(nowMs) + HOUR_CLOSE_MARGIN_MS + slack;
  if (close <= nowMs) close += HOUR_MS;
  const midnight = utcDayStart(nowMs) + DAY_MS + slack;
  return Math.max(slack, Math.min(idleMs, close - nowMs, midnight - nowMs));
}
