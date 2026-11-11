/**
 * Ensures GET /elysium/analytics/* passes validateGetRequest (no Zod "body"
 * error), applies query defaults/bounds, and maps failures to fixed codes.
 * The analytics service is mocked so no database is touched.
 */
import type { NextFunction, Request, Response } from 'express';
import express from 'express';
import request from 'supertest';

jest.mock('../../../src/middleware/apiRateLimiter', () => ({
  marketRateLimiter: (_req: Request, _res: Response, next: NextFunction) => {
    next();
  },
  passthroughRateLimiter: (_req: Request, _res: Response, next: NextFunction) => {
    next();
  },
}));

jest.mock('../../../src/core/redis.service', () => ({
  redisService: {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    getClient: jest.fn(),
  },
}));

// Who may read a route: the real middlewares open the database and Privy; here a token named
// "admin" is an admin's, and anything else is nobody's.
jest.mock('../../../src/middleware/authMiddleware', () => ({
  validatePrivyToken: (req: Request, res: Response, next: NextFunction) => {
    if (req.headers.authorization === 'Bearer admin') next();
    else res.status(401).json({ success: false, code: 'UNAUTHENTICATED' });
  },
}));
jest.mock('../../../src/middleware/roleMiddleware', () => ({
  requireAdmin: (_req: Request, _res: Response, next: NextFunction) => {
    next();
  },
}));

const mockService = {
  getStatus: jest.fn().mockResolvedValue({ streams: [], credits: { balance: 5 }, database: { bytes: 1 } }),
  getPublicStatus: jest.fn().mockResolvedValue({ streams: [] }),
  getDeployments: jest.fn().mockResolvedValue({ daily: [], topDeployers: [], trending: [] }),
  getContracts: jest.fn().mockResolvedValue({ rows: [] }),
  getUsers: jest.fn().mockResolvedValue({ daily: [] }),
  getBridge: jest.fn().mockResolvedValue({ daily: [] }),
  getEconomics: jest.fn().mockResolvedValue({ daily: [], totals: { feesHype: 0, txs: 0 } }),
  getMethods: jest.fn().mockResolvedValue({ rows: [], names: {} }),
  getDex: jest.fn().mockResolvedValue({ daily: [] }),
  getTokens: jest.fn().mockResolvedValue({ daily: [] }),
  getAddress: jest.fn().mockResolvedValue({ tags: [] }),
  getContract: jest.fn().mockResolvedValue({ deployment: null }),
};

jest.mock('../../../src/services/elysium/elysium-analytics.service', () => ({
  ElysiumAnalyticsService: { getInstance: () => mockService },
}));

// The ecosystem service opens the historical database at import time.
const mockEcosystem = {
  getProjects: jest.fn().mockResolvedValue({ projects: [] }),
};

// So does the launchpad market service (its route has its own test).
jest.mock('../../../src/services/elysium/elysium-launchpad-market.service', () => ({
  ElysiumLaunchpadMarketService: { getInstance: () => ({ getPage: jest.fn().mockResolvedValue({ tokens: [] }) }) },
  LaunchpadBusyError: class extends Error {},
  LaunchpadSearchBusyError: class extends Error {},
}));

jest.mock('../../../src/services/elysium/elysium-ecosystem.service', () => ({
  ElysiumEcosystemService: { getInstance: () => mockEcosystem },
}));

import elysiumAnalyticsRoutes from '../../../src/routes/elysium/elysium-analytics.routes';

function hasBodyValidationError(body: unknown): boolean {
  if (
    typeof body === 'object' &&
    body !== null &&
    'details' in body &&
    Array.isArray((body as { details: unknown }).details)
  ) {
    return (body as { details: Array<{ path?: string }> }).details.some((d) => d.path === 'body');
  }
  return false;
}

const app = express();
app.use('/elysium/analytics', elysiumAnalyticsRoutes);

