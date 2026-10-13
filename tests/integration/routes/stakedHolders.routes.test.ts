/**
 * /staking/holders: a stakers list that can't be read (Hypurrscan down and
 * nothing kept) is a temporary condition, answered 503 with a code and a
 * Retry-After, not a 500.
 */
import type { NextFunction, Request, Response } from 'express';
import express from 'express';
import request from 'supertest';

jest.mock('../../../src/middleware/apiRateLimiter', () => ({
  marketRateLimiter: (_req: Request, _res: Response, next: NextFunction) => {
    next();
  },
}));

jest.mock('../../../src/core/redis.service', () => ({
  redisService: { get: jest.fn(async () => null), set: jest.fn(async () => undefined) },
}));

const service = {
  getStakedHolders: jest.fn(),
  getTopHolders: jest.fn(),
  getHoldersStats: jest.fn(),
  getHolderByAddress: jest.fn(),
};
jest.mock('../../../src/services/staking/stakedHolders.service', () => {
  const actual = jest.requireActual('../../../src/services/staking/stakedHolders.service');
  return { ...actual, StakedHoldersService: { getInstance: () => service } };
});

import router from '../../../src/routes/staking/stakedHolders.routes';
import { StakedHoldersUnavailableError } from '../../../src/services/staking/stakedHolders.service';

function buildApp() {
  const app = express();
  app.use('/staking/holders', router);
  return app;
}

describe('GET /staking/holders', () => {
  beforeEach(() => {
    for (const fn of Object.values(service)) fn.mockReset();
  });

  it.each([
    ['/staking/holders', 'getStakedHolders'],
    ['/staking/holders/top', 'getTopHolders'],
    ['/staking/holders/stats', 'getHoldersStats'],
    ['/staking/holders/0xabc', 'getHolderByAddress'],
  ] as const)('answers 503 STAKED_HOLDERS_UNAVAILABLE on %s while no list can be read', async (path, method) => {
    service[method].mockRejectedValue(new StakedHoldersUnavailableError());
    const res = await request(buildApp()).get(path);
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('30');
    expect(res.body).toEqual({
      success: false,
      error: 'Staked holders temporarily unavailable',
      code: 'STAKED_HOLDERS_UNAVAILABLE',
    });
  });

  it('keeps 500 for anything else', async () => {
    service.getStakedHolders.mockRejectedValue(new Error('Page must be greater than 0'));
    const res = await request(buildApp()).get('/staking/holders?page=0');
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('STAKED_HOLDERS_ERROR');
  });
});
