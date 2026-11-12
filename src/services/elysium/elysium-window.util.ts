import type { RollupPlan } from './elysium-rollup.util';

/**
 * Pure helpers of the Elysium window tables (elysium_target_window): what a
 * table should stand for, when the builder has to touch it, and what a reader
 * adds to and takes from it. No I/O.
 *
 * A window table holds, per called address, the sums over a list of whole
 * days and whole hours: the ones a window of that span held when the builder
 * last refreshed it. The list is in the table's state row, each day and hour
 * with the build time of the rollup it was read from. A reader plans its own
 * window (planRollupWindow), compares the two lists, and reads the table plus
 * the few days and hours that differ and its raw ranges. The table is only
 * used while every day and hour it stands for still has the build time it was
 * read at: a rollup rebuilt since is a table that no longer says what it holds.
 */

export interface WindowDay {
  /** YYYY-MM-DD. */
  day: string;
  /** Build time of the day's rollup the table was read from, epoch ms. */
  at: number;
}

export interface WindowHour {
  /** Start of the hour, epoch ms. */
  hour: number;
  /** Build time of the hour's rollup the table was read from, epoch ms. */
  at: number;
}

export interface WindowState {
  span: number;
  /** Moves on every change of the table's rows (a bigint, as text). */
  version: string;
  ready: boolean;
  /** Value of the removal counter the classes were last worked out from nothing under (as text). */
  epoch: string;
  /** The days summed in the base columns. */
  baseDays: WindowDay[];
  /** The days and hours the totals stand for. */
  coverDays: WindowDay[];
  coverHours: WindowHour[];
  refreshedAt: number | null;
}

/** Build time of every built day and hour, clean or dirty. */
export interface RollupBuiltAt {
  days: ReadonlyMap<string, number>;
  hours: ReadonlyMap<number, number>;
}

/** What a reader reads beside the table: the plan's units the table lacks, and the table's units the plan lacks. */
export interface WindowDelta {
  addDays: string[];
  subDays: WindowDay[];
  addHours: number[];
  subHours: WindowHour[];
}

/**
 * A reader gives the table up, and computes as without it, past this many days or hours of
 * difference. Wide enough for the minutes after midnight, before the builder has refreshed
 * the table: the day that is no longer whole in the window comes off, and the hours that
 * are left of it are added (up to 23), with the last hours of yesterday.
 */
export const WINDOW_MAX_DELTA_DAYS = 2;
export const WINDOW_MAX_DELTA_HOURS = 30;
/** After midnight the base waits this long for yesterday's day rollup before it is rebuilt without it. */
export const WINDOW_REBASE_WAIT_MS = 45 * 60_000;

const DAY_MS = 86_400_000;

function sameDays(a: readonly WindowDay[], b: readonly WindowDay[]): boolean {
  if (a.length !== b.length) return false;
  const at = new Map(a.map((d) => [d.day, d.at]));
  return b.every((d) => at.get(d.day) === d.at);
}

/** Whether every day and hour the table stands for (its base included) still has the build time it was read at. */
export function windowUnitsValid(state: WindowState, built: RollupBuiltAt): boolean {
  return (
    state.baseDays.every((d) => built.days.get(d.day) === d.at) &&
    state.coverDays.every((d) => built.days.get(d.day) === d.at) &&
    state.coverHours.every((h) => built.hours.get(h.hour) === h.at)
  );
}

/**
 * What a reader whose window is `plan` reads beside the table, or null when
 * the table cannot be used: not ready, classes worked out before the last
 * contract removal, a rollup of its list rebuilt or dropped since, or too far
 * from the plan to be worth it.
 */
