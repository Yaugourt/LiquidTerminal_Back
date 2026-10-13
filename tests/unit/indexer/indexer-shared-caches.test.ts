/**
 * Market-wide passthroughs polled by the front are shared through Redis, one
 * entry per param set: a second visitor with the same params costs no
 * upstream call, a different param never reads another caller's answer.
 */
const mockRedis = {
  store: new Map<string, string>(),
  ttls: new Map<string, number | undefined>(),
  get: jest.fn(async (key: string) => mockRedis.store.get(key) ?? null),
  set: jest.fn(async (key: string, value: string, ttl?: number) => {
    mockRedis.store.set(key, value);
    mockRedis.ttls.set(key, ttl);
  }),
  delete: jest.fn(async (key: string) => {
    mockRedis.store.delete(key);
  }),
  getClient: () => ({ set: async () => 'OK' }),
  isHealthy: () => true,
};

jest.mock('../../../src/core/redis.service', () => ({ redisService: mockRedis }));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

/** Echoes its params so a test can tell which call answered. */
const echo = () => jest.fn(async (...args: unknown[]) => ({ args }));

const builders = { getTopBuilders: echo(), getGlobalStats: echo(), getStatsAllTimeframes: echo() };
const evm = { getEvmBlocks: echo(), getEvmTransactions: echo(), getEvmBridgeEvents: echo(), getEvmLedgerTransfers: echo() };
const completed = { listCompletedTrades: echo(), getSummary: echo(), getTradeFills: echo() };
const hip3 = { getFills: echo(), getSnapshots: echo(), getStatsTraders: echo() };
const twaps = { listTwaps: echo() };
const analytics = { getFillsStats: echo(), getPriorityFeesStats: echo() };
const hip4 = { getAnalytics: echo() };

jest.mock('../../../src/clients/hypedexer/rest/builders/builders-indexer.client', () => ({
  HypeDexerBuildersIndexerClient: { getInstance: () => builders },
}));
jest.mock('../../../src/clients/hypedexer/rest/builders/builders-list-poller.client', () => ({
  HLIndexerBuildersClient: { getInstance: () => ({}) },
}));
jest.mock('../../../src/clients/hypedexer/rest/evm/evm-indexer.client', () => ({
  HypeDexerEvmIndexerClient: { getInstance: () => evm },
}));
jest.mock('../../../src/clients/hypedexer/rest/completed-trades/completed-trades.client', () => ({
  HypeDexerCompletedTradesClient: { getInstance: () => completed },
}));
jest.mock('../../../src/clients/hypedexer/rest/hip3/hip3.client', () => ({
  HypeDexerHip3Client: { getInstance: () => hip3 },
}));
jest.mock('../../../src/clients/hypedexer/rest/twaps/twaps.client', () => ({
  HypeDexerTwapsClient: { getInstance: () => twaps },
}));
jest.mock('../../../src/clients/hypedexer/rest/analytics/analytics-indexer.client', () => ({
  HypeDexerAnalyticsIndexerClient: { getInstance: () => analytics },
}));
jest.mock('../../../src/clients/hypedexer/rest/hip4/hip4.client', () => ({
  HypeDexerHip4Client: { getInstance: () => hip4 },
}));

import { IndexerBuildersIndexerService } from '../../../src/services/indexer/indexer-builders-indexer.service';
import { IndexerEvmService } from '../../../src/services/indexer/indexer-evm.service';
import { IndexerCompletedTradesService } from '../../../src/services/indexer/indexer-completed-trades.service';
import { IndexerHip3Service } from '../../../src/services/indexer/indexer-hip3.service';
import { IndexerTwapsService } from '../../../src/services/indexer/indexer-twaps.service';
import { IndexerAnalyticsService } from '../../../src/services/indexer/indexer-analytics.service';
import { IndexerHip4Service } from '../../../src/services/indexer/indexer-hip4.service';
import { HYPEDEXER_TTL } from '../../../src/constants/hypedexer.cache';

function ttlOf(fragment: string): number | undefined {
  const key = [...mockRedis.ttls.keys()].find((k) => k.includes(fragment));
  return key ? mockRedis.ttls.get(key) : undefined;
}

