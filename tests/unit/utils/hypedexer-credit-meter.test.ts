/**
 * The credit meter reads HypeDexer's X-Credit-Cost: per-path spend logged
 * once a minute, the day's total in Redis, one warning past the budget.
 */
const mockCounters = new Map<string, number>();
const mockExpires = new Map<string, number>();
const mockHashes = new Map<string, Map<string, number>>();
const mockStrings = new Map<string, string>();
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
  /** The per-path totals are written in one round trip. */
  pipeline: () => {
    const ops: Array<() => void> = [];
    const p = {
      hincrby: (key: string, field: string, by: number) => {
        ops.push(() => {
          const hash = mockHashes.get(key) ?? new Map<string, number>();
          hash.set(field, (hash.get(field) ?? 0) + by);
          mockHashes.set(key, hash);
        });
        return p;
      },
      expire: (key: string, seconds: number) => {
        ops.push(() => mockExpires.set(key, seconds));
        return p;
      },
      set: (key: string, value: string) => {
        ops.push(() => mockStrings.set(key, value));
        return p;
      },
      exec: async () => ops.forEach((op) => op()),
    };
    return p;
  },
  mget: jest.fn(async (keys: string[]) => keys.map((k) => (mockCounters.has(k) ? String(mockCounters.get(k)) : null))),
  hgetall: jest.fn(async (key: string) => Object.fromEntries([...(mockHashes.get(key) ?? new Map()).entries()].map(([f, v]) => [f, String(v)]))),
  get: jest.fn(async (key: string) => mockStrings.get(key) ?? null),
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

  it('names at most 200 paths a day: the calls to any further one are counted together', async () => {
    // A path that carries an identifier creditPath does not fold (a ticker, a composite id).
    for (let i = 0; i < 260; i++) meter.record(`https://api.hypedexer.com/hip3/assets/TICKER${String.fromCharCode(65 + (i % 26))}x${i}`, '2', null);
    meter.record('https://api.hypedexer.com/hip3/assets/TICKERAx0', '2', null);
    await flushPromises();
    meter.flush();
    const [, line] = mockLog.info.mock.calls.find(([message]) => message === 'HypeDexer credits (last minute)') as [string, { calls: number; credits: number; topPaths: string[] }];
    expect(line.calls).toBe(261);
    expect(line.credits).toBe(522);
    // 60 calls beyond the 200 names, under one name; the path already named keeps its own.
    expect(line.topPaths[0]).toBe('(other paths) 120cr/60');
    expect(line.topPaths).toContain('/hip3/assets/TICKERAx0 4cr/2');
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

describe('HypedexerCreditMeter: what was spent, read back', () => {
  const meter = new HypedexerCreditMeter();
  beforeEach(() => {
    jest.useFakeTimers({ now: Date.parse('2026-11-11T12:00:00Z') });
    mockCounters.clear();
    mockHashes.clear();
    mockStrings.clear();
    meter.reset();
  });
  afterEach(() => {
    meter.reset();
    jest.useRealTimers();
  });

  it('keeps the day\'s credits and calls per path, added once a minute, and the balance', async () => {
    meter.record('https://api.hypedexer.com/elysium/testnet/transactions?limit=1000', '102', '9000000');
    meter.record('https://api.hypedexer.com/elysium/testnet/transactions?limit=1000&offset=1000', '52', '8999948');
    meter.record('https://api.hypedexer.com/elysium/testnet/stats', '2', '8999946');
    meter.flush();
    await jest.advanceTimersByTimeAsync(10);

    const summary = await meter.summary();
    expect(summary?.days[0]).toEqual({ day: '2026-11-11', credits: 156 });
    expect(summary?.topPathsToday).toEqual([
      { path: '/elysium/testnet/transactions', credits: 154, calls: 2 },
      { path: '/elysium/testnet/stats', credits: 2, calls: 1 },
    ]);
    expect(summary?.balance).toBe(8999946);
    // Kept as long as the day totals.
    expect(mockExpires.get('hypedexer:credits:paths:2026-11-11')).toBe(8 * 24 * 60 * 60);
  });

  it('gives the last 8 days, today first, with null for a day nothing is known of', async () => {
    mockCounters.set('hypedexer:credits:2026-11-11', 500);
    mockCounters.set('hypedexer:credits:2026-11-09', 1_200_000);
    const summary = await meter.summary();
    expect(summary?.days.slice(0, 3)).toEqual([
      { day: '2026-11-11', credits: 500 },
      { day: '2026-11-10', credits: null },
      { day: '2026-11-09', credits: 1_200_000 },
    ]);
    expect(summary?.days).toHaveLength(8);
    expect(summary?.balance).toBeNull();
  });

  it('answers null when Redis cannot say', async () => {
    mockClient.mget.mockRejectedValueOnce(new Error('Connection is closed'));
    expect(await meter.summary()).toBeNull();
  });
});
