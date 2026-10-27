/** Spot global stats: the market-cap tile counts each base token once. */
const mockGet = jest.fn();
jest.mock('../../../src/core/redis.service', () => ({
  redisService: { get: (k: string) => mockGet(k), subscribe: jest.fn(), set: jest.fn(), publish: jest.fn() },
}));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { SpotGlobalStatsService } from '../../../src/services/spot/spotStats.service';
import { HyperliquidSpotStatsClient } from '../../../src/clients/hyperliquid/spot/spot.stats.client';

const markets = [
  { name: 'HYPE/USDC', tokenId: 'HYPE', quote: 'USDC', marketCap: 24, volume: 10 },
  { name: 'HYPE/USDT0', tokenId: 'HYPE', quote: 'USDT0', marketCap: 25, volume: 5 },
  { name: 'PURR/USDC', tokenId: 'PURR', quote: 'USDC', marketCap: 1, volume: 1 },
];

describe('spot totalMarketCap', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockGet.mockImplementation(async (key: string) => (key === 'spot:markets' ? JSON.stringify(markets) : null));
  });

  it('is counted once per token by the stats service', async () => {
    const stats = await new SpotGlobalStatsService().getSpotGlobalStats();
    expect(stats.totalMarketCap).toBe(25);
    expect(stats.totalPairs).toBe(3);
    expect(stats.totalVolume24h).toBe(16);
  });

  it('is counted once per token by the stats poller', async () => {
    const client = HyperliquidSpotStatsClient.getInstance();
    const { redisService } = jest.requireMock('../../../src/core/redis.service');
    await (client as unknown as { updateSpotStats(): Promise<void> }).updateSpotStats();
    const written = JSON.parse(redisService.set.mock.calls[0][1]);
    expect(written.totalMarketCap).toBe(25);
  });
});
