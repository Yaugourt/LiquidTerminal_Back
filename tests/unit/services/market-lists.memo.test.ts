/**
 * The spot and perp market lists parse their Redis copy once per write, not
 * once per request (the poller writes every 2 s, the front polls every 5 s),
 * and a request never sees another request's sort.
 */
const store = new Map<string, string>();
jest.mock('../../../src/core/redis.service', () => ({
  redisService: {
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    subscribe: jest.fn(),
  },
}));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { SpotAssetContextService } from '../../../src/services/spot/marketData.service';
import { PerpAssetContextService } from '../../../src/services/perp/perpAssetContext.service';

const spotRows = [
  { name: 'AAA', volume: 1, price: 1, change24h: 0, marketCap: 10 },
  { name: 'BBB', volume: 3, price: 2, change24h: 0, marketCap: 20 },
  { name: 'CCC', volume: 2, price: 3, change24h: 0, marketCap: 30 },
];
const perpRows = [
  { name: 'BTC', volume: 5, price: 100, change24h: 0, openInterest: 2, funding: 0 },
  { name: 'ETH', volume: 7, price: 10, change24h: 0, openInterest: 3, funding: 0 },
];

describe('market list memo', () => {
  let parse: jest.SpyInstance;
  beforeEach(() => {
    store.set('spot:markets', JSON.stringify(spotRows));
    store.set('perp:markets', JSON.stringify(perpRows));
    parse = jest.spyOn(JSON, 'parse');
  });
  afterEach(() => parse.mockRestore());

  it('spot: parses once per write and keeps each request sorted its own way', async () => {
    const svc = SpotAssetContextService.getInstance();
    const byVolume = await svc.getMarketsData({ sortBy: 'volume', sortOrder: 'desc', limit: 10 });
    const byName = await svc.getMarketsData({ sortBy: 'name', sortOrder: 'asc', limit: 10 });
    const again = await svc.getMarketsData({ sortBy: 'volume', sortOrder: 'desc', limit: 10 });
    expect(byVolume.data.map((m) => m.name)).toEqual(['BBB', 'CCC', 'AAA']);
    expect(byName.data.map((m) => m.name)).toEqual(['AAA', 'BBB', 'CCC']);
    expect(again.data.map((m) => m.name)).toEqual(['BBB', 'CCC', 'AAA']);
    expect(parse.mock.calls.filter(([raw]) => raw === store.get('spot:markets'))).toHaveLength(1);

    store.set('spot:markets', JSON.stringify([...spotRows, { name: 'DDD', volume: 9, price: 4, change24h: 0, marketCap: 40 }]));
    const fresh = await svc.getMarketsData({ sortBy: 'volume', sortOrder: 'desc', limit: 10 });
    expect(fresh.data[0].name).toBe('DDD');
  });

  it('perp: parses once per write and still converts OI to USD on every request', async () => {
    const svc = PerpAssetContextService.getInstance();
    const a = await svc.getPerpMarketsData({ sortBy: 'volume', sortOrder: 'desc', limit: 10 });
    const b = await svc.getPerpMarketsData({ sortBy: 'volume', sortOrder: 'desc', limit: 10 });
    expect(a.data.map((m) => [m.name, m.openInterest])).toEqual([['ETH', 30], ['BTC', 200]]);
    expect(b.data.map((m) => [m.name, m.openInterest])).toEqual([['ETH', 30], ['BTC', 200]]);
    expect(parse.mock.calls.filter(([raw]) => raw === store.get('perp:markets'))).toHaveLength(1);
  });
});
