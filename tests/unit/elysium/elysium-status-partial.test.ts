/**
 * A part of the status that cannot be read is shown empty and named in `partial`. It used to be
 * shown empty and nothing else: whoever read the status (the alerts) took "the compared days
 * could not be read" for "no day differs", and said that every difference was over.
 */
const mockQueryRaw = jest.fn();
jest.mock('../../../src/core/prisma.historical.service', () => ({
  prismaHistorical: {},
  prismaHistoricalRead: {},
  prismaHistoricalPages: { $queryRaw: (...args: unknown[]) => mockQueryRaw(...args) },
  prismaHistoricalAggregate: {},
}));
jest.mock('../../../src/core/redis.service', () => ({ redisService: { isHealthy: () => true, get: jest.fn(), set: jest.fn(), getClient: () => ({}) } }));
jest.mock('../../../src/core/cache.service', () => ({ cacheService: { getOrSet: jest.fn() } }));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const mockStates = jest.fn();
jest.mock('../../../src/repositories/prisma/prisma.elysium.repository', () => ({
  ELYSIUM_STATE_MARKERS: new Set<string>(['rollup', 'provider']),
  ElysiumIngestRepository: { getInstance: () => ({ listStates: mockStates }) },
}));

import { ElysiumAnalyticsService } from '../../../src/services/elysium/elysium-analytics.service';

type Status = { partial: string[]; rollups: Record<string, unknown>; rejects: unknown[]; completeness: { days: unknown[]; differing: number }; database: Record<string, unknown>; credits: unknown };
const compute = (): Promise<Status> =>
  (ElysiumAnalyticsService.getInstance() as unknown as { statusView: () => { compute: () => Promise<Status> } }).statusView().compute();

describe('the status when a part of it cannot be read', () => {
  const NOW = Date.parse('2026-11-11T18:00:00Z');
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    mockQueryRaw.mockReset();
    mockStates.mockResolvedValue([
      { stream: 'tx', cursor: new Date(NOW - 20_000), rows: 10n, backfillDone: true, lastError: null, updatedAt: new Date(NOW), okAt: new Date(NOW - 20_000) },
    ]);
  });
  afterEach(() => jest.restoreAllMocks());

  /** The four reads of the status, in the order it makes them: built days, sizes, rejects, compared days. */
  const reads = (days: unknown, sizes: unknown, rejects: unknown, checks: unknown): void => {
    for (const value of [days, sizes, rejects, checks]) {
      if (value instanceof Error) mockQueryRaw.mockRejectedValueOnce(value);
      else mockQueryRaw.mockResolvedValueOnce(value);
    }
  };
  const sizes = [{ rollups: 4e9, tx: 30e9, database: 60e9 }];

  it('names nothing when everything was read (the credits apart, without Redis here)', async () => {
    reads([], sizes, [], []);
    const status = await compute();
    expect(status.partial).toEqual(['credits']);
    expect(status.rollups).toMatchObject({ builtDays: 0 });
    expect(typeof status.rollups.waitingDays).toBe('number');
  });

  it('the built days unread: the days waiting are unknown, not "all of them"', async () => {
    reads(new Error('canceling statement due to statement timeout'), sizes, [], []);
    const status = await compute();
    expect(status.partial).toEqual(['rollups', 'credits']);
    expect(status.rollups).toMatchObject({ builtDays: null, waitingDays: null });
    expect(status.database.bytes).toBe(60e9);
  });

  it('the sizes, the rejects and the compared days unread: each is named, and the rest is served', async () => {
    reads([], new Error('timeout'), new Error('timeout'), new Error('timeout'));
    const status = await compute();
    expect(status.partial).toEqual(['database', 'rejects', 'completeness', 'credits']);
    expect(status.database).toMatchObject({ bytes: null, usedShare: null });
    expect(status.rejects).toEqual([]);
    expect(status.completeness).toMatchObject({ days: [], differing: 0 });
  });
});
