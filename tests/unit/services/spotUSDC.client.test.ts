/**
 * Hypurrscan `/spotUSDC` sends the whole daily series as an array, oldest
 * point first. The poller caches it as sent (Redis `spotUSDC:raw_data`, read
 * by the stablecoin stats and `/market/stablecoins/history`), logs the latest
 * point, and keeps the last good series when the payload isn't a non-empty
 * array.
 */
const mockRedis = {
  setIfChanged: jest.fn<Promise<boolean>, [string, string]>(),
  publish: jest.fn<Promise<unknown>, [string, string]>(),
};
const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

jest.mock('../../../src/core/redis.service', () => ({ redisService: mockRedis }));
jest.mock('../../../src/utils/logDeduplicator', () => ({ logDeduplicator: mockLog }));

import { SpotUSDCClient } from '../../../src/clients/hypurrscan/spotUSDC.client';

const SERIES = [
  { lastUpdate: 1791463281, totalSpotUSDC: 2810000000.5, totalSpotUSDT0: 5300000, USDC_holdersCount: 1253000 },
  { lastUpdate: 1791549681, totalSpotUSDC: 2816704682.440874, totalSpotUSDT0: 5325059.449698408, USDC_holdersCount: 1254076 },
];

describe('SpotUSDCClient poll', () => {
  const client = SpotUSDCClient.getInstance();
  const getSpy = jest.spyOn(client, 'get');
  const poll = (): Promise<void> =>
    (client as unknown as { updateSpotUSDCData(): Promise<void> }).updateSpotUSDCData();

  beforeEach(() => {
    jest.clearAllMocks();
    mockRedis.setIfChanged.mockResolvedValue(true);
    mockRedis.publish.mockResolvedValue(1);
  });

  it('caches the series as sent and announces the update', async () => {
    getSpy.mockResolvedValue(SERIES);
    await poll();

    expect(getSpy).toHaveBeenCalledWith('/spotUSDC');
    expect(mockRedis.setIfChanged).toHaveBeenCalledTimes(1);
    const [key, value] = mockRedis.setIfChanged.mock.calls[0];
    expect(key).toBe('spotUSDC:raw_data');
    expect(JSON.parse(value)).toEqual(SERIES);
    expect(mockRedis.publish).toHaveBeenCalledWith('spotUSDC:data:updated', expect.stringContaining('"DATA_UPDATED"'));
  });

  it("logs the latest point's fields", async () => {
    getSpy.mockResolvedValue(SERIES);
    await poll();

    expect(mockLog.info).toHaveBeenCalledWith('SpotUSDC data updated successfully', {
      points: 2,
      lastUpdate: 1791549681,
      totalSpotUSDC: 2816704682.440874,
    });
  });

  it.each([
    ['a single object', SERIES[1], 'object'],
    ['an empty array', [], 'empty array'],
    ['null', null, 'object'],
  ])('keeps the cached series when Hypurrscan sends %s', async (_label, payload, type) => {
    getSpy.mockResolvedValue(payload);
    await poll();

    expect(mockRedis.setIfChanged).not.toHaveBeenCalled();
    expect(mockRedis.publish).not.toHaveBeenCalled();
    expect(mockLog.warn).toHaveBeenCalledWith('SpotUSDC: unexpected payload, cache left as is', { type });
  });

  it('logs a failed read without touching the cache', async () => {
    getSpy.mockRejectedValue(new Error('socket hang up'));
    await poll();

    expect(mockRedis.setIfChanged).not.toHaveBeenCalled();
    expect(mockLog.error).toHaveBeenCalledWith('Failed to update SpotUSDC data:', { error: 'socket hang up' });
  });
});
