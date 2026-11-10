/**
 * Day rollups, the pure part: how a window splits between built days and raw
 * ranges (the two must never overlap and must cover the window), and which
 * days may be built.
 */
import {
  closedRollupDays,
  firstKeptDay,
  isWithinDays,
  planRollupWindow,
  ROLLUP_CLOSE_MARGIN_MS,
  rollupKeepDays,
  RollupDayCoverage,
  RollupPlan,
} from '../../../src/services/elysium/elysium-rollup.util';

const DAY = 86_400_000;
const at = (iso: string): Date => new Date(iso);
const full: RollupDayCoverage = { callers: true, senders: true };

function coverage(days: Record<string, Partial<RollupDayCoverage> | true>): Map<string, RollupDayCoverage> {
  return new Map(
    Object.entries(days).map(([day, v]) => [day, v === true ? full : { callers: false, senders: false, ...v }])
  );
}

const range = (from: string, to: string) => ({ from: at(from), to: at(to) });

/** Milliseconds of the window covered by the plan, and whether any part is covered twice. */
function covered(plan: RollupPlan): { ms: number; overlap: boolean } {
  const parts = [
    ...plan.days.map((d) => [Date.parse(`${d}T00:00:00Z`), Date.parse(`${d}T00:00:00Z`) + DAY]),
    ...plan.raw.map((r) => [r.from.getTime(), r.to.getTime()]),
  ].sort((a, b) => a[0] - b[0]);
  let overlap = false;
  for (let i = 1; i < parts.length; i++) if (parts[i][0] < parts[i - 1][1]) overlap = true;
  return { ms: parts.reduce((s, p) => s + p[1] - p[0], 0), overlap };
}

describe('planRollupWindow', () => {
  const now = at('2026-11-10T08:01:00.000Z');
  const built = coverage({
    '2026-11-03': true,
    '2026-11-04': true,
    '2026-11-05': true,
    '2026-11-06': true,
    '2026-11-07': true,
    '2026-11-08': true,
    '2026-11-09': true,
  });

  it('reads the whole built days from the rollups and the two partial days raw', () => {
    const plan = planRollupWindow(at('2026-11-03T08:01:00.000Z'), now, built);
    expect(plan.days).toEqual(['2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09']);
    expect(plan.raw).toEqual([
      range('2026-11-03T08:01:00.000Z', '2026-11-04T00:00:00.000Z'),
      range('2026-11-10T00:00:00.000Z', '2026-11-10T08:01:00.000Z'),
    ]);
  });

  it('reads everything raw when no day is built: the window as one range', () => {
    const plan = planRollupWindow(at('2026-11-03T08:01:00.000Z'), now, new Map());
    expect(plan.days).toEqual([]);
    expect(plan.raw).toEqual([range('2026-11-03T08:01:00.000Z', '2026-11-10T08:01:00.000Z')]);
  });

  it('never uses a day the window holds only in part, built or not', () => {
    const plan = planRollupWindow(at('2026-11-09T08:01:00.000Z'), now, built);
    expect(plan.days).toEqual([]);
    expect(plan.raw).toEqual([range('2026-11-09T08:01:00.000Z', '2026-11-10T08:01:00.000Z')]);
  });

  it('uses the first day when the window starts exactly at midnight', () => {
    const plan = planRollupWindow(at('2026-11-08T00:00:00.000Z'), at('2026-11-10T00:00:00.000Z'), built);
    expect(plan.days).toEqual(['2026-11-08', '2026-11-09']);
    expect(plan.raw).toEqual([]);
  });

  it('reads a day that is not built (or dirty, so absent from the coverage) raw, between two rollup spans', () => {
    const holed = new Map(built);
    holed.delete('2026-11-06');
    const plan = planRollupWindow(at('2026-11-04T00:00:00.000Z'), at('2026-11-09T00:00:00.000Z'), holed);
    expect(plan.days).toEqual(['2026-11-04', '2026-11-05', '2026-11-07', '2026-11-08']);
    expect(plan.raw).toEqual([range('2026-11-06T00:00:00.000Z', '2026-11-07T00:00:00.000Z')]);
  });

  it('merges the raw ranges that touch', () => {
    const holed = new Map(built);
    holed.delete('2026-11-09');
    const plan = planRollupWindow(at('2026-11-08T00:00:00.000Z'), now, holed);
    expect(plan.days).toEqual(['2026-11-08']);
    expect(plan.raw).toEqual([range('2026-11-09T00:00:00.000Z', '2026-11-10T08:01:00.000Z')]);
  });

  it('takes a day for callers or senders only when that list was built for it', () => {
    const cov = coverage({
      '2026-11-07': { callers: true },
      '2026-11-08': { senders: true },
      '2026-11-09': true,
    });
    const start = at('2026-11-07T00:00:00.000Z');
    const end = at('2026-11-10T00:00:00.000Z');
    expect(planRollupWindow(start, end, cov).days).toEqual(['2026-11-07', '2026-11-08', '2026-11-09']);
    expect(planRollupWindow(start, end, cov, 'callers').days).toEqual(['2026-11-07', '2026-11-09']);
    expect(planRollupWindow(start, end, cov, 'callers').raw).toEqual([range('2026-11-08T00:00:00.000Z', '2026-11-09T00:00:00.000Z')]);
    expect(planRollupWindow(start, end, cov, 'senders').days).toEqual(['2026-11-08', '2026-11-09']);
  });

  it('gives an empty plan for an empty or inverted window', () => {
    expect(planRollupWindow(now, now, built)).toEqual({ days: [], raw: [] });
    expect(planRollupWindow(now, at('2026-11-09T00:00:00.000Z'), built)).toEqual({ days: [], raw: [] });
  });

  it('covers the window exactly once, whatever is built', () => {
    const all = ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09'];
    let seed = 7;
    const rnd = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < 300; i++) {
      const cov = new Map(all.filter(() => rnd() < 0.7).map((d) => [d, { callers: rnd() < 0.5, senders: rnd() < 0.5 }]));
      const start = Date.parse('2026-10-30T00:00:00Z') + Math.floor(rnd() * 8 * DAY);
      // One window in five starts or ends on a day edge.
      const from = rnd() < 0.2 ? Math.floor(start / DAY) * DAY : start;
      const length = Math.floor(rnd() * 4 * DAY) + 1;
      const to = rnd() < 0.2 ? Math.ceil((from + length) / DAY) * DAY : from + length;
      for (const need of ['calls', 'callers', 'senders'] as const) {
        const plan = planRollupWindow(new Date(from), new Date(to), cov, need);
        const c = covered(plan);
        expect(c.overlap).toBe(false);
        expect(c.ms).toBe(to - from);
        for (const d of plan.days) {
          expect(cov.has(d)).toBe(true);
          expect(Date.parse(`${d}T00:00:00Z`)).toBeGreaterThanOrEqual(from);
          expect(Date.parse(`${d}T00:00:00Z`) + DAY).toBeLessThanOrEqual(to);
        }
      }
    }
  });
});