describe('Elysium analytics GET validation smoke', () => {
  const paths: string[] = [
    '/elysium/analytics/status',
    '/elysium/analytics/deployments',
    '/elysium/analytics/deployments?days=60',
    '/elysium/analytics/contracts',
    '/elysium/analytics/contracts?window=7d',
    '/elysium/analytics/users?days=7',
    '/elysium/analytics/bridge?days=14',
    '/elysium/analytics/economics?days=30',
    '/elysium/analytics/methods',
    '/elysium/analytics/methods?window=7d',
    '/elysium/analytics/dex?days=14',
    '/elysium/analytics/tokens',
    '/elysium/analytics/address/0x1E4f06e89a0c4f0c47f42a78881c8ee357dd628e',
    '/elysium/analytics/contract/0x1E4f06e89a0c4f0c47f42a78881c8ee357dd628e',
  ];

  it.each(paths)('%s — no Zod body validation failure', async (path) => {
    const res = await request(app).get(path);
    expect(hasBodyValidationError(res.body)).toBe(false);
  });

  it.each(paths)('%s — succeeds with mocked service', async (path) => {
    const res = await request(app).get(path);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true });
  });

  it('the public status is the one without the spend and the size of the database; the full one asks for an admin', async () => {
    mockService.getStatus.mockClear();
    const open = await request(app).get('/elysium/analytics/status');
    expect(open.status).toBe(200);
    expect(open.body.data).toEqual({ streams: [] });
    expect(mockService.getStatus).not.toHaveBeenCalled();

    const refused = await request(app).get('/elysium/analytics/status/ops');
    expect(refused.status).toBe(401);
    expect(mockService.getStatus).not.toHaveBeenCalled();

    const ops = await request(app).get('/elysium/analytics/status/ops').set('Authorization', 'Bearer admin');
    expect(ops.status).toBe(200);
    expect(ops.body.data).toEqual({ streams: [], credits: { balance: 5 }, database: { bytes: 1 } });
  });

  it('applies defaults (days=14, window=24h)', async () => {
    await request(app).get('/elysium/analytics/deployments');
    expect(mockService.getDeployments).toHaveBeenLastCalledWith(14);
    await request(app).get('/elysium/analytics/contracts');
    expect(mockService.getContracts).toHaveBeenLastCalledWith('24h');
    await request(app).get('/elysium/analytics/economics?days=7');
    expect(mockService.getEconomics).toHaveBeenLastCalledWith(7);
    await request(app).get('/elysium/analytics/dex');
    expect(mockService.getDex).toHaveBeenLastCalledWith(14);
    await request(app).get('/elysium/analytics/methods');
    expect(mockService.getMethods).toHaveBeenLastCalledWith('24h');
  });

  it('passes the address param through', async () => {
    const a = '0x1e4f06e89a0c4f0c47f42a78881c8ee357dd628e';
    await request(app).get(`/elysium/analytics/address/${a}`);
    expect(mockService.getAddress).toHaveBeenLastCalledWith(a);
    await request(app).get(`/elysium/analytics/contract/${a}`);
    expect(mockService.getContract).toHaveBeenLastCalledWith(a);
  });
});

describe('Elysium analytics query validation', () => {
  const invalid: string[] = [
    '/elysium/analytics/deployments?days=0',
    '/elysium/analytics/deployments?days=61',
    '/elysium/analytics/users?days=1',
    '/elysium/analytics/dex?days=15',
    '/elysium/analytics/economics?days=59',
    '/elysium/analytics/users?days=abc',
    '/elysium/analytics/bridge?days=1.5',
    '/elysium/analytics/economics?days=-1',
    '/elysium/analytics/contracts?window=30d',
    '/elysium/analytics/methods?window=1h',
    '/elysium/analytics/tokens?days=0',
    '/elysium/analytics/address/0x123',
    '/elysium/analytics/address/not-an-address',
    '/elysium/analytics/contract/0x123',
  ];

  it.each(invalid)('%s — returns 400', async (path) => {
    const res = await request(app).get(path);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'Validation Error' });
  });
});

describe('Elysium analytics failure mapping', () => {
  it('maps a database error to 503 with a fixed code', async () => {
    const err = new Error('connection refused');
    err.name = 'PrismaClientKnownRequestError';
    mockService.getUsers.mockRejectedValueOnce(err);
    const res = await request(app).get('/elysium/analytics/users');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      success: false,
      error: 'Analytics unavailable',
      code: 'ELYSIUM_ANALYTICS_USERS_ERROR',
    });
  });

  it('maps any other error to 502 with a fixed code', async () => {
    mockService.getBridge.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).get('/elysium/analytics/bridge');
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ success: false, code: 'ELYSIUM_ANALYTICS_BRIDGE_ERROR' });
  });
});

describe('Elysium analytics scheduled views', () => {
  it('answers a scheduled view with the time it is as of and how often it is computed', async () => {
    const { ViewResult } = jest.requireActual('../../../src/core/viewScheduler') as typeof import('../../../src/core/viewScheduler');
    mockService.getEconomics.mockResolvedValueOnce(new ViewResult({ daily: [1, 2] }, '2026-11-11T13:00:00.000Z', 60));
    const res = await request(app).get('/elysium/analytics/economics');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { daily: [1, 2] }, computedAt: '2026-11-11T13:00:00.000Z', refreshEveryS: 60 });
  });

  it('keeps the plain envelope for a read that is not a scheduled view', async () => {
    const res = await request(app).get(`/elysium/analytics/address/0x${'ab'.repeat(20)}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { tags: [] } });
  });

  it('answers 503 with Retry-After while a view has no value yet, without calling it an error of the database', async () => {
    const { ViewWarmingError } = jest.requireActual('../../../src/core/viewScheduler') as typeof import('../../../src/core/viewScheduler');
    mockService.getDex.mockRejectedValueOnce(new ViewWarmingError(5));
    const res = await request(app).get('/elysium/analytics/dex');
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('5');
    expect(res.body).toEqual({ success: false, error: 'Analytics warming up', code: 'ELYSIUM_ANALYTICS_DEX_ERROR' });
  });
});
