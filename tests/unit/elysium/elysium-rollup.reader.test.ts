/**
 * Day rollups, read side: which days count as built, and what the distinct
 * callers read asks elysium_tx for (one explicit range per target, never a
 * target's whole history).
 */
const queryRaw = jest.fn();
jest.mock('../../../src/core/prisma.historical.service', () => ({ prismaHistoricalRead: { $queryRaw: queryRaw } }));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { Prisma } from '../../../prisma-historical/generated/client';
import { distinctCallers, rawRanges, readRollupCoverage, rollupDays } from '../../../src/services/elysium/elysium-rollup.reader';
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
  beforeEach(() => queryRaw.mockReset());
  afterEach(() => {
    delete process.env.ELYSIUM_ROLLUPS_ENABLED;
  });

  describe('readRollupCoverage', () => {
    const now = at('2026-11-10T08:00:00Z');

    it('maps the built days and asks for the kept span only', async () => {
      queryRaw.mockResolvedValue([
        { day: '2026-11-08', callers_built: true, senders_built: false },
        { day: '2026-11-09', callers_built: true, senders_built: true },
      ]);
      const coverage = await readRollupCoverage(now);
      expect([...coverage]).toEqual([
        ['2026-11-08', { callers: true, senders: false }],
        ['2026-11-09', { callers: true, senders: true }],
      ]);
      expect(boundValues(0)).toEqual(['2026-09-08']);
    });

    it('answers "nothing built" when the table cannot be read: the windows then read the raw table', async () => {
      queryRaw.mockRejectedValue(new Error('relation "elysium_day_rollup" does not exist'));
      await expect(readRollupCoverage(now)).resolves.toEqual(new Map());
    });

    it('answers "nothing built" without a query when the rollups are switched off', async () => {
      process.env.ELYSIUM_ROLLUPS_ENABLED = 'false';
      await expect(readRollupCoverage(now)).resolves.toEqual(new Map());
      expect(queryRaw).not.toHaveBeenCalled();
    });
  });

  describe('SQL pieces', () => {
    it('writes the raw ranges as an OR of half-open intervals, bound as ISO text', () => {
      const sql = rawRanges(Prisma.sql`t.block_time`, {
        days: [],
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
      expect(rawRanges(Prisma.sql`t.block_time`, { days: ['2026-11-09'], raw: [] }).sql).toBe('FALSE');
    });

    it('binds the rollup days as one array', () => {
      const sql = rollupDays({ days: ['2026-11-08', '2026-11-09'], raw: [] });
      expect(sql.sql).toBe('?::text[]::date[]');
      expect(sql.values).toEqual([['2026-11-08', '2026-11-09']]);
    });
  });

  describe('distinctCallers', () => {
    const start = at('2026-11-03T08:00:00.000Z');
    const end = at('2026-11-10T08:00:00.000Z');
    const coverage = new Map(['2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09'].map((d) => [d, full]));

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

    it('reads the whole window from elysium_tx when no day has its caller lists', async () => {
      queryRaw.mockResolvedValueOnce([{ address: A, callers: 5 }]);
      const noLists = new Map([...coverage].map(([d]) => [d, { callers: false, senders: true }]));

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
