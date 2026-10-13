/**
 * The credit meter reads HypeDexer's X-Credit-Cost: per-path spend logged
 * once a minute, the day's total in Redis, one warning past the budget.
 */
const mockCounters = new Map<string, number>();
const mockExpires = new Map<string, number>();
const mockClient = {
  incrby: jest.fn(async (key: string, by: number) => {
    const next = (mockCounters.get(key) ?? 0) + by;
    mockCounters.set(key, next);
    return next;
  }),
  expire: jest.fn(async (key: string, seconds: number) => {
    mockExpires.set(key, seconds);
    return 1;
  }),
};
const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

jest.mock('../../../src/core/redis.service', () => ({
  redisService: {
    getClient: () => mockClient,
    get: jest.fn(async (key: string) => (mockCounters.has(key) ? String(mockCounters.get(key)) : null)),
  },
}));
jest.mock('../../../src/utils/logDeduplicator', () => ({ logDeduplicator: mockLog }));

import { creditPath, HypedexerCreditMeter } from '../../../src/utils/hypedexer-credit-meter';

const flushPromises = () => new Promise((resolve) => setImmediate(resolve));

describe('creditPath', () => {
  it.each([
    ['https://api.hypedexer.com/vaults/vaultSummaries?includeClosed=true&limit=5000', '/vaults/vaultSummaries'],
    ['https://api.hypedexer.com/users/0x1111111111111111111111111111111111111111/overview', '/users/:address/overview'],
    ['https://api.hypedexer.com/builders/0xAbCd111111111111111111111111111111111111/stats?timeframe=24h', '/builders/:address/stats'],
    ['https://api.hypedexer.com/completed-trades/123456789/fills', '/completed-trades/:id/fills'],
    ['https://api.hypedexer.com/liquidations/?limit=1000', '/liquidations'],
    ['http://127.0.0.1:4555/hip4/fills?coin=%231010&limit=400', '/hip4/fills'],
  ])('%s → %s', (url, path) => {
    expect(creditPath(url)).toBe(path);
  });
});

describe('HypedexerCreditMeter', () => {
  const today = new Date().toISOString().slice(0, 10);
  const dayKey = `hypedexer:credits:${today}`;
  let meter: HypedexerCreditMeter;

  beforeEach(() => {
    mockCounters.clear();
    mockExpires.clear();
    jest.clearAllMocks();
    delete process.env.HYPEDEXER_DAILY_CREDIT_BUDGET;
    meter = new HypedexerCreditMeter();
  });

  afterEach(() => meter.reset());

  it('ignores responses without a cost header (every other upstream)', async () => {
    meter.record('https://api.hyperliquid.xyz/info', null, null);
    meter.record('https://api.hypedexer.com/x', '', null);
    meter.record('https://api.hypedexer.com/x', 'n/a', null);
    await flushPromises();
    meter.flush();
    expect(mockClient.incrby).not.toHaveBeenCalled();
    expect(mockLog.info).not.toHaveBeenCalled();
  });

  it('logs the last minute per path, most expensive first, then starts over', async () => {
    meter.record('https://api.hypedexer.com/vaults/vaultSummaries?limit=5000', '502', '999690000000');
    meter.record('https://api.hypedexer.com/hip4/fills?coin=%2310&limit=50', '7', null);
    meter.record('https://api.hypedexer.com/hip4/fills?coin=%2311&limit=50', '7', null);
    await flushPromises();
    meter.flush();

    expect(mockLog.info).toHaveBeenCalledWith('HypeDexer credits (last minute)', {
      calls: 3,
      credits: 516,
      balance: 999690000000,
      topPaths: ['/vaults/vaultSummaries 502cr/1', '/hip4/fills 14cr/2'],
    });
    mockLog.info.mockClear();
    meter.flush();
    expect(mockLog.info).not.toHaveBeenCalled();
  });

  it('adds up the day in Redis with an expiry, and warns once past the budget', async () => {
    process.env.HYPEDEXER_DAILY_CREDIT_BUDGET = '1000';
    meter.record('https://api.hypedexer.com/a', '600', null);
    await flushPromises();
    meter.record('https://api.hypedexer.com/a', '600', null);
    await flushPromises();
    meter.record('https://api.hypedexer.com/a', '600', null);
    await flushPromises();

    expect(mockCounters.get(dayKey)).toBe(1800);
    expect(mockExpires.get(dayKey)).toBe(8 * 24 * 60 * 60);
    expect(mockLog.warn).toHaveBeenCalledTimes(1);
    expect(mockLog.warn).toHaveBeenCalledWith('HypeDexer daily credit budget exceeded', expect.objectContaining({ credits: 1200, budget: 1000 }));
    await expect(meter.todayTotal()).resolves.toBe(1800);
  });

  it('defaults to a 1,000,000 budget, above the ~320k background day, and only warns', async () => {
    mockCounters.set(dayKey, 999_000);
    meter.record('https://api.hypedexer.com/a', '900', null);
    await flushPromises();
    expect(mockLog.warn).not.toHaveBeenCalled();

    // record() returns nothing to wait on: past the budget the call has long gone through.
    expect(meter.record('https://api.hypedexer.com/a', '200', null)).toBeUndefined();
    await flushPromises();
    expect(mockLog.warn).toHaveBeenCalledWith(
      'HypeDexer daily credit budget exceeded',
      expect.objectContaining({ credits: 1_000_100, budget: 1_000_000 })
    );
  });

  it('keeps metering the minute when Redis fails', async () => {
    mockClient.incrby.mockRejectedValueOnce(new Error('down'));
    meter.record('https://api.hypedexer.com/a', '3', null);
    await flushPromises();
    meter.flush();
    expect(mockLog.warn).toHaveBeenCalledWith('HypeDexer credit meter: could not update the daily total', { error: 'down' });
    expect(mockLog.info).toHaveBeenCalledWith('HypeDexer credits (last minute)', expect.objectContaining({ credits: 3 }));
  });
});
