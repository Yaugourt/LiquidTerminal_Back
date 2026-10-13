/**
 * Hypurrscan's pastAuctionsPerp, deploys and globalAliases are served from one
 * shared cache entry each, read on demand:
 * - a miss fetches once and stores the feed as sent, with a TTL per feed and a
 *   day-long last copy; any number of readers within the TTL cost no fetch;
 * - when Hypurrscan fails the last copy is served, and with none the read
 *   fails with HypurrscanFeedUnavailableError (the routes answer 503);
 * - an answer of the wrong shape (empty list, HTML, a list for the aliases
 *   object) is never stored, and never replaces a good copy.
 */
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockRedis = {
  store: new Map<string, string>(),
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
    mockRedis.expiries.delete(key);
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

import { HYPURRSCAN_CACHE_KEYS } from '../../../src/constants/hypurrscan.cache';

const AUCTIONS = [
  { time: 1761409374051, deployer: '0x888', name: 'GOLD', deployGas: '500' },
  {
    time: 1791278192765,
    user: '0x8888888c43cbb7e1c4132542e46831bffd866ed3',
    action: {
      type: 'perpDeploy',
      registerAsset: {
        maxGas: null,
        assetRequest: { coin: 'para:SMH', szDecimals: 3, oraclePx: '634', marginTableId: 10, onlyIsolated: true },
        dex: 'para',
        schema: null,
      },
    },
    block: 1173674198,
    hash: '0x1ed2',
    error: null,
    gasUsed: -571.8561851,
  },
];
const DEPLOYS = [
  {
    time: 1791878560594,
    user: '0x03ad',
    action: { type: 'spotDeploy', setDeployerLabel: { label: 'rrc' } },
    block: 1182067406,
    hash: '0xd976',
    error: null,
  },
];
const ALIASES = { '0xffffffffffffffffffffffffffffffffffffffff': 'HIP-2', '0x0000000000000000000000000000000000000000': 'Burn Address' };

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Feed = 'pastAuctionsPerp' | 'deploys' | 'globalAliases';

const FEEDS: ReadonlyArray<{ feed: Feed; method: 'getPastAuctionsPerp' | 'getDeploys' | 'getGlobalAliases'; body: unknown; bad: unknown[]; ttl: number }> = [
  { feed: 'pastAuctionsPerp', method: 'getPastAuctionsPerp', body: AUCTIONS, bad: [[], {}, 'oops', [1, 2], null], ttl: 60 },
  { feed: 'deploys', method: 'getDeploys', body: DEPLOYS, bad: [[], { error: 'x' }, 'oops', ['a'], null], ttl: 15 },
  { feed: 'globalAliases', method: 'getGlobalAliases', body: ALIASES, bad: [{}, [], [ALIASES], 'oops', null], ttl: 300 },
];

describe('HypurrscanFeedsService', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;
  let now: number;
  let service: import('../../../src/services/hypurrscan/hypurrscanFeeds.service').HypurrscanFeedsService;
  let Unavailable: typeof import('../../../src/services/hypurrscan/hypurrscanFeeds.service').HypurrscanFeedUnavailableError;

  /** Lets a background refresh settle. */
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));
  const bodyOf = (feed: Feed) => FEEDS.find((f) => f.feed === feed)!.body;

  beforeEach(() => {
    jest.resetModules();
    for (const m of [mockRedis.store, mockRedis.expiries, mockRedis.ttls, mockRedis.locks]) m.clear();
    now = 1_800_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    fetchMock = jest.fn(async (url: unknown) => json(bodyOf(String(url).split('/').pop() as Feed)));
    global.fetch = fetchMock as unknown as typeof fetch;
    const mod = require('../../../src/services/hypurrscan/hypurrscanFeeds.service');
    service = mod.HypurrscanFeedsService.getInstance();
    Unavailable = mod.HypurrscanFeedUnavailableError;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    global.fetch = realFetch;
  });

  describe.each(FEEDS)('$feed', ({ feed, method, body, bad, ttl }) => {
    const key = HYPURRSCAN_CACHE_KEYS[feed];

    it('fetches on a miss, stores the feed as sent, then serves it without a fetch', async () => {
      await expect(service[method]()).resolves.toEqual(body);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0][0])).toBe(`https://api.hypurrscan.io/${feed}`);
      expect(JSON.parse(mockRedis.store.get(key)!)).toEqual(body);

      const readers = await Promise.all(Array.from({ length: 5 }, () => service[method]()));
      for (const read of readers) expect(read).toEqual(body);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it(`keeps it ${ttl} s, with a copy kept a day`, async () => {
      await service[method]();
      expect(mockRedis.ttls.get(key)).toBe(ttl);
      expect(mockRedis.ttls.get(`${key}:last`)).toBe(86_400);
    });

    it('shares one fetch between concurrent readers of a cold key', async () => {
      await Promise.all(Array.from({ length: 4 }, () => service[method]()));
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('serves the last copy when Hypurrscan fails after the key expired', async () => {
      await service[method]();
      now += (ttl + 1) * 1000;
      fetchMock.mockResolvedValue(new Response('upstream down', { status: 503 }));

      await expect(service[method]()).resolves.toEqual(body);
      await settle();
      expect(fetchMock).toHaveBeenCalledTimes(2); // the refresh was tried once
    });

    it('fails with HypurrscanFeedUnavailableError when Hypurrscan fails and nothing is cached', async () => {
      fetchMock.mockResolvedValue(new Response('upstream down', { status: 503 }));
      await expect(service[method]()).rejects.toBeInstanceOf(Unavailable);
      expect(mockRedis.store.has(key)).toBe(false);
    });

    it.each(bad.map((b) => [JSON.stringify(b), b] as const))('never stores the answer %s', async (_label, answer) => {
      fetchMock.mockResolvedValue(json(answer));
      await expect(service[method]()).rejects.toBeInstanceOf(Unavailable);
      expect(mockRedis.store.has(key)).toBe(false);
      expect(mockRedis.store.has(`${key}:last`)).toBe(false);
    });

    it('keeps serving the good copy when a later answer is the wrong shape', async () => {
      await service[method]();
      now += (ttl + 1) * 1000;
      fetchMock.mockResolvedValue(json(bad[0]));

      await expect(service[method]()).resolves.toEqual(body);
      await settle();
      expect(mockRedis.store.has(key)).toBe(false);
      expect(JSON.parse(mockRedis.store.get(`${key}:last`)!).v).toEqual(body);
    });
  });
});
