/**
 * GET /indexer/users/leaderboard: without `window`, the last hours, as before; with it, a ranking
 * over 7 days, 30 days or all time, page by page. What the provider would refuse is refused here.
 */
import type { NextFunction, Request, Response } from 'express';
import express from 'express';
import request from 'supertest';
import { UpstreamBudgetExceededError } from '../../../src/errors/upstreamBudget.errors';

const pass = (_req: Request, _res: Response, next: NextFunction) => next();
jest.mock('../../../src/middleware/apiRateLimiter', () => ({
  marketRateLimiter: (req: Request, res: Response, next: NextFunction) => pass(req, res, next),
  passthroughRateLimiter: (req: Request, res: Response, next: NextFunction) => pass(req, res, next),
  indexerAddressRateLimiter: (req: Request, res: Response, next: NextFunction) => pass(req, res, next),
}));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const service = { getLeaderboard: jest.fn(), getLeaderboardWindow: jest.fn() };
jest.mock('../../../src/services/indexer/indexer-users.service', () => ({
  IndexerUsersService: { getInstance: () => service },
}));

import router from '../../../src/routes/indexer/users.routes';

const app = express();
app.use('/indexer/users', router);
const get = (query: string) => request(app).get(`/indexer/users/leaderboard${query}`);
const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ user: `0x${i}`, rank: i + 1 }));

describe('GET /indexer/users/leaderboard', () => {
  beforeEach(() => {
    service.getLeaderboard.mockReset().mockResolvedValue([{ user: '0xa' }]);
    service.getLeaderboardWindow.mockReset().mockResolvedValue({ rows: rows(20), total: 224_149 });
  });

  it('without a window: the last hours, same call and same answer as before', async () => {
    const res = await get('?by=priority_fees&hours=24&limit=11');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: [{ user: '0xa' }] });
    expect(service.getLeaderboard).toHaveBeenCalledWith({ by: 'priority_fees', hours: 24, limit: 11 });

    await get('');
    expect(service.getLeaderboard).toHaveBeenLastCalledWith({ by: 'volume', hours: 24, limit: 20 });
    expect(service.getLeaderboardWindow).not.toHaveBeenCalled();
  });

  it('with a window: the ranking, and where its page stands', async () => {
    service.getLeaderboardWindow.mockResolvedValue({ rows: rows(100), total: 224_149 });
    const res = await get('?window=7d&by=pnl&limit=100&page=3');

    expect(service.getLeaderboardWindow).toHaveBeenCalledWith({ window: '7d', by: 'pnl', page: 3, limit: 100 });
    expect(service.getLeaderboard).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(100);
    expect(res.body.pagination).toEqual({
      page: 3,
      limit: 100,
      total: 224_149,
      // The ones this route serves (10,000 rows deep), not the 2,242 of the ranking.
      totalPages: 101,
      hasNext: true,
      hasPrevious: true,
    });
  });

  it('with a window and nothing else: the first 20 by volume', async () => {
    const res = await get('?window=all');
    expect(service.getLeaderboardWindow).toHaveBeenCalledWith({ window: 'all', by: 'volume', page: 1, limit: 20 });
    expect(res.body.pagination).toMatchObject({ page: 1, limit: 20, totalPages: 501, hasNext: true, hasPrevious: false });
  });

  it('knows the last page, and says so when the provider gives no total', async () => {
    service.getLeaderboardWindow.mockResolvedValue({ rows: rows(5), total: 25 });
    expect((await get('?window=7d&page=2')).body.pagination).toMatchObject({ totalPages: 2, hasNext: false });

    service.getLeaderboardWindow.mockResolvedValue({ rows: rows(20), total: null });
    expect((await get('?window=7d')).body.pagination).toMatchObject({ total: null, totalPages: null, hasNext: true });
    service.getLeaderboardWindow.mockResolvedValue({ rows: rows(3), total: null });
    expect((await get('?window=7d')).body.pagination).toMatchObject({ hasNext: false });
  });

  it('serves the deepest page it announces, and no deeper', async () => {
    expect((await get('?window=7d&limit=100&page=101')).status).toBe(200);
    expect((await get('?window=7d&limit=100&page=102')).status).toBe(400);
    expect((await get('?window=7d&page=501')).status).toBe(200);
    expect((await get('?window=7d&page=502')).status).toBe(400);
  });

  it.each([
    ['a window the provider does not rank', '?window=24h'],
    ['two windows', '?window=7d&window=30d'],
    ['a ranking it does not know', '?window=7d&by=fees'],
    ['a ranking that needs a window', '?by=win_rate'],
    ['a ranking that needs a window', '?by=unrealized_pnl&hours=24'],
    ['a page without a window', '?page=2'],
    ['page 0', '?window=7d&page=0'],
    ['half a page', '?window=7d&page=1.5'],
    ['more than 100 rows', '?window=7d&limit=101'],
    ['more than 100 rows', '?limit=101'],
  ])('refuses %s: %s', async (_what, query) => {
    const res = await get(query);
    expect(res.status).toBe(400);
    expect(service.getLeaderboard).not.toHaveBeenCalled();
    expect(service.getLeaderboardWindow).not.toHaveBeenCalled();
  });

  it('a failure and a client over its budget answer as on the other indexer routes', async () => {
    service.getLeaderboardWindow.mockRejectedValue(new Error('boom'));
    const failed = await get('?window=7d');
    expect(failed.status).toBe(502);
    expect(failed.body).toEqual({ success: false, error: 'Upstream error', code: 'INDEXER_USERS_LEADERBOARD_ERROR' });

    service.getLeaderboardWindow.mockRejectedValue(new UpstreamBudgetExceededError(37));
    const refused = await get('?window=7d');
    expect(refused.status).toBe(429);
    expect(refused.headers['retry-after']).toBe('37');
  });
});
