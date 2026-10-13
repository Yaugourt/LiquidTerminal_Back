/**
 * HLP TVL poller: every tick reads Hyperliquid and rewrites `vault:hlp:tvl`
 * under a safety TTL. It used to read its own key first, so after the first
 * write it never called Hyperliquid again and the TVL stayed frozen.
 * - each 30 s poll replaces the value readers (perp globalstats, metrics) see;
 * - a failed poll keeps the previous value until the safety TTL, never 0;
 * - the key carries a TTL, so a stopped poller cannot serve it forever.
 */
const mockRedis = {
  store: new Map<string, string>(),
  ttls: new Map<string, number | undefined>(),
  get: jest.fn(async (key: string) => mockRedis.store.get(key) ?? null),
  set: jest.fn(async (key: string, value: string, ttl?: number) => {
    mockRedis.store.set(key, value);
    mockRedis.ttls.set(key, ttl);
  }),
  publish: jest.fn(async () => undefined),
  subscribe: jest.fn(async () => undefined),
};

jest.mock('../../../src/core/redis.service', () => ({ redisService: mockRedis }));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { HyperliquidVaultClient } from '../../../src/clients/hyperliquid/vault/hlpvault.client';
import { PerpGlobalStatsService } from '../../../src/services/perp/perpStats.service';
import type { VaultDetails } from '../../../src/types/vault.types';

const KEY = 'vault:hlp:tvl';

/** A vaultDetails answer whose day history ends on `tvl`. */
const details = (tvl: string): VaultDetails =>
  ({
    portfolio: [
      ['day', { accountValueHistory: [[1_000, '1.0'], [3_000, tvl], [2_000, '2.0']], pnlHistory: [], vlm: '0' }],
    ],
  }) as unknown as VaultDetails;

describe('HyperliquidVaultClient HLP TVL poller', () => {
  const client = HyperliquidVaultClient.getInstance();
  let upstream: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    mockRedis.store.clear();
    mockRedis.ttls.clear();
    mockRedis.publish.mockClear();
    upstream = jest.spyOn(client, 'getVaultDetailsRaw');
  });

  afterEach(() => {
    client.stopPolling();
    upstream.mockRestore();
    jest.useRealTimers();
  });

  it('reads Hyperliquid on every poll, so readers see a value at most one poll old', async () => {
    mockRedis.store.set('perp:markets', JSON.stringify([{ volume: 1, openInterest: 2, price: 3 }]));
    upstream.mockResolvedValueOnce(details('400000000.5')).mockResolvedValueOnce(details('412345678.25'));

    client.startPolling();
    await jest.advanceTimersByTimeAsync(0);
    expect(mockRedis.store.get(KEY)).toBe('400000000.5');
    expect(mockRedis.ttls.get(KEY)).toBe(300);
    expect((await PerpGlobalStatsService.getInstance().getPerpGlobalStats()).hlpTvl).toBe(400000000.5);

    // One poll later (30 s ± 10 % jitter) the value has been replaced.
    await jest.advanceTimersByTimeAsync(33_000);
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(mockRedis.store.get(KEY)).toBe('412345678.25');
    expect(mockRedis.ttls.get(KEY)).toBe(300);
    expect((await PerpGlobalStatsService.getInstance().getPerpGlobalStats()).hlpTvl).toBe(412345678.25);
    expect(mockRedis.publish).toHaveBeenCalledTimes(2);
  });

  it('keeps the previous value when a poll fails or has no day history', async () => {
    upstream
      .mockResolvedValueOnce(details('400000000'))
      .mockRejectedValueOnce(new Error('HL 502'))
      .mockResolvedValueOnce({ portfolio: [] } as unknown as VaultDetails);

    client.startPolling();
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(33_000);
    await jest.advanceTimersByTimeAsync(33_000);

    expect(upstream).toHaveBeenCalledTimes(3);
    expect(mockRedis.store.get(KEY)).toBe('400000000');
    // Only the successful poll told readers about an update.
    expect(mockRedis.publish).toHaveBeenCalledTimes(1);
  });

  it('getHlpTvl serves the stored value and reads Hyperliquid only when it is missing', async () => {
    upstream.mockResolvedValue(details('401000000'));

    await expect(client.getHlpTvl()).resolves.toBe(401000000);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(mockRedis.ttls.get(KEY)).toBe(300);

    await expect(client.getHlpTvl()).resolves.toBe(401000000);
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});
