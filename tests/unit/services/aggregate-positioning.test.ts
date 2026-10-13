/**
 * Aggregate positioning: a Hyperliquid 429 in the clearinghouseState fan-out
 * stops the cycle (the weight budget is spent; the rest of the 80 calls would
 * only push the live pollers into 429s), keeps the last snapshot, and the
 * next cycle runs on schedule.
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

import { AggregatePositioningClient } from '../../../src/clients/hyperliquid/positioning/aggregate-positioning.client';

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const state = {
  assetPositions: [{ position: { coin: 'BTC', szi: '1', positionValue: '100' } }],
};

describe('AggregatePositioningClient fan-out', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    redisSet.mockClear();
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterAll(() => {
    global.fetch = realFetch;
  });

  const update = (): Promise<void> =>
    (AggregatePositioningClient.getInstance() as unknown as { updatePositioning(): Promise<void> }).updatePositioning();

  it('stops at the first 429 and keeps the last snapshot', async () => {
    let calls = 0;
    fetchMock.mockImplementation(async () => {
      calls += 1;
      return calls === 3 ? json(429, null) : json(200, state);
    });
    await expect(update()).resolves.toBeUndefined();
    // No call starts once the 429 is seen: the cohort is not read to the end.
    expect(fetchMock.mock.calls.length).toBeLessThan(COHORT.length);
    expect(redisSet).not.toHaveBeenCalled();
  });

  it('builds the snapshot when every call answers', async () => {
    fetchMock.mockImplementation(async () => json(200, state));
    await update();
    expect(fetchMock).toHaveBeenCalledTimes(COHORT.length);
    expect(redisSet).toHaveBeenCalledWith('positioning:aggregate', expect.any(String), 120);
  });
});
