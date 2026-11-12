/**
 * Window tables, the pure part: when a reader may use a table and what it
 * reads beside it, and what the builder does to a table (refresh, rebase).
 */
import type { RollupPlan } from '../../../src/services/elysium/elysium-rollup.util';
import {
  windowDelta,
  windowTarget,
  windowUnitsValid,
  windowWork,
  WINDOW_MAX_DELTA_DAYS,
  WINDOW_MAX_DELTA_HOURS,
  WINDOW_MAX_RAW_MS,
  WINDOW_REBASE_WAIT_MS,
  type RollupBuiltAt,
  type WindowState,
} from '../../../src/services/elysium/elysium-window.util';

const HOUR = 3_600_000;
const H = (iso: string): number => Date.parse(iso);
const BUILT_AT = 1_700_000_000_000;

/** Built-at map: every listed day and hour built at BUILT_AT unless said otherwise. */
function built(days: string[], hours: number[], patch: { days?: Record<string, number>; hours?: Record<number, number> } = {}): RollupBuiltAt {
  return {
    days: new Map([...days.map((d) => [d, BUILT_AT] as [string, number]), ...Object.entries(patch.days ?? {})]),
    hours: new Map([...hours.map((h) => [h, BUILT_AT] as [number, number]), ...Object.entries(patch.hours ?? {}).map(([h, at]) => [Number(h), at] as [number, number])]),
  };
}

function state(span: number, days: string[], hours: number[], patch: Partial<WindowState> = {}): WindowState {
  return {
    span,
    version: '7',
    ready: true,
    epoch: '3',
    baseDays: days.map((day) => ({ day, at: BUILT_AT })),
    coverDays: days.map((day) => ({ day, at: BUILT_AT })),
    coverHours: hours.map((hour) => ({ hour, at: BUILT_AT })),
    refreshedAt: BUILT_AT,
    ...patch,
  };
}

const plan = (days: string[], hours: number[]): RollupPlan => ({ days, hours, raw: [] });

const DAYS = ['2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09'];
const TAIL = [H('2026-11-03T21:00:00Z'), H('2026-11-03T22:00:00Z'), H('2026-11-03T23:00:00Z')];
const TODAY = [H('2026-11-10T00:00:00Z'), H('2026-11-10T01:00:00Z')];

