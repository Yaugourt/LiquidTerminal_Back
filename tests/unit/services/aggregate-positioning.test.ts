/**
 * Aggregate positioning: the clearinghouseState fan-out goes through
 * HypeDexer's /info, 4 at a time, waiting a 429's Retry-After; Hyperliquid is
 * the fallback when the proxy fails. A Hyperliquid 429 in the fan-out stops
 * the cycle (the weight budget is spent; the rest of the 80 calls would only
 * push the live pollers into 429s), keeps the last snapshot, and the next
 * cycle runs on schedule.
 */
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const redisSet = jest.fn(async () => undefined);
jest.mock('../../../src/core/redis.service', () => ({
  redisService: {
    get: jest.fn(async () => null),
    set: (...args: unknown[]) => redisSet(...(args as [])),
    publish: jest.fn(async () => undefined),
  },
}));
jest.mock('../../../src/core/prisma.historical.service', () => ({
  prismaHistorical: { positioningSnapshot: { upsert: jest.fn(async () => undefined) } },
}));
jest.mock('../../../src/utils/distributedLock', () => ({
  withDistributedLock: async (_key: string, _ttl: number, fn: () => Promise<void>) => {
    await fn();
    return true;
  },
}));

const COHORT = Array.from({ length: 40 }, (_, i) => `0x${i.toString(16).padStart(40, '0')}`);
jest.mock('../../../src/services/toptraders/toptraders.service', () => ({
  TopTradersService: {
    getInstance: () => ({
      getTopTraders: async () => ({ data: COHORT.map((user) => ({ user })) }),
    }),
  },
}));

import { CircuitBreakerService } from '../../../src/core/circuit.breaker.service';
import { HypeDexerInfoClient, resetInfoProxyOutages } from '../../../src/clients/hypedexer/rest/info/info.client';
import { AggregatePositioningClient } from '../../../src/clients/hyperliquid/positioning/aggregate-positioning.client';

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const state = {
  assetPositions: [{ position: { coin: 'BTC', szi: '1', positionValue: '100' } }],
};

const onHyperliquid = (url: unknown): boolean => String(url).includes('hyperliquid.xyz');

describe('AggregatePositioningClient fan-out', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;
  let infoClient: { circuitBreaker: unknown };

  beforeEach(() => {
    redisSet.mockClear();
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    // A fresh proxy breaker and outage state for every test.
    (CircuitBreakerService as unknown as { instances: Map<string, unknown> }).instances.delete('hypedexer-info');
    infoClient = HypeDexerInfoClient.getInstance() as unknown as { circuitBreaker: unknown };
    infoClient.circuitBreaker = CircuitBreakerService.getInstance('hypedexer-info');
    resetInfoProxyOutages();
  });

  afterAll(() => {
    global.fetch = realFetch;
  });

  const update = (): Promise<void> =>
    (AggregatePositioningClient.getInstance() as unknown as { updatePositioning(): Promise<void> }).updatePositioning();

  const snapshot = (): { coins: unknown[]; tradersScanned: number; cohortSize: number } =>
    JSON.parse(String(redisSet.mock.calls[0][1]));

  it('reads every wallet through HypeDexer, none from Hyperliquid, at most 4 at a time', async () => {
    let active = 0;
    let peak = 0;
    fetchMock.mockImplementation(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setImmediate(r));
      active -= 1;
      return json(200, state);
    });
    await update();
    expect(fetchMock).toHaveBeenCalledTimes(COHORT.length);
    expect(fetchMock.mock.calls.every((c) => !onHyperliquid(c[0]) && /\/info$/.test(String(c[0])))).toBe(true);
    expect(peak).toBeLessThanOrEqual(4);
    expect(redisSet).toHaveBeenCalledWith('positioning:aggregate', expect.any(String), 120);
  });

  it('waits a proxy 429 for its Retry-After instead of aborting the cycle', async () => {
    let calls = 0;
    fetchMock.mockImplementation(async () => {
      calls += 1;
      return calls === 3 ? new Response('{}', { status: 429, headers: { 'retry-after': '0' } }) : json(200, state);
    });
    await update();
    // The 429 was retried: every wallet answered, snapshot written.
    expect(fetchMock).toHaveBeenCalledTimes(COHORT.length + 1);
    expect(snapshot()).toMatchObject({ tradersScanned: COHORT.length, cohortSize: COHORT.length });
    expect(fetchMock.mock.calls.every((c) => !onHyperliquid(c[0]))).toBe(true);
  });

  it('gives the same snapshot from Hyperliquid when the proxy is down', async () => {
    fetchMock.mockImplementation(async () => json(200, state));
    await update();
    const viaProxy = snapshot();

    redisSet.mockClear();
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string) => (onHyperliquid(url) ? json(200, state) : json(502, null)));
    await update();
    const hlCalls = fetchMock.mock.calls.filter((c) => onHyperliquid(c[0]));
    expect(hlCalls).toHaveLength(COHORT.length);
    const viaHyperliquid = snapshot();
    expect({ ...viaHyperliquid, updatedAt: '' }).toEqual({ ...viaProxy, updatedAt: '' });
  });

  it('stops at the first Hyperliquid 429 (proxy down) and keeps the last snapshot', async () => {
    let hlCalls = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (!onHyperliquid(url)) return json(502, null);
      hlCalls += 1;
      return hlCalls === 3 ? json(429, null) : json(200, state);
    });
    await expect(update()).resolves.toBeUndefined();
    // No Hyperliquid call starts once the 429 is seen: the cohort is not read to the end.
    expect(hlCalls).toBeLessThan(COHORT.length);
    expect(redisSet).not.toHaveBeenCalled();
  });
});
