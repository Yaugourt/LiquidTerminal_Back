/**
 * Which Elysium views the scheduler is handed, and at what cadence: the ones
 * the pages open on are kept warm, the other lengths a route accepts are
 * computed only while asked, and a request reads a view without computing it.
 */
const registered: Array<{ key: string; cadence: { activeS: number; idleS: number; heavy?: boolean } }> = [];
const read = jest.fn(async (def: { key: string }) => ({ data: { of: def.key }, computedAt: 'x', refreshEveryS: 1 }));
jest.mock('../../../src/core/viewScheduler', () => {
  const actual = jest.requireActual('../../../src/core/viewScheduler');
  return {
    ...actual,
    viewScheduler: {
      register: (def: { key: string; cadence: { activeS: number; idleS: number; heavy?: boolean } }) => registered.push(def),
      read,
      watch: jest.fn(),
      readOrCompute: jest.fn(),
      describe: () => [{ view: 'elysium:analytics:status:v5', lastDurationMs: 12, watched: true, running: false }],
    },
  };
});
jest.mock('../../../src/core/redis.service', () => ({ redisService: { isHealthy: () => true, get: jest.fn(), set: jest.fn() } }));
jest.mock('../../../src/core/prisma.historical.service', () => ({
  prismaHistorical: {},
  prismaHistoricalRead: {},
  prismaHistoricalPages: {},
  prismaHistoricalAggregate: {},
}));
jest.mock('../../../src/core/cache.service', () => ({ cacheService: { getOrSet: jest.fn() } }));
jest.mock('../../../src/repositories/prisma/prisma.elysium.repository', () => ({
  ELYSIUM_STATE_MARKERS: new Set<string>(),
  ElysiumIngestRepository: { getInstance: () => ({ listStates: jest.fn().mockResolvedValue([]) }) },
}));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { ElysiumAnalyticsService } from '../../../src/services/elysium/elysium-analytics.service';
import { ElysiumEcosystemService } from '../../../src/services/elysium/elysium-ecosystem.service';

const cadenceOf = (key: string) => registered.find((d) => d.key === key)?.cadence;

