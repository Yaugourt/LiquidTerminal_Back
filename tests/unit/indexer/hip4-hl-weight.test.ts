/**
 * The HIP-4 raw reads of Hyperliquid (outcomeMeta, outcomeTemplates, allMids)
 * go through plain fetch, not BaseApiService: each is counted by the weight
 * meter by hand.
 */
jest.mock('../../../src/core/redis.service', () => ({
  redisService: { get: jest.fn(async () => null), set: jest.fn(), isHealthy: () => true },
}));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { IndexerHip4Service } from '../../../src/services/indexer/indexer-hip4.service';
import { hyperliquidWeightMeter } from '../../../src/utils/hyperliquid-weight-meter';

type Internals = {
  readHlOutcomeIds(): Promise<number[]>;
  fetchHlOutcomeTemplates(): Promise<unknown[]>;
  readHlMidPrices(): Promise<Map<string, number>>;
};

describe('HIP-4 Hyperliquid reads in the weight meter', () => {
  const realFetch = global.fetch;
  const service = IndexerHip4Service.getInstance() as unknown as Internals;
  const answer = (body: unknown): Response =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

  beforeEach(() => hyperliquidWeightMeter.reset());
  afterEach(() => hyperliquidWeightMeter.reset());
  afterAll(() => {
    global.fetch = realFetch;
  });

  const spent = (): { weight: number; calls: number } => {
    hyperliquidWeightMeter.flush();
    return hyperliquidWeightMeter.lastMinute() ?? { weight: -1, calls: -1 };
  };

  it('counts outcomeMeta at 20, outcomeTemplates at 20 and allMids at 2', async () => {
    global.fetch = jest.fn(async () => answer({ outcomes: [{ outcome: 1 }] })) as unknown as typeof fetch;
    await expect(service.readHlOutcomeIds()).resolves.toEqual([1]);
    global.fetch = jest.fn(async () => answer([])) as unknown as typeof fetch;
    await service.fetchHlOutcomeTemplates();
    global.fetch = jest.fn(async () => answer({ '#10': '0.5', BTC: '1' })) as unknown as typeof fetch;
    await expect(service.readHlMidPrices()).resolves.toEqual(new Map([['#10', 0.5]]));
    expect(spent()).toMatchObject({ weight: 20 + 20 + 2, calls: 3 });
  });

  it('counts a read that failed', async () => {
    global.fetch = jest.fn(async () => new Response('{}', { status: 500 })) as unknown as typeof fetch;
    await expect(service.readHlMidPrices()).rejects.toThrow();
    expect(spent()).toMatchObject({ weight: 2, calls: 1 });
  });
});