describe('closedRollupDays', () => {
  const genesis = at('2026-09-11T11:55:00Z');
  const now = at('2026-11-10T08:00:00Z');

  it('lists nothing while the tx stream has no cursor', () => {
    expect(closedRollupDays(null, now, genesis)).toEqual([]);
  });

  it('lists the days that are over, newest first, back to the first day of the chain or the kept span', () => {
    const days = closedRollupDays(at('2026-11-10T07:59:00Z'), now, genesis);
    expect(days[0]).toBe('2026-11-09');
    expect(days[days.length - 1]).toBe('2026-09-11');
    expect(days).toHaveLength(60);
    expect(closedRollupDays(at('2026-11-10T07:59:00Z'), now, genesis, 5)).toEqual([
      '2026-11-09', '2026-11-08', '2026-11-07', '2026-11-06', '2026-11-05',
    ]);
  });

  it('waits for the tx stream to be 10 minutes past the end of a day', () => {
    const midnight = Date.parse('2026-11-10T00:00:00Z');
    const justAfter = at('2026-11-10T00:12:00Z');
    expect(closedRollupDays(new Date(midnight + ROLLUP_CLOSE_MARGIN_MS - 1), justAfter, genesis)[0]).toBe('2026-11-08');
    expect(closedRollupDays(new Date(midnight + ROLLUP_CLOSE_MARGIN_MS), justAfter, genesis)[0]).toBe('2026-11-09');
  });

  it('stops at the cursor of a stream that is days behind', () => {
    expect(closedRollupDays(at('2026-11-05T12:00:00Z'), now, genesis)[0]).toBe('2026-11-04');
  });

  it('never lists today', () => {
    expect(closedRollupDays(at('2026-11-12T00:00:00Z'), now, genesis)[0]).toBe('2026-11-09');
  });
});

describe('isWithinDays / firstKeptDay', () => {
  const now = at('2026-11-10T08:00:00Z');
  it('counts whole UTC days before today', () => {
    expect(isWithinDays('2026-11-09', now, 1)).toBe(true);
    expect(isWithinDays('2026-11-08', now, 1)).toBe(false);
    expect(isWithinDays('2026-11-10', now, 8)).toBe(false);
    expect(isWithinDays('2026-11-02', now, 8)).toBe(true);
    expect(isWithinDays('2026-11-01', now, 8)).toBe(false);
  });
  it('names the first day a table keeps', () => {
    expect(firstKeptDay(now, 10)).toBe('2026-10-31');
    expect(firstKeptDay(at('2026-11-10T00:00:00Z'), 1)).toBe('2026-11-09');
  });
});

describe('rollupKeepDays', () => {
  afterEach(() => {
    delete process.env.ELYSIUM_ROLLUP_KEEP_DAYS;
  });
  it('keeps 63 days by default, and for a value that is not a positive number', () => {
    expect(rollupKeepDays()).toBe(63);
    for (const v of ['', 'abc', '0', '-5']) {
      process.env.ELYSIUM_ROLLUP_KEEP_DAYS = v;
      expect(rollupKeepDays()).toBe(63);
    }
  });
  it('takes ELYSIUM_ROLLUP_KEEP_DAYS, never under 10', () => {
    process.env.ELYSIUM_ROLLUP_KEEP_DAYS = '33';
    expect(rollupKeepDays()).toBe(33);
    process.env.ELYSIUM_ROLLUP_KEEP_DAYS = '3';
    expect(rollupKeepDays()).toBe(10);
  });
  it('bounds the days that may be built', () => {
    process.env.ELYSIUM_ROLLUP_KEEP_DAYS = '12';
    const days = closedRollupDays(new Date('2026-11-10T07:59:00Z'), new Date('2026-11-10T08:00:00Z'), new Date('2026-09-11T11:55:00Z'));
    expect(days).toHaveLength(12);
    expect(days[days.length - 1]).toBe('2026-10-29');
  });
});