describe('Elysium scheduled views', () => {
  beforeEach(() => {
    registered.length = 0;
    read.mockClear();
  });

  it('keeps warm every view the pages open on, each at the period its cost allows', () => {
    ElysiumAnalyticsService.getInstance().registerDefaults();
    ElysiumEcosystemService.getInstance().registerDefaults();
    const day = { activeS: 60, idleS: 600 };
    const week = { activeS: 300, idleS: 1800, heavy: true };
    expect(Object.fromEntries(registered.map((d) => [d.key, d.cadence]))).toEqual({
      'elysium:analytics:status:v5': { activeS: 15, idleS: 60, cheap: true },
      'elysium:analytics:deployments:d14': day,
      'elysium:analytics:users:d14': day,
      'elysium:analytics:bridge:d14': day,
      'elysium:analytics:economics:d14': day,
      'elysium:analytics:dex:d14': day,
      'elysium:analytics:tokens:d14': day,
      'elysium:analytics:contracts:24h': day,
      'elysium:analytics:methods:24h': day,
      'elysium:analytics:fees:24h': day,
      'elysium:analytics:network-txs-24h:v1': day,
      'elysium:analytics:contracts:7d': week,
      'elysium:analytics:methods:7d': week,
      'elysium:analytics:fees:7d': week,
      'elysium:analytics:fees:30d': { activeS: 1800, idleS: 3600, heavy: true },
      'elysium:ecosystem:projects:v5': { activeS: 120, idleS: 1800, heavy: true },
      'elysium:ecosystem:alltime:v1': { activeS: 600, idleS: 3600, heavy: true },
    });
    // Every one of them is kept warm, and nothing was computed or read to say so.
    expect(registered.every((d) => d.cadence.idleS > 0)).toBe(true);
    expect(read).not.toHaveBeenCalled();
  });

  it('reads a view through the scheduler under the key it was stored under before, and computes nothing itself', async () => {
    const service = ElysiumAnalyticsService.getInstance();
    const out = await service.getFees('7d');
    expect(out).toMatchObject({ data: { of: 'elysium:analytics:fees:7d' } });
    await service.getContracts('24h');
    await service.getEconomics(14);
    expect(read.mock.calls.map(([def]) => def.key)).toEqual([
      'elysium:analytics:fees:7d',
      'elysium:analytics:contracts:24h',
      'elysium:analytics:economics:d14',
    ]);
  });

  it('computes the other lengths of a daily series only while they are asked for, the long ones as heavy views', async () => {
    const service = ElysiumAnalyticsService.getInstance();
    await service.getUsers(7);
    await service.getUsers(30);
    await service.getDex(60);
    const cadences = Object.fromEntries(read.mock.calls.map(([def]) => [def.key, (def as unknown as { cadence: unknown }).cadence]));
    expect(cadences).toEqual({
      'elysium:analytics:users:d7': { activeS: 60, idleS: 0 },
      'elysium:analytics:users:d30': { activeS: 300, idleS: 0, heavy: true },
      'elysium:analytics:dex:d60': { activeS: 300, idleS: 0, heavy: true },
    });
    expect(cadenceOf('elysium:analytics:users:d7')).toBeUndefined();
  });

  it('adds where the views stand to the status, read as the request comes', async () => {
    const status = await ElysiumAnalyticsService.getInstance().getStatus();
    expect(status.data).toMatchObject({ of: 'elysium:analytics:status:v5', views: [{ view: 'elysium:analytics:status:v5' }] });
  });

  it('the public status says whether the data is fresh and complete, and nothing of how the service is run', async () => {
    const full = {
      partial: [],
      streams: [{ stream: 'tx', cursor: '2026-11-11T17:59:40.000Z', rows: 52_205_824, backfillDone: true, lastError: null, lagSeconds: 20, everyS: 30, lastOkAt: '2026-11-11T17:59:50.000Z', state: 'ok' }],
      rollups: { builtDays: 61, waitingDays: 0, lastBuiltAt: '2026-11-11T00:12:00.000Z', keepDays: 63, sizeBytes: 4e9, txTableBytes: 30e9, lastError: null },
      rejects: [],
      completeness: { differing: 0, days: [] },
      provider: { headAt: '2026-11-11T17:59:50.000Z', lagSeconds: 10 },
      upkeep: [],
      credits: { balance: 5, days: [] },
      database: { bytes: 1, usedShare: 0.5 },
    };
    read.mockResolvedValueOnce({ data: full as never, computedAt: '2026-11-11T18:00:00.000Z', refreshEveryS: 15 });
    const open = await ElysiumAnalyticsService.getInstance().getPublicStatus();
    expect(open.data).toEqual({
      partial: [],
      streams: [{ stream: 'tx', backfillDone: true, lastError: null, lagSeconds: 20, everyS: 30, lastOkAt: '2026-11-11T17:59:50.000Z', state: 'ok' }],
      rollups: { builtDays: 61, waitingDays: 0, lastBuiltAt: '2026-11-11T00:12:00.000Z', lastError: null },
      rejects: [],
      completeness: { differing: 0, days: [] },
      provider: { headAt: '2026-11-11T17:59:50.000Z', lagSeconds: 10 },
      upkeep: [],
      views: [{ view: 'elysium:analytics:status:v5' }],
    });
    // Neither the spend, nor a size, nor a position, nor a count of rows, nor a duration.
    expect(JSON.stringify(open.data)).not.toMatch(/credits|balance|database|Bytes|cursor|"rows"|lastDurationMs|keepDays/);
    expect(open.computedAt).toBe('2026-11-11T18:00:00.000Z');
    expect(open.refreshEveryS).toBe(15);
  });

  it('the full status keeps all of it, for the admin route and the alerts', async () => {
    const full = { partial: [], streams: [{ stream: 'tx', cursor: 'c', rows: 1 }], rollups: { sizeBytes: 4e9 }, credits: { balance: 5 }, database: { bytes: 1 } };
    read.mockResolvedValueOnce({ data: full as never, computedAt: 'x', refreshEveryS: 15 });
    const status = await ElysiumAnalyticsService.getInstance().getStatus();
    expect(status.data).toMatchObject(full);
  });
});
