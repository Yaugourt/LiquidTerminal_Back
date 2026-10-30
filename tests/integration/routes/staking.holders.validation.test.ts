/**
 * GET /staking/holders: a page below 1, a non-numeric page/limit or a limit above
 * 1000 (100 for /top) answers 400 with the shared validation error shape, not a 500.
 */
import type { NextFunction, Request, Response } from 'express';
import express from 'express';
import request from 'supertest';

jest.mock('../../../src/middleware/apiRateLimiter', () => ({
  marketRateLimiter: (_req: Request, _res: Response, next: NextFunction) => next(),
}));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const service = { getStakedHolders: jest.fn(), getTopHolders: jest.fn(), getHoldersStats: jest.fn(), getHolderByAddress: jest.fn() };
jest.mock('../../../src/services/staking/stakedHolders.service', () => ({
  StakedHoldersService: { getInstance: () => service },
  StakedHoldersUnavailableError: class extends Error {},
}));

import router from '../../../src/routes/staking/stakedHolders.routes';

const app = express();
app.use('/staking/holders', router);

beforeEach(() => {
  jest.clearAllMocks();
  service.getStakedHolders.mockResolvedValue({ holders: [] });
  service.getTopHolders.mockResolvedValue([]);
});

describe('GET /staking/holders', () => {
  it.each(['page=0', 'page=-3', 'page=abc', 'page=1.5', 'limit=1001', 'limit=0', 'limit=abc', 'limit=-1'])(
    'answers 400 for %s',
    async (qs) => {
      const res = await request(app).get(`/staking/holders?${qs}`);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation Error');
      expect(Array.isArray(res.body.details)).toBe(true);
      expect(service.getStakedHolders).not.toHaveBeenCalled();
    },
  );

  it('still serves valid and default parameters', async () => {
    expect((await request(app).get('/staking/holders?page=2&limit=1000')).status).toBe(200);
    expect(service.getStakedHolders).toHaveBeenCalledWith(2, 1000);
    expect((await request(app).get('/staking/holders')).status).toBe(200);
    expect(service.getStakedHolders).toHaveBeenLastCalledWith(1, 20);
  });
});

describe('GET /staking/holders/top', () => {
  it.each(['limit=101', 'limit=0', 'limit=abc'])('answers 400 for %s', async (qs) => {
    const res = await request(app).get(`/staking/holders/top?${qs}`);
    expect(res.status).toBe(400);
    expect(service.getTopHolders).not.toHaveBeenCalled();
  });

  it('serves a valid limit', async () => {
    expect((await request(app).get('/staking/holders/top?limit=100')).status).toBe(200);
    expect(service.getTopHolders).toHaveBeenCalledWith(100);
  });
});