export function windowDelta(plan: RollupPlan, state: WindowState | undefined, built: RollupBuiltAt, epoch: string): WindowDelta | null {
  if (!state || !state.ready || state.epoch !== epoch) return null;
  if (!windowUnitsValid(state, built)) return null;
  const planDays = new Set(plan.days);
  const planHours = new Set(plan.hours);
  const coverDays = new Set(state.coverDays.map((d) => d.day));
  const coverHours = new Set(state.coverHours.map((h) => h.hour));
  const delta: WindowDelta = {
    addDays: plan.days.filter((d) => !coverDays.has(d)),
    subDays: state.coverDays.filter((d) => !planDays.has(d.day)),
    addHours: plan.hours.filter((h) => !coverHours.has(h)),
    subHours: state.coverHours.filter((h) => !planHours.has(h.hour)),
  };
  if (delta.addDays.length + delta.subDays.length > WINDOW_MAX_DELTA_DAYS) return null;
  if (delta.addHours.length + delta.subHours.length > WINDOW_MAX_DELTA_HOURS) return null;
  return delta;
}

/** The plan's days and hours with the build time of each: what the table is to stand for. Null when one of them is not built. */
export function windowTarget(plan: RollupPlan, built: RollupBuiltAt): { days: WindowDay[]; hours: WindowHour[] } | null {
  const days: WindowDay[] = [];
  for (const day of plan.days) {
    const at = built.days.get(day);
    if (at === undefined) return null;
    days.push({ day, at });
  }
  const hours: WindowHour[] = [];
  for (const hour of plan.hours) {
    const at = built.hours.get(hour);
    if (at === undefined) return null;
    hours.push({ hour, at });
  }
  return { days, hours };
}

export interface WindowWork {
  /** The table's rows have to be brought to the target. */
  refresh: boolean;
  /** And its base recomputed from the target's days first. */
  rebase: boolean;
}

/**
 * What the builder does to a table at `now`, given what it stands for and
 * what it should.
 *
 * Refresh: when the table is not usable (not ready, removal counter moved, a
 * rollup of its list rebuilt), when the target holds a day or an hour it
 * lacks (an hour that just closed), or when it holds two or more the target
 * no longer does. One hour too many is left alone: it falls out of every
 * window at each top of the hour, a reader takes it off for the price of that
 * hour's rows, and the refresh comes three minutes later with the new hour.
 *
 * Rebase (spans over a day): the base is a list of whole days; when the days
 * of the window move (midnight), the difference first goes to the edges, a
 * day added or taken off there, and the base is recomputed once yesterday's
 * day rollup is built, or after WINDOW_REBASE_WAIT_MS without it. A base day
 * rebuilt or dropped since forces it at once: its old rows cannot be taken off.
 * `settled` = no day of the window is waiting for its rollup: a table is not
 * started, and a base not recomputed, while the day builder is at work on them.
 */
export function windowWork(
  state: WindowState | undefined,
  target: { days: WindowDay[]; hours: WindowHour[] },
  built: RollupBuiltAt,
  epoch: string,
  now: Date,
  settled: boolean
): WindowWork {
  const span = state?.span ?? 0;
  if (!state || !state.ready || state.epoch !== epoch) return { refresh: settled, rebase: settled };

  const baseValid = state.baseDays.every((d) => built.days.get(d.day) === d.at);
  if (!baseValid) return { refresh: true, rebase: true };

  const coverDays = new Map(state.coverDays.map((d) => [d.day, d.at]));
  const coverHours = new Map(state.coverHours.map((h) => [h.hour, h.at]));
  const targetDays = new Set(target.days.map((d) => d.day));
  const targetHours = new Set(target.hours.map((h) => h.hour));
  const changed =
    state.coverDays.some((d) => built.days.get(d.day) !== d.at) || state.coverHours.some((h) => built.hours.get(h.hour) !== h.at);
  const missing = target.days.some((d) => coverDays.get(d.day) !== d.at) || target.hours.some((h) => coverHours.get(h.hour) !== h.at);
  const extra = state.coverDays.filter((d) => !targetDays.has(d.day)).length + state.coverHours.filter((h) => !targetHours.has(h.hour)).length;

  let rebase = false;
  if (span > 1 && !sameDays(state.baseDays, target.days) && settled) {
    const midnight = Math.floor(now.getTime() / DAY_MS) * DAY_MS;
    const yesterday = new Date(midnight - DAY_MS).toISOString().slice(0, 10);
    rebase = targetDays.has(yesterday) || now.getTime() - midnight >= WINDOW_REBASE_WAIT_MS;
  }
  return { refresh: rebase || changed || missing || extra >= 2, rebase };
}
