import { IndexerElysiumService } from '../../../src/services/indexer/indexer-elysium.service';
import { cacheService } from '../../../src/core/cache.service';
import { HypeDexerElysiumIndexerClient } from '../../../src/clients/hypedexer/rest/elysium/elysium-indexer.client';
import { HYPEDEXER_TTL } from '../../../src/constants/hypedexer.cache';

jest.mock('../../../src/core/cache.service', () => ({
  cacheService: { getOrSet: jest.fn() },
}));

jest.mock('../../../src/clients/hypedexer/rest/elysium/elysium-indexer.client', () => ({
  HypeDexerElysiumIndexerClient: { getInstance: jest.fn() },
}));

describe('IndexerElysiumService cache keys', () => {
  const client = {
    getStats: jest.fn().mockResolvedValue({ ok: 1 }),
    getBridgeTransfers: jest.fn().mockResolvedValue([]),
    getBridgeReserves: jest.fn().mockResolvedValue([]),
    getTransactions: jest.fn().mockResolvedValue([]),
  };
  const getOrSet = cacheService.getOrSet as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    (IndexerElysiumService as unknown as { instance?: IndexerElysiumService }).instance = undefined;
    (HypeDexerElysiumIndexerClient.getInstance as jest.Mock).mockReturnValue(client);
    getOrSet.mockImplementation((_key: string, fetcher: () => Promise<unknown>) => fetcher());
  });

  const keyOf = (call: number): string => getOrSet.mock.calls[call][0] as string;

  it('uses a fixed key and the configured TTL for /stats', async () => {
    await IndexerElysiumService.getInstance().getStats();
    expect(keyOf(0)).toBe('hypedexer:elysium:stats');
    expect(getOrSet.mock.calls[0][2]).toBe(HYPEDEXER_TTL.elysiumStats);
  });

  it('never caches filtered and unfiltered calls under the same key', async () => {
    const svc = IndexerElysiumService.getInstance();
    await svc.getBridgeTransfers({});
    await svc.getBridgeTransfers({ direction: 'deposit' });
    await svc.getBridgeTransfers({ direction: 'withdrawal' });
    await svc.getBridgeTransfers({ direction: 'deposit', limit: 5 });
    const keys = [0, 1, 2, 3].map(keyOf);
    expect(new Set(keys).size).toBe(4);
    expect(keys[1]).toContain('"direction":"deposit"');
  });

  it('builds the same key regardless of param order', async () => {
    const svc = IndexerElysiumService.getInstance();
    await svc.getBridgeTransfers({ direction: 'deposit', limit: 5 });
    await svc.getBridgeTransfers({ limit: 5, direction: 'deposit' });
    expect(keyOf(0)).toBe(keyOf(1));
  });

  it('includes route and boolean flags in the reserves / transactions keys', async () => {
    const svc = IndexerElysiumService.getInstance();
    await svc.getBridgeReserves({ route: 'native' });
    await svc.getBridgeReserves({ route: 'mirror' });
    await svc.getBridgeReserves({ route: 'native', only_unbacked: true });
    await svc.getTransactions({ include_spam: false });
    await svc.getTransactions({ include_spam: true });
    const keys = [0, 1, 2, 3, 4].map(keyOf);
    expect(new Set(keys).size).toBe(5);
    expect(client.getBridgeReserves).toHaveBeenCalledWith({ route: 'native', only_unbacked: true });
  });

  it('shares one entry between no network and network=testnet, and keeps mainnet apart', async () => {
    const svc = IndexerElysiumService.getInstance();
    await svc.getStats();
    await svc.getStats({ network: 'testnet' });
    await svc.getStats({ network: 'mainnet' });
    await svc.getBridgeTransfers({ limit: 5 });
    await svc.getBridgeTransfers({ limit: 5, network: 'testnet' });
    await svc.getBridgeTransfers({ limit: 5, network: 'mainnet' });
    expect(keyOf(0)).toBe('hypedexer:elysium:stats');
    expect(keyOf(1)).toBe(keyOf(0));
    expect(keyOf(2)).toBe('hypedexer:elysium:stats:{"network":"mainnet"}');
    expect(keyOf(4)).toBe(keyOf(3));
    expect(keyOf(5)).not.toBe(keyOf(3));
    // The client still gets the network it was asked for: it picks the upstream path.
    expect(client.getStats).toHaveBeenNthCalledWith(2, { network: 'testnet' });
    expect(client.getStats).toHaveBeenNthCalledWith(3, { network: 'mainnet' });
  });

  describe('per-address lookups', () => {
    const address = (n: number): string => '0x' + n.toString(16).padStart(40, '0');
    const lookups = { getUserBalances: jest.fn().mockResolvedValue({ balances: [] }) };
    let caller: { ipKey: string; open: boolean; exhausted: boolean; retryAfterS: number } | undefined;

    beforeEach(() => {
      jest.resetModules();
      jest.doMock('../../../src/utils/request-context', () => ({ currentUpstreamCaller: () => caller }));
      // Loaded again for each case: without these, each load would open a Redis connection and log it.
      jest.doMock('../../../src/core/redis.service', () => ({ redisService: {} }));
      jest.doMock('../../../src/utils/logDeduplicator', () => ({
        logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      }));
      jest.doMock('../../../src/core/cache.service', () => ({
        cacheService: { getOrSet: (_key: string, fetcher: () => Promise<unknown>) => fetcher() },
      }));
      jest.doMock('../../../src/clients/hypedexer/rest/elysium/elysium-indexer.client', () => ({
        HypeDexerElysiumIndexerClient: { getInstance: () => lookups },
      }));
      lookups.getUserBalances.mockClear();
      jest.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    });
    afterEach(() => {
      jest.restoreAllMocks();
      const { RateLimiterService } = require('../../../src/core/hyperLiquid.ratelimiter.service');
      RateLimiterService.destroyAll();
    });

    const fresh = (): IndexerElysiumService =>
      (require('../../../src/services/indexer/indexer-elysium.service') as typeof import('../../../src/services/indexer/indexer-elysium.service')).IndexerElysiumService.getInstance();
    const as = (ipKey: string): void => {
      caller = { ipKey, open: true, exhausted: false, retryAfterS: 0 };
    };

    it('gives one client a quarter of the common budget, and tells it when to come back', async () => {
      const svc = fresh();
      as('198.51.100.1');
      for (let i = 0; i < 60; i++) await svc.getUserBalances(address(i));
      const refused = await svc.getUserBalances(address(60)).catch((e: Error) => e);
      expect(refused).toMatchObject({ name: 'UpstreamBudgetExceededError', statusCode: 429, callerRefusal: true, retryAfterS: 60 });
      expect(lookups.getUserBalances).toHaveBeenCalledTimes(60);

      // The others are not touched: the common budget still has 180 calls for them.
      for (const ip of ['198.51.100.2', '198.51.100.3', '198.51.100.4']) {
        as(ip);
        for (let i = 0; i < 60; i++) await svc.getUserBalances(address(1000 + i));
      }
      expect(lookups.getUserBalances).toHaveBeenCalledTimes(240);
      // Only now is the common budget spent, for everyone, as before.
      as('198.51.100.5');
      await expect(svc.getUserBalances(address(5000))).rejects.toThrow('Elysium per-address lookup budget exhausted');

      // Next minute: the first client has its share again.
      (Date.now as jest.Mock).mockReturnValue(1_800_000_000_000 + 60_000);
      as('198.51.100.1');
      await expect(svc.getUserBalances(address(61))).resolves.toEqual({ balances: [] });
    });

    it('counts a call made for nobody against the common budget only', async () => {
      const svc = fresh();
      caller = undefined;
      for (let i = 0; i < 100; i++) await svc.getUserBalances(address(i));
      expect(lookups.getUserBalances).toHaveBeenCalledTimes(100);
    });
  });
});

