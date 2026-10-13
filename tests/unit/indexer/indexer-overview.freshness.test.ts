/**
 * Overview 24h tiles (volume, fees, fills, active traders) are cached once,
 * by IndexerOverviewService, under shared 15 s keys:
 * - any number of concurrent visitors costs one HypeDexer call per tile;
 * - a tile read more than 15 s after its last fetch is fetched again, so its
 *   age is at most ~15 s plus the front poll;
 * - the HypeDexer client no longer caches these itself: it used to write the
 *   same keys for 60 s when it was called directly (metrics snapshot), and
 *   the 15 s tiles then served that value for a minute.
 */
const mockRedis = {
  store: new Map<string, string>(),
  /** Expiry (Date.now() ms) of keys set with a TTL. */
  expiries: new Map<string, number>(),
  ttls: new Map<string, number | undefined>(),
  locks: new Set<string>(),
  isHealthy: jest.fn(() => true),
  get: jest.fn(async (key: string) => {
    const expiry = mockRedis.expiries.get(key);
    if (expiry !== undefined && Date.now() >= expiry) {
      mockRedis.store.delete(key);
      mockRedis.expiries.delete(key);
    }
    return mockRedis.store.get(key) ?? null;
  }),
  set: jest.fn(async (key: string, value: string, ttl?: number) => {
    mockRedis.store.set(key, value);
    mockRedis.ttls.set(key, ttl);
    if (ttl) mockRedis.expiries.set(key, Date.now() + ttl * 1000);
    else mockRedis.expiries.delete(key);
  }),
  delete: jest.fn(async (key: string) => {
    mockRedis.locks.delete(key);
    mockRedis.store.delete(key);
  }),
  getClient: () => ({
    set: async (key: string) => {
      if (mockRedis.locks.has(key)) return null;
      mockRedis.locks.add(key);
      return 'OK';
    },
    exists: async (key: string) => (mockRedis.locks.has(key) ? 1 : 0),
  }),
};

jest.mock('../../../src/core/redis.service', () => ({ redisService: mockRedis }));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { HypeDexerOverviewIndexerClient } from '../../../src/clients/hypedexer/rest/overview/overview-indexer.client';
import { IndexerOverviewService } from '../../../src/services/indexer/indexer-overview.service';
import { HYPEDEXER_CACHE_KEYS, HYPEDEXER_TTL } from '../../../src/constants/hypedexer.cache';

const TILES = [
  { read: (s: IndexerOverviewService) => s.getTradingVolume24h(), key: HYPEDEXER_CACHE_KEYS.overviewTradingVolume24h, path: '/overview/trading-volume-24h' },
  { read: (s: IndexerOverviewService) => s.getTotalFees24h(), key: HYPEDEXER_CACHE_KEYS.overviewTotalFees24h, path: '/overview/total-fees-24h' },
  { read: (s: IndexerOverviewService) => s.getTotalFills24h(), key: HYPEDEXER_CACHE_KEYS.overviewTotalFills24h, path: '/overview/total-fills-24h' },
  { read: (s: IndexerOverviewService) => s.getActiveTraders24h(), key: HYPEDEXER_CACHE_KEYS.overviewActiveTraders24h, path: '/overview/active-traders-24h' },
];

describe('overview 24h tiles freshness', () => {
  const client = HypeDexerOverviewIndexerClient.getInstance();
  const service = IndexerOverviewService.getInstance();
  let now = 1_800_000_000_000;
  let upstream: jest.SpyInstance;
  /** Each upstream call answers a new figure, so a test can tell which fetch it got. */
  let figure = 0;

  beforeEach(() => {
    mockRedis.store.clear();
    mockRedis.expiries.clear();
    mockRedis.ttls.clear();
    mockRedis.locks.clear();
    mockRedis.set.mockClear();
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    figure = 0;
    upstream = jest
      .spyOn(client as unknown as { getUnwrapped: (path: string) => Promise<unknown> }, 'getUnwrapped')
      .mockImplementation(async (path: string) => ({ path, value: ++figure }));
  });

  afterEach(() => jest.restoreAllMocks());

  it('costs one HypeDexer call per tile for any number of concurrent visitors', async () => {
    await Promise.all(Array.from({ length: 25 }, () => Promise.all(TILES.map((t) => t.read(service)))));

    expect(upstream).toHaveBeenCalledTimes(TILES.length);
    for (const tile of TILES) {
      expect(upstream).toHaveBeenCalledWith(tile.path);
      // One shared key per tile, stored for 15 s (no 60 s write underneath).
      expect(mockRedis.ttls.get(tile.key)).toBe(HYPEDEXER_TTL.liveRolling);
      expect(mockRedis.set.mock.calls.filter(([key]) => key === tile.key)).toHaveLength(1);
    }
  });

  it('serves a value at most one TTL old: a read past 15 s gets a new fetch', async () => {
    const first = (await service.getTradingVolume24h()) as { value: number };
    now += 10_000;
    expect(await service.getTradingVolume24h()).toEqual(first);

    now += HYPEDEXER_TTL.liveRolling * 1000 - 10_000 + 1;
    const refreshed = (await service.getTradingVolume24h()) as { value: number };
    expect(refreshed.value).toBeGreaterThan(first.value);
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it('a direct client read (metrics snapshot) never writes the shared tile keys', async () => {
    await client.getActiveTraders24h();
    await client.getTotalFees24h();

    expect(mockRedis.set).not.toHaveBeenCalled();
    // The next visitor still fetches its own 15 s value.
    await service.getActiveTraders24h();
    expect(mockRedis.ttls.get(HYPEDEXER_CACHE_KEYS.overviewActiveTraders24h)).toBe(HYPEDEXER_TTL.liveRolling);
  });
});