describe('shared passthrough caches', () => {
  beforeEach(() => {
    mockRedis.store.clear();
    mockRedis.ttls.clear();
    for (const client of [builders, evm, completed, hip3, twaps, analytics, hip4]) {
      Object.values(client).forEach((fn) => fn.mockClear());
    }
  });

  it('caches builders/top for every limit, one entry each', async () => {
    const svc = IndexerBuildersIndexerService.getInstance();
    const a = await svc.getTopBuilders({ timeframe: '24h', sort: 'builder_fees', limit: 5 });
    await svc.getTopBuilders({ timeframe: '24h', sort: 'builder_fees', limit: 5 });
    const b = await svc.getTopBuilders({ timeframe: '24h', sort: 'builder_fees', limit: 100 });
    await svc.getTopBuilders({ timeframe: '24h', sort: 'builder_fees' });
    await svc.getTopBuilders({ timeframe: '24h', sort: 'builder_fees', limit: 25 });

    expect(builders.getTopBuilders).toHaveBeenCalledTimes(3);
    expect(a).not.toEqual(b);
    expect(ttlOf('hypedexer:builders:top:24h:builder_fees:5')).toBe(HYPEDEXER_TTL.buildersTop);
  });

  it('keys EVM bridge events and ledger transfers on their window', async () => {
    const svc = IndexerEvmService.getInstance();
    const first = await svc.getEvmBridgeEvents({ limit: 100, start_time: 1, end_time: 2 });
    const second = await svc.getEvmBridgeEvents({ limit: 100, start_time: 3, end_time: 4 });
    await svc.getEvmBridgeEvents({ limit: 100, start_time: 3, end_time: 4 });
    await svc.getEvmLedgerTransfers({ limit: 10 });
    await svc.getEvmLedgerTransfers({ limit: 20 });

    expect(first).not.toEqual(second);
    expect(evm.getEvmBridgeEvents).toHaveBeenCalledTimes(2);
    expect(evm.getEvmLedgerTransfers).toHaveBeenCalledTimes(2);
  });

  it('shares a page of EVM blocks for 15 s', async () => {
    const svc = IndexerEvmService.getInstance();
    await svc.getEvmBlocks({ limit: 20 });
    await svc.getEvmBlocks({ limit: 20 });
    expect(evm.getEvmBlocks).toHaveBeenCalledTimes(1);
    expect(ttlOf('hypedexer:evm:blocks:')).toBe(HYPEDEXER_TTL.evmBlocksPage);
  });

  it('shares completed-trade lists and summaries per param set', async () => {
    const svc = IndexerCompletedTradesService.getInstance();
    const q = { sort_by: 'pnl_realized', sort_dir: 'DESC', limit: 5 };
    await svc.listCompletedTrades(q);
    await svc.listCompletedTrades({ ...q });
    await svc.listCompletedTrades({ ...q, sort_dir: 'ASC' });
    await svc.getSummary({});
    await svc.getSummary({});

    expect(completed.listCompletedTrades).toHaveBeenCalledTimes(2);
    expect(completed.getSummary).toHaveBeenCalledTimes(1);
    expect(ttlOf('hypedexer:completed-trades:list')).toBe(HYPEDEXER_TTL.marketList);
  });

  it('shares HIP-3 tapes, snapshots and trader stats per market', async () => {
    const svc = IndexerHip3Service.getInstance();
    await svc.getFills({ coin: 'xyz:GOLD', limit: 60, min_notional: 25000 });
    await svc.getFills({ coin: 'xyz:GOLD', limit: 60, min_notional: 25000 });
    await svc.getFills({ coin: 'xyz:GOLD', limit: 200, min_notional: 25000 });
    await svc.getSnapshots({ coin: 'xyz:GOLD' });
    await svc.getSnapshots({ coin: 'xyz:GOLD' });
    await svc.getStatsTraders({ coin: 'xyz:GOLD', limit: 25 });

    expect(hip3.getFills).toHaveBeenCalledTimes(2);
    expect(hip3.getSnapshots).toHaveBeenCalledTimes(1);
    expect(ttlOf('hypedexer:hip3:fills')).toBe(HYPEDEXER_TTL.hip3Fills);
    expect(ttlOf('hypedexer:hip3:snapshots')).toBe(HYPEDEXER_TTL.hip3Snapshots);
    expect(ttlOf('hypedexer:hip3:stats-traders')).toBe(HYPEDEXER_TTL.hip3StatsTraders);
  });

  it('shares TWAP lists and analytics stats', async () => {
    await IndexerTwapsService.getInstance().listTwaps({ limit: 150, hours: 24 });
    await IndexerTwapsService.getInstance().listTwaps({ limit: 150, hours: 24 });
    await IndexerAnalyticsService.getInstance().getFillsStats({ hours: 24 });
    await IndexerAnalyticsService.getInstance().getFillsStats({ hours: 24 });
    await IndexerAnalyticsService.getInstance().getFillsStats({ hours: 168 });

    expect(twaps.listTwaps).toHaveBeenCalledTimes(1);
    expect(analytics.getFillsStats).toHaveBeenCalledTimes(2);
  });

  it('keeps the TWAP source pages (limit 500) 20 s and the flow card list 60 s', async () => {
    const svc = IndexerTwapsService.getInstance();
    await svc.listTwaps({ limit: 150, hours: 24 });
    await svc.listTwaps({ hours: 24, limit: 500, offset: 0 });
    await svc.listTwaps({ hours: 24, limit: 500, offset: 500 });

    expect(twaps.listTwaps).toHaveBeenCalledTimes(3);
    const ttls = [...mockRedis.ttls.entries()].filter(([key]) => key.startsWith('hypedexer:twaps:list'));
    expect(ttls.filter(([key]) => key.includes('"limit":500')).map(([, ttl]) => ttl)).toEqual([
      HYPEDEXER_TTL.twapSourcePages,
      HYPEDEXER_TTL.twapSourcePages,
    ]);
    expect(ttls.find(([key]) => key.includes('"limit":150'))?.[1]).toBe(HYPEDEXER_TTL.marketList);
    expect(HYPEDEXER_TTL.twapSourcePages).toBe(20);
  });

  it('caches HIP-4 analytics per coin chunk for 5 min, and per interval and limit otherwise', async () => {
    const svc = IndexerHip4Service.getInstance();
    await svc.getAnalytics({ coin: '1010,1011', interval: '1d', limit: 2000 });
    await svc.getAnalytics({ coin: '1010,1011', interval: '1d', limit: 2000 });
    await svc.getAnalytics({ coin: '1020,1021', interval: '1d', limit: 2000 });
    await svc.getAnalytics({ interval: '1h', limit: 168 });
    await svc.getAnalytics({ interval: '1h' });

    expect(hip4.getAnalytics).toHaveBeenCalledTimes(4);
    expect(ttlOf('"coin":"1010,1011"')).toBe(HYPEDEXER_TTL.hip4AnalyticsFiltered);
    expect(mockRedis.ttls.get('hypedexer:hip4:analytics:1h:168')).toBe(HYPEDEXER_TTL.hip4Analytics);
    expect(mockRedis.ttls.get('hypedexer:hip4:analytics:1h')).toBe(HYPEDEXER_TTL.hip4Analytics);
  });
});
