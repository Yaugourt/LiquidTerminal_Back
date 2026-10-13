/**
 * GET /home/globalstats reads DefiLlama's bridged USDC through one shared,
 * cached value instead of once per request:
 * - any number of requests within the TTL costs one DefiLlama call;
 * - a DefiLlama failure never answers 500: the last copy is served, else the
 *   other fields with `bridgedUsdc: null`;
 * - a hanging DefiLlama is cut off after BRIDGED_USDC_FETCH_TIMEOUT_MS, so a
 *   request gets the last copy (even past the 20 min serve-while-refresh
 *   window) or, on a cold key, null, within its wait.
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
jest.mock('../../../src/middleware/apiRateLimiter', () => ({
  marketRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../../src/clients/hyperliquid/globalstats.client', () => ({
  HyperliquidGlobalStatsClient: {
    getInstance: () => ({ getGlobalStats: async () => ({ nUsers: 812_000, dailyVolume: 9_500_000_000 }) }),
  },
}));
jest.mock('../../../src/services/staking/validator.service', () => ({
  ValidatorSummariesService: {
    getInstance: () => ({ getValidatorSummaries: async () => [{ stake: 30_000_000_000_000_000 }] }),
  },
}));
jest.mock('../../../src/services/vault/vaults.service', () => ({
  VaultsService: { getInstance: () => ({ getVaultsList: async () => ({ pagination: { totalTvl: 512_000_000 } }) }) },
}));

import express from 'express';
import request from 'supertest';
import globalStatsRoutes from '../../../src/routes/globalStats.routes';
import {
  BridgedUsdcService,
  BRIDGED_USDC_FETCH_TIMEOUT_MS,
  BRIDGED_USDC_READ_WAIT_MS,
} from '../../../src/services/bridgedUsdc.service';
import { DEFILLAMA_CACHE_KEYS } from '../../../src/constants/defillama.cache';

const KEY = DEFILLAMA_CACHE_KEYS.bridgedUsdc;
const SERIES = [
  { date: 1791504000, totalCirculating: { peggedUSD: 5_801_000_000 } },
  { date: 1791590400, totalCirculating: { peggedUSD: 5_812_345_678 } },
];
const OTHER_FIELDS = {
  numberOfUsers: 812_000,
  dailyVolume: 9_500_000_000,
  totalHypeStake: 300_000_000,
  vaultsTvl: 512_000_000,
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function buildApp() {
  const app = express();
  app.use('/home/globalstats', globalStatsRoutes);
  return app;
}

/** Lets a background refresh started by a request settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('GET /home/globalstats — bridged USDC from DefiLlama', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    mockRedis.store.clear();
    mockRedis.expiries.clear();
    mockRedis.ttls.clear();
    mockRedis.locks.clear();
    fetchMock = jest.fn(async () => json(SERIES));
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterAll(() => {
    global.fetch = realFetch;
  });

  it('asks DefiLlama once for any number of requests within the TTL', async () => {
    const app = buildApp();
    const first = await request(app).get('/home/globalstats');
    const others = await Promise.all(Array.from({ length: 5 }, () => request(app).get('/home/globalstats')));

    expect(first.status).toBe(200);
    expect(first.body).toEqual({ ...OTHER_FIELDS, bridgedUsdc: 5_812_345_678 });
    for (const res of others) expect(res.body.bridgedUsdc).toBe(5_812_345_678);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://stablecoins.llama.fi/stablecoincharts/Hyperliquid?stablecoin=2'
    );
    // Only the figure is stored, for 5 min, with a copy kept a day.
    expect(mockRedis.store.get(KEY)).toBe('5812345678');
    expect(mockRedis.ttls.get(KEY)).toBe(300);
    expect(mockRedis.ttls.get(`${KEY}:last`)).toBe(86_400);
  });

  it('serves the last copy when DefiLlama fails after the key expired', async () => {
    const app = buildApp();
    await request(app).get('/home/globalstats');
    mockRedis.store.delete(KEY); // the 5 min TTL ran out
    fetchMock.mockResolvedValue(new Response('upstream down', { status: 404 }));

    const res = await request(app).get('/home/globalstats');
    await settle();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ...OTHER_FIELDS, bridgedUsdc: 5_812_345_678 });
    // The refresh was tried once, in the background.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('answers the other fields with bridgedUsdc null when DefiLlama fails and nothing is cached', async () => {
    fetchMock.mockResolvedValue(new Response('upstream down', { status: 404 }));
    const res = await request(buildApp()).get('/home/globalstats');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ...OTHER_FIELDS, bridgedUsdc: null });
  });

  it('never stores an answer without a latest value', async () => {
    fetchMock.mockResolvedValue(json([]));
    const res = await request(buildApp()).get('/home/globalstats');

    expect(res.status).toBe(200);
    expect(res.body.bridgedUsdc).toBeNull();
    expect(mockRedis.store.has(KEY)).toBe(false);
  });
});

describe('BridgedUsdcService.getLatestBridgedUsdc', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;
  /** A DefiLlama that never answers (the request is only ended by its abort signal). */
  const hang = (_url: unknown, init?: RequestInit): Promise<Response> =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
      );
    });

  beforeEach(() => {
    mockRedis.store.clear();
    mockRedis.expiries.clear();
    mockRedis.ttls.clear();
    mockRedis.locks.clear();
    jest.useFakeTimers();
    fetchMock = jest.fn(async () => json(SERIES));
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    jest.useRealTimers();
    global.fetch = realFetch;
  });

  it('gives a fetch less time than a request waits', () => {
    expect(BRIDGED_USDC_FETCH_TIMEOUT_MS).toBeLessThan(BRIDGED_USDC_READ_WAIT_MS);
  });

  it('answers null on a cold key whose fetch hangs, within the fetch deadline', async () => {
    fetchMock.mockImplementation(hang);
    const service = new BridgedUsdcService();

    let settled = false;
    const read = service.getLatestBridgedUsdc().finally(() => { settled = true; });
    await jest.advanceTimersByTimeAsync(BRIDGED_USDC_FETCH_TIMEOUT_MS);
    expect(settled).toBe(true);
    await expect(read).resolves.toBeNull();
    expect(mockRedis.store.has(KEY)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('serves the day-long copy, not null, when DefiLlama hangs past the 20 min refresh window', async () => {
    const service = new BridgedUsdcService();
    await expect(service.getLatestBridgedUsdc()).resolves.toBe(5_812_345_678);

    // 21 min later: the key is gone and the copy is past the serve-while-refresh
    // window, so the read waits for the fetch, which hangs.
    await jest.advanceTimersByTimeAsync(21 * 60_000);
    await expect(mockRedis.get(KEY)).resolves.toBeNull();
    fetchMock.mockImplementation(hang);

    let settled = false;
    const read = service.getLatestBridgedUsdc().finally(() => { settled = true; });
    await jest.advanceTimersByTimeAsync(BRIDGED_USDC_FETCH_TIMEOUT_MS);
    expect(settled).toBe(true); // before BRIDGED_USDC_READ_WAIT_MS would give up with null
    await expect(read).resolves.toBe(5_812_345_678);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // During the failure backoff the copy is served at once, without a fetch.
    await expect(service.getLatestBridgedUsdc()).resolves.toBe(5_812_345_678);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // After it, one more attempt; the copy again.
    await jest.advanceTimersByTimeAsync(10_000);
    const retry = service.getLatestBridgedUsdc();
    await jest.advanceTimersByTimeAsync(BRIDGED_USDC_FETCH_TIMEOUT_MS);
    await expect(retry).resolves.toBe(5_812_345_678);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('serves a slow answer that lands within the fetch deadline', async () => {
    fetchMock.mockImplementation(
      () => new Promise<Response>((resolve) => setTimeout(() => resolve(json(SERIES)), BRIDGED_USDC_FETCH_TIMEOUT_MS - 500))
    );
    const service = new BridgedUsdcService();

    const read = service.getLatestBridgedUsdc();
    await jest.advanceTimersByTimeAsync(BRIDGED_USDC_FETCH_TIMEOUT_MS);
    await expect(read).resolves.toBe(5_812_345_678);
    expect(mockRedis.store.get(KEY)).toBe('5812345678');
  });
});
