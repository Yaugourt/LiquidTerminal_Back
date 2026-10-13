/**
 * Spot pair ids ("@107") resolve to base token names from the spotMeta the
 * spot poller caches in Redis; unknown ids pass through and trigger a reload,
 * at most once a minute — every 5 s while no table could be loaded yet.
 */
const mockRedis = { get: jest.fn<Promise<string | null>, [string]>() };

jest.mock('../../../src/core/redis.service', () => ({ redisService: mockRedis }));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const SPOT_RAW = JSON.stringify([
  {
    tokens: [
      { name: 'USDC', index: 0 },
      { name: 'PURR', index: 1 },
      { name: 'HYPE', index: 150 },
      { name: 'USDT0', index: 268 },
    ],
    universe: [
      { name: 'PURR/USDC', tokens: [1, 0], index: 0, isCanonical: true },
      { name: '@107', tokens: [150, 0], index: 107, isCanonical: false },
      { name: '@207', tokens: [150, 268], index: 207, isCanonical: false },
    ],
  },
  [],
]);

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('SpotCoinNameService', () => {
  let service: import('../../../src/services/spot/spotCoinNames.service').SpotCoinNameService;

  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers({ now: Date.UTC(2026, 8, 24), doNotFake: ['setImmediate', 'nextTick'] });
    mockRedis.get.mockReset();
    mockRedis.get.mockResolvedValue(SPOT_RAW);
    service = require('../../../src/services/spot/spotCoinNames.service').SpotCoinNameService.getInstance();
  });

  afterEach(() => jest.useRealTimers());

  it('resolves pair ids to their base token once loaded', async () => {
    await service.reload();
    expect(mockRedis.get).toHaveBeenCalledWith('spot:raw_data');
    expect(service.resolve('@107')).toBe('HYPE');
    expect(service.resolve('@207')).toBe('HYPE'); // HYPE/USDT0: same token
    expect(service.resolve('PURR/USDC')).toBe('PURR');
  });

  it('passes an unknown id through and loads the table on first use', async () => {
    expect(service.resolve('@107')).toBe('@107');
    await flush();
    expect(service.resolve('@107')).toBe('HYPE');
    expect(mockRedis.get).toHaveBeenCalledTimes(1);
  });

  it('reloads for an unknown id at most once a minute', async () => {
    await service.reload();
    expect(service.resolve('@999')).toBe('@999');
    await flush();
    expect(mockRedis.get).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(60_001);
    expect(service.resolve('@999')).toBe('@999');
    await flush();
    expect(mockRedis.get).toHaveBeenCalledTimes(2);
  });

  it('keeps passing ids through while the spot cache is empty or unreadable', async () => {
    mockRedis.get.mockResolvedValueOnce(null);
    await service.reload();
    expect(service.resolve('@107')).toBe('@107');

    jest.advanceTimersByTime(60_001);
    mockRedis.get.mockResolvedValueOnce('{not json');
    await service.reload();
    expect(service.resolve('@107')).toBe('@107');
  });

  it('retries every 5 s while the spot cache is missing at boot', async () => {
    mockRedis.get.mockResolvedValueOnce(null);
    expect(service.resolve('@107')).toBe('@107');
    await flush();
    expect(mockRedis.get).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(2_000);
    expect(service.resolve('@107')).toBe('@107');
    await flush();
    expect(mockRedis.get).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(3_001);
    service.resolve('@107');
    await flush();
    expect(mockRedis.get).toHaveBeenCalledTimes(2);
    expect(service.resolve('@107')).toBe('HYPE');
  });
});