describe('windowDelta', () => {
  const everything = built([...DAYS, '2026-11-03'], [...TAIL, ...TODAY, H('2026-11-03T20:00:00Z'), H('2026-11-10T02:00:00Z')]);

  it('reads nothing beside a table that stands for the plan', () => {
    expect(windowDelta(plan(DAYS, [...TAIL, ...TODAY]), state(7, DAYS, [...TAIL, ...TODAY]), everything, '3')).toEqual({
      addDays: [],
      subDays: [],
      addHours: [],
      subHours: [],
    });
  });

  it('takes off the hour that left the window and adds the hour that closed since', () => {
    const st = state(7, DAYS, [H('2026-11-03T20:00:00Z'), ...TAIL, ...TODAY]);
    const delta = windowDelta(plan(DAYS, [...TAIL, ...TODAY, H('2026-11-10T02:00:00Z')]), st, everything, '3');
    expect(delta).toEqual({
      addDays: [],
      subDays: [],
      addHours: [H('2026-11-10T02:00:00Z')],
      subHours: [{ hour: H('2026-11-03T20:00:00Z'), at: BUILT_AT }],
    });
  });

  it('takes off a day the plan no longer reads whole, and adds one the table lacks', () => {
    const st = state(7, ['2026-11-03', ...DAYS.slice(0, 5)], TAIL);
    const delta = windowDelta(plan(DAYS, TAIL), st, everything, '3');
    expect(delta?.subDays).toEqual([{ day: '2026-11-03', at: BUILT_AT }]);
    expect(delta?.addDays).toEqual(['2026-11-09']);
  });

  it('gives the table up when it is not ready, or its classes are older than the last contract removal', () => {
    const p = plan(DAYS, TAIL);
    expect(windowDelta(p, undefined, everything, '3')).toBeNull();
    expect(windowDelta(p, state(7, DAYS, TAIL, { ready: false }), everything, '3')).toBeNull();
    expect(windowDelta(p, state(7, DAYS, TAIL), everything, '4')).toBeNull();
  });

  it('gives the table up when a rollup it stands for was rebuilt or dropped since', () => {
    const p = plan(DAYS, TAIL);
    const st = state(7, DAYS, TAIL);
    expect(windowDelta(p, st, built(DAYS, TAIL, { days: { '2026-11-06': BUILT_AT + 1 } }), '3')).toBeNull();
    expect(windowDelta(p, st, built(DAYS, TAIL, { hours: { [TAIL[1]]: BUILT_AT + 1 } }), '3')).toBeNull();
    expect(windowDelta(p, st, built(DAYS.slice(1), TAIL), '3')).toBeNull();
    expect(windowDelta(p, st, built(DAYS, TAIL.slice(1)), '3')).toBeNull();
    // A day of the base that the totals no longer stand for counts too: its rows are what the edges took off.
    const moved = state(7, DAYS, TAIL, { baseDays: [{ day: '2026-11-03', at: BUILT_AT }, ...DAYS.slice(0, 5).map((day) => ({ day, at: BUILT_AT }))] });
    expect(windowDelta(p, moved, built(DAYS, TAIL), '3')).toBeNull();
    expect(windowUnitsValid(moved, built([...DAYS, '2026-11-03'], TAIL))).toBe(true);
  });

  it('gives the table up when the plan leaves more than six hours to elysium_tx (a dirty day, hours not built)', () => {
    const st = state(7, DAYS, TAIL);
    const raw = (hours: number) => [{ from: new Date('2026-11-10T00:00:00Z'), to: new Date(Date.parse('2026-11-10T00:00:00Z') + hours * HOUR) }];
    expect(windowDelta({ days: DAYS, hours: TAIL, raw: raw(WINDOW_MAX_RAW_MS / HOUR) }, st, everything, '3')).not.toBeNull();
    expect(windowDelta({ days: DAYS, hours: TAIL, raw: raw(WINDOW_MAX_RAW_MS / HOUR + 1) }, st, everything, '3')).toBeNull();
    // Counted over all the ranges.
    const split = [...raw(4), { from: new Date('2026-11-03T08:00:00Z'), to: new Date('2026-11-03T11:00:00Z') }];
    expect(windowDelta({ days: DAYS, hours: TAIL, raw: split }, st, everything, '3')).toBeNull();
  });

  it('gives the table up when it is too far from the plan to be worth it', () => {
    const hours: number[] = [];
    for (let i = 0; i <= WINDOW_MAX_DELTA_HOURS; i++) hours.push(H('2026-11-01T00:00:00Z') + i * HOUR);
    const all = built(['2026-11-01', '2026-11-02', '2026-11-03', ...DAYS], hours);
    expect(windowDelta(plan(DAYS, hours.slice(0, WINDOW_MAX_DELTA_HOURS)), state(7, DAYS, []), all, '3')).not.toBeNull();
    expect(windowDelta(plan(DAYS, hours), state(7, DAYS, []), all, '3')).toBeNull();
    const far = state(7, ['2026-11-01', '2026-11-02', '2026-11-03', ...DAYS.slice(0, 3)], []);
    expect(WINDOW_MAX_DELTA_DAYS).toBe(2);
    expect(windowDelta(plan(DAYS, []), far, all, '3')).toBeNull();
  });
});

describe('windowTarget', () => {
  it('gives each day and hour of the plan with the build time of its rollup', () => {
    const b = built(DAYS, TAIL, { days: { '2026-11-09': BUILT_AT + 5 } });
    expect(windowTarget(plan(['2026-11-08', '2026-11-09'], [TAIL[0]]), b)).toEqual({
      days: [
        { day: '2026-11-08', at: BUILT_AT },
        { day: '2026-11-09', at: BUILT_AT + 5 },
      ],
      hours: [{ hour: TAIL[0], at: BUILT_AT }],
    });
  });

  it('gives nothing when a day or an hour of the plan is not built', () => {
    expect(windowTarget(plan(['2026-11-02'], []), built(DAYS, TAIL))).toBeNull();
    expect(windowTarget(plan([], [H('2026-11-01T00:00:00Z')]), built(DAYS, TAIL))).toBeNull();
  });
});

