/**
 * The perp poller turns Hyperliquid `metaAndAssetCtxs` into the rows served by
 * `/market/perp` (Redis `perp:markets`):
 * - one row per perp of the universe, its context matched by position;
 * - perps with no 24h volume are left out;
 * - the raw pair is cached as read (`perp:raw_data`) and an update is published.
 */
process.env.HL_CTX_STREAM_ENABLED = 'false'; // the REST-only poller; the stream has its own tests
const mockRedis = {
  set: jest.fn<Promise<unknown>, [string, string]>(),
  get: jest.fn<Promise<string | null>, [string]>(),
  publish: jest.fn<Promise<unknown>, [string, string]>(),
};

jest.mock('../../../src/core/redis.service', () => ({ redisService: mockRedis }));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const ctx = (markPx: string, prevDayPx: string, dayNtlVlm: string, funding: string, openInterest: string): Record<string, unknown> => ({
  funding,
  openInterest,
  prevDayPx,
  dayNtlVlm,
  premium: '0.0001',
  oraclePx: markPx,
  markPx,
  midPx: markPx,
  impactPxs: [markPx, markPx],
  dayBaseVlm: '10.0',
});

const META = {
  universe: [
    { name: 'BTC', szDecimals: 5, maxLeverage: 40 },
    { name: 'ETH', szDecimals: 4, maxLeverage: 25, onlyIsolated: true },
    { name: 'DEAD', szDecimals: 1, maxLeverage: 3, isDelisted: true },
    { name: 'ZERO', szDecimals: 1, maxLeverage: 5 },
  ],
};
const CONTEXTS = [
  ctx('80000.0', '78000.0', '5000000.5', '0.0000125', '40000.1'),
  ctx('4000.0', '4000.0', '2000000.0', '-0.00002', '900000.0'),
  ctx('1.0', '1.0', '0.0', '0.0', '0.0'),
  ctx('1.0', '0.0', '0.0', '0.0', '0.0'),
];

describe('HyperliquidPerpClient poll', () => {
  it('writes the rows, the raw pair and the update event', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    mockRedis.set.mockResolvedValue('OK');
    mockRedis.publish.mockResolvedValue(1);
    const { HyperliquidPerpClient } = require('../../../src/clients/hyperliquid/perp/perp.assetcontext.client');
    const client = HyperliquidPerpClient.getInstance();
    jest.spyOn(client, 'post').mockResolvedValue([META, CONTEXTS]);
    client.startPolling();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    client.stopPolling();
    jest.useRealTimers();

    const writes = Object.fromEntries(mockRedis.set.mock.calls);
    expect(JSON.parse(writes['perp:raw_data'])).toEqual([META, CONTEXTS]);
    expect(JSON.parse(writes['perp:markets'])).toEqual([
      {
        index: 0,
        name: 'BTC',
        logo: 'https://app.hyperliquid.xyz/coins/BTC.svg',
        price: 80000,
        change24h: 2.56,
        volume: 5000000.5,
        openInterest: 40000.1,
        funding: 0.0000125,
        maxLeverage: 40,
        onlyIsolated: false,
      },
      {
        index: 1,
        name: 'ETH',
        logo: 'https://app.hyperliquid.xyz/coins/ETH.svg',
        price: 4000,
        change24h: 0,
        volume: 2000000,
        openInterest: 900000,
        funding: -0.00002,
        maxLeverage: 25,
        onlyIsolated: true,
      },
    ]);
    expect(mockRedis.publish).toHaveBeenCalledWith('perp:data:updated', expect.stringContaining('DATA_UPDATED'));
  });
});
