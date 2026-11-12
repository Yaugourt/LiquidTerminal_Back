/**
 * Rollups, read side: which days and hours count as built, what the window
 * tables stand for, and what the distinct callers read asks elysium_tx for
 * (one explicit range per target, never a target's whole history).
 */
const queryRaw = jest.fn();
const profileQueryRaw = jest.fn();
const executeRaw = jest.fn();
const executeRawUnsafe = jest.fn();
const transaction = jest.fn();
jest.mock('../../../src/core/prisma.historical.service', () => ({
  // The scheduled aggregates' pool, the default; the read pool is what the contract profile passes.
  // A transaction runs its callback on a client whose statements land in the same mocks.
  prismaHistoricalAggregate: {
    $queryRaw: queryRaw,
    $transaction: (fn: (tx: unknown) => Promise<unknown>, options: unknown) => {
      transaction(options);
      return fn({ $queryRaw: queryRaw, $executeRaw: executeRaw, $executeRawUnsafe: executeRawUnsafe });
    },
  },
  prismaHistoricalRead: { $queryRaw: profileQueryRaw },
}));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { Prisma } from '../../../prisma-historical/generated/client';
import {
  distinctCallers,
  emptyRollupCoverage,
  hashGrouped,
  planWindow,
  rawRanges,
  readRollupCoverage,
  rollupDays,
  rollupHours,
  RollupCoverageUnreadableError,
  withWorkMem,
  type RollupCoverage,
} from '../../../src/services/elysium/elysium-rollup.reader';
import { prismaHistoricalAggregate, prismaHistoricalRead } from '../../../src/core/prisma.historical.service';
import type { RollupDayCoverage } from '../../../src/services/elysium/elysium-rollup.util';

const at = (iso: string): Date => new Date(iso);
const A = '0x' + 'a1'.repeat(20);
const B = '0x' + 'b2'.repeat(20);
const full: RollupDayCoverage = { callers: true, senders: true };

/** The values bound to the nth statement, nested SQL fragments flattened. */
function boundValues(call: number): unknown[] {
  const [strings, ...values] = queryRaw.mock.calls[call] as [TemplateStringsArray, ...unknown[]];
  return Prisma.sql(strings, ...values).values;
}