describe('windowWork', () => {
  const now = new Date('2026-11-10T08:01:20.000Z');
  const all = built(['2026-11-03', ...DAYS], [H('2026-11-03T20:00:00Z'), ...TAIL, ...TODAY, H('2026-11-10T02:00:00Z')]);
  const target = (days: string[], hours: number[]) => ({ days: days.map((day) => ({ day, at: BUILT_AT })), hours: hours.map((hour) => ({ hour, at: BUILT_AT })) });

  it('leaves alone a table that stands for the target', () => {
    expect(windowWork(state(7, DAYS, [...TAIL, ...TODAY]), target(DAYS, [...TAIL, ...TODAY]), all, '3', now, true)).toEqual({ refresh: false, rebase: false });
  });

  it('starts a table from nothing, with its base, once no day of the window waits for its rollup', () => {
    const t = target(DAYS, TAIL);
    expect(windowWork(undefined, t, all, '3', now, true)).toEqual({ refresh: true, rebase: true });
    expect(windowWork(undefined, t, all, '3', now, false)).toEqual({ refresh: false, rebase: false });
    expect(windowWork(state(7, DAYS, TAIL, { ready: false }), t, all, '3', now, true)).toEqual({ refresh: true, rebase: true });
    // A contract was removed since the classes were worked out.
    expect(windowWork(state(7, DAYS, TAIL), t, all, '4', now, true)).toEqual({ refresh: true, rebase: true });
  });

  it('refreshes when an hour closed: the target holds one the table lacks', () => {
    expect(windowWork(state(7, DAYS, [...TAIL, ...TODAY]), target(DAYS, [...TAIL, ...TODAY, H('2026-11-10T02:00:00Z')]), all, '3', now, true)).toEqual({
      refresh: true,
      rebase: false,
    });
  });

  it('leaves one hour too many alone (it falls out at each top of the hour), and refreshes at two', () => {
    const st = state(7, DAYS, [H('2026-11-03T20:00:00Z'), ...TAIL, ...TODAY]);
    expect(windowWork(st, target(DAYS, [...TAIL, ...TODAY]), all, '3', now, true)).toEqual({ refresh: false, rebase: false });
    expect(windowWork(st, target(DAYS, [...TAIL.slice(1), ...TODAY]), all, '3', now, true)).toEqual({ refresh: true, rebase: false });
  });

  it('refreshes when an hour it stands for was rebuilt', () => {
    const rebuilt = built(['2026-11-03', ...DAYS], [...TAIL, ...TODAY], { hours: { [TODAY[0]]: BUILT_AT + 9 } });
    const t = { days: DAYS.map((day) => ({ day, at: BUILT_AT })), hours: [...TAIL, ...TODAY].map((hour) => ({ hour, at: hour === TODAY[0] ? BUILT_AT + 9 : BUILT_AT })) };
    expect(windowWork(state(7, DAYS, [...TAIL, ...TODAY]), t, rebuilt, '3', now, true)).toEqual({ refresh: true, rebase: false });
  });

  it('recomputes the base at once when one of its days was rebuilt or dropped', () => {
    const t = target(DAYS, TAIL);
    expect(windowWork(state(7, DAYS, TAIL), t, built(DAYS, TAIL, { days: { '2026-11-07': BUILT_AT + 1 } }), '3', now, false)).toEqual({ refresh: true, rebase: true });
    expect(windowWork(state(7, DAYS, TAIL), t, built(DAYS.slice(1), TAIL), '3', now, false)).toEqual({ refresh: true, rebase: true });
  });

  describe('after midnight, when the days of the window move', () => {
    const oldBase = ['2026-11-03', ...DAYS.slice(0, 5)];
    const st = state(7, oldBase, TAIL);

    it('first moves the edges: the base waits for yesterday`s day rollup', () => {
      const early = new Date('2026-11-10T00:01:00.000Z');
      // Yesterday (11-09) is not built: the target holds the days up to 11-08.
      expect(windowWork(st, target(DAYS.slice(0, 5), TAIL), all, '3', early, true)).toEqual({ refresh: false, rebase: false });
      // The hours left of the day that is no longer whole, and yesterday's: the edges are refreshed, not the base.
      expect(windowWork(st, target(DAYS.slice(0, 5), [...TAIL, H('2026-11-09T00:00:00Z')]), built(['2026-11-03', ...DAYS], [...TAIL, H('2026-11-09T00:00:00Z')]), '3', early, true)).toEqual({
        refresh: true,
        rebase: false,
      });
    });

    it('recomputes the base once yesterday is built', () => {
      expect(windowWork(st, target(DAYS, TAIL), all, '3', new Date('2026-11-10T00:13:00.000Z'), true)).toEqual({ refresh: true, rebase: true });
    });

    it('recomputes it without yesterday after 45 minutes', () => {
      const t = target(DAYS.slice(0, 5), TAIL);
      const midnight = Date.parse('2026-11-10T00:00:00Z');
      expect(windowWork(st, t, all, '3', new Date(midnight + WINDOW_REBASE_WAIT_MS - 1), true)).toEqual({ refresh: false, rebase: false });
      expect(windowWork(st, t, all, '3', new Date(midnight + WINDOW_REBASE_WAIT_MS), true)).toEqual({ refresh: true, rebase: true });
    });

    it('does not recompute it while a day of the window waits for its rollup', () => {
      expect(windowWork(st, target(DAYS, TAIL), all, '3', new Date('2026-11-10T00:13:00.000Z'), false).rebase).toBe(false);
    });

    it('never gives the 24-hour table a base', () => {
      const one = state(1, [], TAIL);
      expect(windowWork(one, target(['2026-11-09'], TAIL), all, '3', new Date('2026-11-10T00:00:00.000Z'), true)).toEqual({ refresh: true, rebase: false });
    });
  });
});
