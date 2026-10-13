/**
 * GET /market/token-details/:tokenId — id validation and the status of each
 * service outcome. The service is mocked; its own suite covers the reads.
 */
import type { NextFunction, Request, Response } from 'express';
import express from 'express';
import request from 'supertest';

jest.mock('../../../src/middleware/apiRateLimiter', () => ({
  marketRateLimiter: (_req: Request, _res: Response, next: NextFunction) => {
    next();
  },
}));

jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const getTokenDetails = jest.fn();
jest.mock('../../../src/services/spot/tokenDetails.service', () => {
  const actual = jest.requireActual('../../../src/services/spot/tokenDetails.service');
  return {
    ...actual,
    TokenDetailsService: { getInstance: () => ({ getTokenDetails }) },
  };
});

import tokenDetailsRoutes from '../../../src/routes/spot/tokenDetails.routes';
import {
  TokenDetailsUnavailableError,
  UnknownTokenIdError,
} from '../../../src/services/spot/tokenDetails.service';

const HYPE = '0x0d01dc56dcaaca66ad901c959b4011ec';

function buildApp() {
  const app = express();
  app.use('/market/token-details', tokenDetailsRoutes);
  return app;
}

describe('GET /market/token-details/:tokenId', () => {
  beforeEach(() => {
    getTokenDetails.mockReset();
  });

  it.each([
    ['too short', '0x0d01dc56'],
    ['not hex', '0x0d01dc56dcaaca66ad901c959b4011eg'],
    ['no 0x prefix', '000d01dc56dcaaca66ad901c959b4011ec'],
    ['a name', 'HYPE'],
  ])('rejects an id that is %s', async (_label, id) => {
    const res = await request(buildApp()).get(`/market/token-details/${id}`);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: 'Invalid token id', code: 'INVALID_PARAMS' });
    expect(getTokenDetails).not.toHaveBeenCalled();
  });

  it('serves the summary and the time it was read', async () => {
    const details = { name: 'HYPE', totalSupply: '998878622.6375647783', genesisUserCount: 94023 };
    getTokenDetails.mockResolvedValue({ details, lastUpdate: 1_800_000_000_000 });

    const res = await request(buildApp()).get(`/market/token-details/${HYPE.toUpperCase().replace('0X', '0x')}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: details, lastUpdate: 1_800_000_000_000 });
    expect(getTokenDetails).toHaveBeenCalledWith('0x0D01DC56DCAACA66AD901C959B4011EC', expect.any(String));
  });

  it('answers 404 for an id that is not a spot token', async () => {
    getTokenDetails.mockRejectedValue(new UnknownTokenIdError(HYPE));
    const res = await request(buildApp()).get(`/market/token-details/${HYPE}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('UNKNOWN_TOKEN');
  });

  it('answers 503 while the details cannot be read', async () => {
    getTokenDetails.mockRejectedValue(new TokenDetailsUnavailableError(HYPE));
    const res = await request(buildApp()).get(`/market/token-details/${HYPE}`);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      success: false,
      error: 'Token details temporarily unavailable',
      code: 'TOKEN_DETAILS_UNAVAILABLE',
    });
  });

  it('answers 500 on anything else, without the error text', async () => {
    getTokenDetails.mockRejectedValue(new Error('redis exploded'));
    const res = await request(buildApp()).get(`/market/token-details/${HYPE}`);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ success: false, error: 'Internal server error', code: 'TOKEN_DETAILS_ERROR' });
  });
});