describe('rollup reader', () => {
  beforeEach(() => {
    queryRaw.mockReset();
    profileQueryRaw.mockReset();
    executeRaw.mockReset();
    executeRawUnsafe.mockReset();
    transaction.mockReset();
  });
  afterEach(() => {
    delete process.env.ELYSIUM_ROLLUPS_ENABLED;
    delete process.env.ELYSIUM_WINDOWS_ENABLED;
  });

  describe('readRollupCoverage', () => {
    const now = at('2026-11-10T08:00:00Z');

    const dayRow = (day: string, patch: Record<string, unknown> = {}) => ({
      kind: 'day',
      key: day,
      at: 1_762_000_000_000,
      dirty: false,
      callers: true,
      senders: true,
      state: null,
      ...patch,
    });
    const hourRow = (iso: string, patch: Record<string, unknown> = {}) => ({
      kind: 'hour',
      key: String(Date.parse(iso)),
      at: 1_762_000_000_500,
      dirty: false,
      callers: false,
      senders: false,
      state: null,
      ...patch,
    });
    const windowRow = (span: number, patch: Record<string, unknown> = {}) => ({
      kind: 'window',
      key: String(span),
      at: null,
      dirty: false,
      callers: false,
      senders: false,
      state: {
        span,
        version: '12',
        ready: true,
        epoch: '4',
        base_days: [{ day: '2026-11-08', at: 1_762_000_000_000 }],
        cover_days: [{ day: '2026-11-08', at: 1_762_000_000_000 }],
        cover_hours: [{ hour: Date.parse('2026-11-10T06:00:00Z'), at: 1_762_000_000_500 }],
        refreshed_ms: 1_762_000_100_000,
        ...patch,
      },
    });

    it('maps the built days and asks for the kept span only', async () => {
      queryRaw.mockResolvedValue([dayRow('2026-11-08', { senders: false }), dayRow('2026-11-09')]);
      const coverage = await readRollupCoverage(now);
      expect([...coverage.days]).toEqual([
        ['2026-11-08', { callers: true, senders: false }],
        ['2026-11-09', { callers: true, senders: true }],
      ]);
      expect(boundValues(0)).toEqual(['2026-09-08']);
    });

    it('keeps a dirty day and a dirty hour out of what is read, but knows when each was built', async () => {
      queryRaw.mockResolvedValue([
        dayRow('2026-11-08', { dirty: true, at: 1_762_000_000_111 }),
        dayRow('2026-11-09'),
        hourRow('2026-11-10T05:00:00Z', { dirty: true }),
        hourRow('2026-11-10T06:00:00Z'),
      ]);
      const coverage = await readRollupCoverage(now);
      expect([...coverage.days.keys()]).toEqual(['2026-11-09']);
      expect([...coverage.hours]).toEqual([Date.parse('2026-11-10T06:00:00Z')]);
      // What a window table was read from is checked against these, clean or not.
      expect(coverage.built.days.get('2026-11-08')).toBe(1_762_000_000_111);
      expect(coverage.built.hours.get(Date.parse('2026-11-10T05:00:00Z'))).toBe(1_762_000_000_500);
    });

    it('reads the window tables` states, and the removal counter from the row of span 0', async () => {
      queryRaw.mockResolvedValue([windowRow(7), windowRow(0, { version: '9' }), windowRow(30, { ready: false })]);
      const coverage = await readRollupCoverage(now);
      expect(coverage.epoch).toBe('9');
      expect([...coverage.windows.keys()]).toEqual([7, 30]);
      expect(coverage.windows.get(7)).toEqual({
        span: 7,
        version: '12',
        ready: true,
        epoch: '4',
        baseDays: [{ day: '2026-11-08', at: 1_762_000_000_000 }],
        coverDays: [{ day: '2026-11-08', at: 1_762_000_000_000 }],
        coverHours: [{ hour: Date.parse('2026-11-10T06:00:00Z'), at: 1_762_000_000_500 }],
        refreshedAt: 1_762_000_100_000,
      });
      expect(coverage.windows.get(30)?.ready).toBe(false);
    });

    it('reads no window table when they are switched off, and still the days and hours', async () => {
      process.env.ELYSIUM_WINDOWS_ENABLED = 'false';
      queryRaw.mockResolvedValue([dayRow('2026-11-09'), hourRow('2026-11-10T06:00:00Z'), windowRow(7)]);
      const coverage = await readRollupCoverage(now);
      expect(coverage.windows.size).toBe(0);
      expect(coverage.days.size).toBe(1);
      expect(coverage.hours.size).toBe(1);
    });

    it('splits a window between built days, built hours and elysium_tx', async () => {
      queryRaw.mockResolvedValue([dayRow('2026-11-09'), hourRow('2026-11-10T06:00:00Z'), hourRow('2026-11-10T07:00:00Z', { dirty: true })]);
      const coverage = await readRollupCoverage(now);
      const plan = planWindow(at('2026-11-09T00:00:00Z'), at('2026-11-10T08:00:00Z'), coverage);
      expect(plan.days).toEqual(['2026-11-09']);
      expect(plan.hours).toEqual([Date.parse('2026-11-10T06:00:00Z')]);
      expect(plan.raw).toEqual([
        { from: at('2026-11-10T00:00:00.000Z'), to: at('2026-11-10T06:00:00.000Z') },
        { from: at('2026-11-10T07:00:00.000Z'), to: at('2026-11-10T08:00:00.000Z') },
      ]);
    });

    it('gives the computation up when the list cannot be read: "nothing built" would send the whole window to the raw table', async () => {
      queryRaw.mockRejectedValue(new Error('timeout exceeded when trying to connect'));
      await expect(readRollupCoverage(now)).rejects.toBeInstanceOf(RollupCoverageUnreadableError);
    });

    it('answers "nothing built" on a failed read only where the caller says its read is bounded anyway', async () => {
      profileQueryRaw.mockRejectedValue(new Error('timeout exceeded when trying to connect'));
      await expect(readRollupCoverage(now, { db: prismaHistoricalRead, onFailure: 'raw' })).resolves.toEqual(emptyRollupCoverage());
      // On the pool it was given, not on the aggregates'.
      expect(profileQueryRaw).toHaveBeenCalledTimes(1);
      expect(queryRaw).not.toHaveBeenCalled();
    });

    it('answers "nothing built" without a query when the rollups are switched off', async () => {
      process.env.ELYSIUM_ROLLUPS_ENABLED = 'false';
      await expect(readRollupCoverage(now)).resolves.toEqual(emptyRollupCoverage());
      expect(queryRaw).not.toHaveBeenCalled();
    });
  });

  describe('SQL pieces', () => {
    it('writes the raw ranges as an OR of half-open intervals, bound as ISO text', () => {
      const sql = rawRanges(Prisma.sql`t.block_time`, {
        days: [],
        hours: [],
        raw: [
          { from: at('2026-11-03T08:00:00.000Z'), to: at('2026-11-04T00:00:00.000Z') },
          { from: at('2026-11-10T00:00:00.000Z'), to: at('2026-11-10T08:00:00.000Z') },
        ],
      });
      expect(sql.sql.replace(/\s+/g, ' ')).toBe(
        '((t.block_time >= ?::timestamptz AND t.block_time < ?::timestamptz) OR (t.block_time >= ?::timestamptz AND t.block_time < ?::timestamptz))'
      );
      expect(sql.values).toEqual([
        '2026-11-03T08:00:00.000Z', '2026-11-04T00:00:00.000Z', '2026-11-10T00:00:00.000Z', '2026-11-10T08:00:00.000Z',
      ]);
    });

    it('selects no raw row when the plan has no raw range', () => {
      expect(rawRanges(Prisma.sql`t.block_time`, { days: ['2026-11-09'], hours: [], raw: [] }).sql).toBe('FALSE');
    });

    it('binds the rollup days as one array', () => {
      const sql = rollupDays({ days: ['2026-11-08', '2026-11-09'], hours: [], raw: [] });
      expect(sql.sql).toBe('?::text[]::date[]');
      expect(sql.values).toEqual([['2026-11-08', '2026-11-09']]);
    });

    it('binds the rollup hours as one array of ISO times', () => {
      const sql = rollupHours({ days: [], hours: [Date.parse('2026-11-10T06:00:00Z'), Date.parse('2026-11-10T07:00:00Z')], raw: [] });
      expect(sql.sql).toBe('?::text[]::timestamptz[]');
      expect(sql.values).toEqual([['2026-11-10T06:00:00.000Z', '2026-11-10T07:00:00.000Z']]);
    });
  });

  describe('hashGrouped', () => {
    it('gives the statement memory and tells the planner not to sort, for that statement only, in a transaction with its own limits', async () => {
      queryRaw.mockResolvedValue([{ n: 1 }]);
      const rows = await hashGrouped(prismaHistoricalAggregate, (tx) => tx.$queryRaw`SELECT 1 AS n`);
      expect(rows).toEqual([{ n: 1 }]);
      expect(executeRawUnsafe.mock.calls).toEqual([[`SET LOCAL work_mem = '64MB'`]]);
      expect(executeRaw).toHaveBeenCalledTimes(1);
      expect((executeRaw.mock.calls[0][0] as string[]).join('')).toBe('SET LOCAL enable_sort = off');
      // The settings are sent before the statement, in the same transaction.
      expect(executeRawUnsafe.mock.invocationCallOrder[0]).toBeLessThan(queryRaw.mock.invocationCallOrder[0]);
      expect(executeRaw.mock.invocationCallOrder[0]).toBeLessThan(queryRaw.mock.invocationCallOrder[0]);
      // Prisma ends a transaction after 5 seconds unless told otherwise: these statements take longer on prod.
      const options = transaction.mock.calls[0][0] as { timeout: number; maxWait: number };
      expect(options.timeout).toBeGreaterThanOrEqual(600_000);
      expect(options.maxWait).toBeGreaterThanOrEqual(600_000);
    });

    it('withWorkMem gives the memory alone: a statement that ends on an ORDER BY keeps its sort', async () => {
      queryRaw.mockResolvedValue([]);
      await withWorkMem(prismaHistoricalAggregate, (tx) => tx.$queryRaw`SELECT 1`);
      expect(executeRawUnsafe).toHaveBeenCalledTimes(1);
      expect(executeRaw).not.toHaveBeenCalled();
      expect((transaction.mock.calls[0][0] as { timeout: number }).timeout).toBeGreaterThanOrEqual(600_000);
    });
  });

  describe('distinctCallers', () => {
    const start = at('2026-11-03T08:00:00.000Z');
    const end = at('2026-11-10T08:00:00.000Z');
    const withDays = (days: Map<string, RollupDayCoverage>): RollupCoverage => ({ ...emptyRollupCoverage(), days });
    const coverage = withDays(new Map(['2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09'].map((d) => [d, full])));

    it('asks nothing for no address', async () => {
      await expect(distinctCallers([], start, end, coverage)).resolves.toEqual(new Map());
      expect(queryRaw).not.toHaveBeenCalled();
    });

    it('reads elysium_tx by explicit ranges: the window edges for every target, and each quiet span once', async () => {
      queryRaw
        .mockResolvedValueOnce([
          // B has no caller list on three days, two of them consecutive.
          { address: B, day: '2026-11-05' },
          { address: B, day: '2026-11-06' },
          { address: B, day: '2026-11-09' },
        ])
        .mockResolvedValueOnce([
          { address: A, callers: 1200 },
          { address: B, callers: 37 },
        ]);

      const result = await distinctCallers([A, B], start, end, coverage);

      expect(result).toEqual(new Map([[A, 1200], [B, 37]]));
      const days = ['2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09'];
      expect(boundValues(0)).toEqual([[A, B], days]);
      const [listDays, listAddrs, probeAddrs, probeFrom, probeTo] = boundValues(1) as [string[], string[], string[], string[], string[]];
      expect(listDays).toEqual(days);
      expect(listAddrs).toEqual([A, B]);
      expect(probeAddrs.map((a, i) => `${a === A ? 'A' : 'B'} ${probeFrom[i]} ${probeTo[i]}`)).toEqual([
        'A 2026-11-03T08:00:00.000Z 2026-11-04T00:00:00.000Z',
        'A 2026-11-10T00:00:00.000Z 2026-11-10T08:00:00.000Z',
        'B 2026-11-03T08:00:00.000Z 2026-11-04T00:00:00.000Z',
        'B 2026-11-10T00:00:00.000Z 2026-11-10T08:00:00.000Z',
        'B 2026-11-05T00:00:00.000Z 2026-11-07T00:00:00.000Z',
        'B 2026-11-09T00:00:00.000Z 2026-11-10T00:00:00.000Z',
      ]);
    });

    it('counts the pairs as a hash: the statement runs with the planner told not to sort', async () => {
      queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([{ address: A, callers: 3 }]);
      await distinctCallers([A], start, end, coverage);
      expect(executeRaw).toHaveBeenCalledTimes(1);
      const text = (queryRaw.mock.calls[1][0] as string[]).join('?');
      expect(text).toMatch(/GROUP BY address, from_addr/);
      expect(text).not.toMatch(/count\(DISTINCT/);
    });

    it('reads the whole window from elysium_tx when no day has its caller lists', async () => {
      queryRaw.mockResolvedValueOnce([{ address: A, callers: 5 }]);
      const noLists = withDays(new Map([...coverage.days].map(([d]) => [d, { callers: false, senders: true }])));

      await distinctCallers([A], start, end, noLists);

      // No built day: the question about quiet days is not asked.
      expect(queryRaw).toHaveBeenCalledTimes(1);
      const [listDays, , probeAddrs, probeFrom, probeTo] = boundValues(0) as [string[], string[], string[], string[], string[]];
      expect(listDays).toEqual([]);
      expect(probeAddrs).toEqual([A]);
      expect([probeFrom, probeTo]).toEqual([['2026-11-03T08:00:00.000Z'], ['2026-11-10T08:00:00.000Z']]);
    });
  });
});
