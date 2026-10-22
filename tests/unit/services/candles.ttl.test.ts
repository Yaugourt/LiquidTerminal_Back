/**
 * A candle key lives one bar, but never more than a minute: the route is
 * public, so a 1d key held a day would let anyone park day-long entries.
 */
const getOrSet = jest.fn(async () => []);
jest.mock('../../../src/core/cache.service', () => ({ cacheService: { getOrSet } }));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { HypeDexerCandlesClient } from '../../../src/clients/hypedexer/rest/candles/candles.client';

describe('candle cache TTL', () => {
  const client = HypeDexerCandlesClient.getInstance();
  const now = Date.now();

  it.each([
    ['5s', 5],
    ['30s', 30],
    ['1m', 60],
    ['1h', 60],
    ['1d', 60],
  ] as const)('%s bars are kept %i s', async (interval, ttl) => {
    getOrSet.mockClear();
    await client.getCandles('BTC', interval, now - 3_600_000, now);
    expect(getOrSet).toHaveBeenCalledWith(expect.stringContaining(`:${interval}:`), expect.any(Function), ttl, { lastCopy: false });
  });
});
