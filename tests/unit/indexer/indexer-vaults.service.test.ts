/**
 * Vault reads are shared through Redis: one upstream call per distinct set of
 * params, whatever the number of visitors, and the leaderboard fan-out reads
 * the same entries instead of calling HypeDexer per vault on every recompute.
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

const mockClient = {
  getVaultSummaries: jest.fn(),
  getVaultDetails: jest.fn(),
  getDailySnapshots: jest.fn(),
  getEquitySnapshots: jest.fn(),
  getVaultLedger: jest.fn(),
  getUserVaultEquities: jest.fn(),
};

jest.mock('../../../src/clients/hypedexer/rest/vaults/vaults-indexer.client', () => ({
  HypeDexerVaultsIndexerClient: { getInstance: () => mockClient },
}));

import { IndexerVaultsIndexerService } from '../../../src/services/indexer/indexer-vaults-indexer.service';
import { HYPEDEXER_TTL } from '../../../src/constants/hypedexer.cache';

const HLP = '0xdfc24b077bc1425ad1dea75bcb6f8158e10df303';
const HLP_CHECKSUMMED = '0xdfC24b077bc1425AD1DEA75bCB6f8158E10Df303';

function ttlOf(prefix: string): number | undefined {
  const key = [...mockRedis.ttls.keys()].find((k) => k.startsWith(prefix));
  return key ? mockRedis.ttls.get(key) : undefined;
}

describe('IndexerVaultsIndexerService caching', () => {
  let svc: IndexerVaultsIndexerService;

  beforeEach(() => {
    mockRedis.store.clear();
    mockRedis.ttls.clear();
    Object.values(mockClient).forEach((fn) => fn.mockReset());
    (IndexerVaultsIndexerService as unknown as { instance?: IndexerVaultsIndexerService }).instance = undefined;
    svc = IndexerVaultsIndexerService.getInstance();
  });

  it('serves repeated vault summaries from one upstream call per param set', async () => {
    mockClient.getVaultSummaries.mockResolvedValue([{ vaultAddress: HLP }]);

    for (let i = 0; i < 5; i++) {
      await svc.getVaultSummaries({ includeClosed: true, limit: 5000 });
    }
    await svc.getVaultSummaries({ includeClosed: true, limit: 100 });
    await svc.getVaultSummaries({ includeClosed: false });

    expect(mockClient.getVaultSummaries).toHaveBeenCalledTimes(3);
    expect(mockClient.getVaultSummaries).toHaveBeenCalledWith({ includeClosed: true, limit: 5000 });
    expect(ttlOf('hypedexer:vaults:vaultSummaries')).toBe(HYPEDEXER_TTL.vaultSummaries);
  });

  it('treats a checksummed vault address as the same vault, and asks upstream in lowercase', async () => {
    mockClient.getVaultDetails.mockResolvedValue({ vaultAddress: HLP, name: 'HLP' });

    const a = await svc.getVaultDetails({ vaultAddress: HLP });
    const b = await svc.getVaultDetails({ vaultAddress: HLP_CHECKSUMMED });

    expect(b).toEqual(a);
    expect(mockClient.getVaultDetails).toHaveBeenCalledTimes(1);
    expect(mockClient.getVaultDetails).toHaveBeenCalledWith({ vaultAddress: HLP });
  });

  it('keys snapshots on every param', async () => {
    mockClient.getEquitySnapshots.mockResolvedValue([{ time: 1 }]);
    mockClient.getDailySnapshots.mockResolvedValue([{ time: 1 }]);

    await svc.getEquitySnapshots({ vaultAddress: HLP, limit: 500 });
    await svc.getEquitySnapshots({ vaultAddress: HLP, limit: 500 });
    await svc.getEquitySnapshots({ vaultAddress: HLP, limit: 500, startTime: '2026-09-01' });
    await svc.getDailySnapshots({ vaultAddress: HLP, limit: 60 });
    await svc.getDailySnapshots({ vaultAddress: HLP, limit: 3 });

    expect(mockClient.getEquitySnapshots).toHaveBeenCalledTimes(2);
    expect(mockClient.getDailySnapshots).toHaveBeenCalledTimes(2);
    expect(ttlOf('hypedexer:vaults:equitySnapshots')).toBe(HYPEDEXER_TTL.vaultEquitySnapshots);
    expect(ttlOf('hypedexer:vaults:dailySnapshots')).toBe(HYPEDEXER_TTL.vaultDailySnapshots);
  });

  it('keeps an empty ledger for an hour and a populated one for a minute', async () => {
    const other = '0x1111111111111111111111111111111111111111';
    mockClient.getVaultLedger.mockImplementation(async ({ vaultAddress }: { vaultAddress: string }) =>
      vaultAddress === HLP ? [] : [{ time: 1, userFrom: other, userTo: HLP, amount: 5 }]
    );

    await svc.getVaultLedger({ vaultAddress: HLP, limit: 2000 });
    await svc.getVaultLedger({ vaultAddress: other, limit: 2000 });

    // Without the last copies cacheService keeps beside each entry.
    const ttls = [...mockRedis.ttls.entries()].filter(
      ([k]) => k.startsWith('hypedexer:vaults:vaultLedger') && !k.endsWith(':last')
    );
    expect(ttls).toHaveLength(2);
    expect(ttls.find(([k]) => k.includes(HLP))?.[1]).toBe(HYPEDEXER_TTL.vaultLedgerEmpty);
    expect(ttls.find(([k]) => k.includes(other))?.[1]).toBe(HYPEDEXER_TTL.vaultLedger);
  });

  it('recomputes the leaderboards from the shared per-vault entries', async () => {
    const vaults = Array.from({ length: 3 }, (_, i) => ({
      vaultAddress: `0x${String(i).repeat(40)}`,
      name: `v${i}`,
      leader: '0xleader',
      leaderCommission: 0.1,
      isClosed: false,
      followerCount: 10 + i,
      snapshotTime: 0,
      createTime: 0,
    }));
    mockClient.getVaultSummaries.mockResolvedValue(vaults);
    mockClient.getDailySnapshots.mockResolvedValue([
      { time: 2, accountValue: 100, followerCount: 12 },
      { time: 1, accountValue: 90, followerCount: 10 },
    ]);
    mockClient.getVaultLedger.mockResolvedValue([]);

    const first = await svc.getFollowersGained('24h', 5);
    expect(first.data).toHaveLength(3);
    expect(first.data[0].delta).toBe(2);
    expect(mockClient.getDailySnapshots).toHaveBeenCalledTimes(3);
    expect(mockClient.getVaultLedger).toHaveBeenCalledTimes(3);

    // The 5-min payload expires; the recompute reads the per-vault entries.
    for (const key of [...mockRedis.store.keys()]) {
      if (key.startsWith('hypedexer:vaults:leaderboards')) mockRedis.store.delete(key);
    }
    const second = await svc.getFollowersGained('24h', 5);
    expect(second.data).toEqual(first.data);
    expect(mockClient.getVaultSummaries).toHaveBeenCalledTimes(1);
    expect(mockClient.getDailySnapshots).toHaveBeenCalledTimes(3);
    expect(mockClient.getVaultLedger).toHaveBeenCalledTimes(3);
  });

  it('still builds the leaderboard when one vault read fails', async () => {
    mockClient.getVaultSummaries.mockResolvedValue([
      { vaultAddress: HLP, name: 'HLP', leader: '0xl', leaderCommission: 0, isClosed: false, followerCount: 5, snapshotTime: 0, createTime: 0 },
    ]);
    mockClient.getDailySnapshots.mockRejectedValue(new Error('upstream 500'));
    mockClient.getVaultLedger.mockResolvedValue([]);

    const out = await svc.getOutflows('7d', 3);
    expect(out.data).toEqual([]);
    expect(out.meta.sampleSize).toBe(1);
  });
});
