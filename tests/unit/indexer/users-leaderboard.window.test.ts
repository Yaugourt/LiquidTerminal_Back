/**
 * The traders ranked over a window: what is asked of the provider, what is kept of its answer, and
 * one shared entry per window, ranking and page.
 */
process.env.HL_INDEXER_API_KEY = process.env.HL_INDEXER_API_KEY || 'test-key';

const mockRedis = {
  store: new Map<string, string>(),
  ttls: new Map<string, number | undefined>(),
  get: jest.fn(async (key: string) => mockRedis.store.get(key) ?? null),
  set: jest.fn(async (key: string, value: string, ttl?: number) => {
    mockRedis.store.set(key, value);
    mockRedis.ttls.set(key, ttl);
  }),
  delete: jest.fn(async (key: string) => {
    mockRedis.store.delete(key);
  }),
  getClient: () => ({ set: async () => 'OK', exists: async () => 0 }),
  isHealthy: () => true,
};
jest.mock('../../../src/core/redis.service', () => ({ redisService: mockRedis }));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { HypeDexerUsersIndexerClient } from '../../../src/clients/hypedexer/rest/users/users-indexer.client';
import { IndexerUsersService } from '../../../src/services/indexer/indexer-users.service';
import { HYPEDEXER_TTL } from '../../../src/constants/hypedexer.cache';

const client = HypeDexerUsersIndexerClient.getInstance();
const get = jest.spyOn(client, 'get');
const answer = (first: string, total: unknown = 224_149) => ({
  success: true,
  message: 'Users leaderboard by volume over 7d',
  data: [{ user: first, rank: 1, win_rate: 0.5, refreshed_at: 1_795_621_260_000 }],
  total_count: total,
  next_cursor: '2',
  has_more: true,
});

describe('traders ranked over a window', () => {
  beforeEach(() => {
    mockRedis.store.clear();
    mockRedis.ttls.clear();
    get.mockReset();
  });

  it('asks the window, the ranking and the page, and keeps the rows and their total', async () => {
    get.mockResolvedValue(answer('0xa'));
    const page = await client.getLeaderboardWindow({ window: '7d', by: 'win_rate', page: 2, limit: 100 });

    expect(get).toHaveBeenCalledWith('/users/leaderboard?window=7d&by=win_rate&page=2&limit=100');
    expect(page).toEqual({ rows: answer('0xa').data, total: 224_149 });
  });

  it('says it does not know the total when the provider does not give it', async () => {
    get.mockResolvedValue(answer('0xa', null));
    expect((await client.getLeaderboardWindow({ window: 'all', by: 'pnl', page: 1, limit: 20 })).total).toBeNull();
  });

  it.each([
    ['a refusal', { success: false, message: 'no' }],
    ['no list', { success: true, data: { rows: [] } }],
    ['nothing', null],
  ])('%s is a failure, never an empty ranking', async (_what, body) => {
    get.mockResolvedValue(body);
    await expect(client.getLeaderboardWindow({ window: '7d', by: 'volume', page: 9, limit: 20 })).rejects.toThrow(
      'Unexpected leaderboard payload'
    );
  });

  it('shares one entry per window, ranking, page and size, for five minutes', async () => {
    get.mockImplementation(async (endpoint: string) => answer(endpoint) as never);
    const svc = IndexerUsersService.getInstance();
    const q = { window: '7d', by: 'pnl', page: 1, limit: 100 } as const;

    const first = await svc.getLeaderboardWindow(q);
    expect(await svc.getLeaderboardWindow({ ...q })).toEqual(first);
    expect(get).toHaveBeenCalledTimes(1);

    const others = await Promise.all([
      svc.getLeaderboardWindow({ ...q, window: '30d' }),
      svc.getLeaderboardWindow({ ...q, by: 'volume' }),
      svc.getLeaderboardWindow({ ...q, page: 2 }),
      svc.getLeaderboardWindow({ ...q, limit: 50 }),
    ]);
    expect(get).toHaveBeenCalledTimes(5);
    expect(new Set([first, ...others].map((page) => JSON.stringify(page))).size).toBe(5);

    const ttls = [...mockRedis.ttls].filter(([key]) => key.startsWith('hypedexer:users:leaderboard-window') && !key.endsWith(':last'));
    expect(ttls).toHaveLength(5);
    expect(new Set(ttls.map(([, ttl]) => ttl))).toEqual(new Set([HYPEDEXER_TTL.usersLeaderboardWindow]));
    expect(HYPEDEXER_TTL.usersLeaderboardWindow).toBe(300);
  });

  it('readers that ask together make one call', async () => {
    let release: (value: unknown) => void = () => undefined;
    get.mockReturnValue(new Promise((resolve) => (release = resolve)) as never);
    const q = { window: 'all', by: 'volume', page: 1, limit: 20 } as const;
    const both = Promise.all([client.getLeaderboardWindow(q), client.getLeaderboardWindow({ ...q })]);
    await new Promise((resolve) => setImmediate(resolve));
    release(answer('0xa'));

    const [a, b] = await both;
    expect(a).toEqual(b);
    expect(get).toHaveBeenCalledTimes(1);
  });
});
