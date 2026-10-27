/**
 * GET /export/:dataset — a file cut at the row ceiling says so in its headers,
 * and a file that is complete does not.
 */
import type { NextFunction, Request, Response } from 'express';
import express from 'express';
import request from 'supertest';

const pass = (_req: Request, _res: Response, next: NextFunction): void => next();

jest.mock('../../../src/middleware/apiRateLimiter', () => ({ marketRateLimiter: pass }));
jest.mock('../../../src/middleware/authMiddleware', () => ({
  validatePrivyToken: (req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { currentUser: { id: number } }).currentUser = { id: 1 };
    next();
  },
}));
jest.mock('../../../src/middleware/roleMiddleware', () => ({ requireUser: pass }));
jest.mock('../../../src/middleware/exportRateLimiter', () => ({
  exportRateLimiter: pass,
  exportPreviewRateLimiter: pass,
  recordExport: jest.fn(),
  releaseExport: jest.fn(),
  getExportQuota: jest.fn(),
}));
jest.mock('../../../src/core/redis.service', () => ({ redisService: { getClient: () => ({}) } }));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockFetchPage = jest.fn();
jest.mock('../../../src/clients/hypedexer/rest/export/export-passthrough.client', () => ({
  ExportPassthroughClient: { getInstance: () => ({ fetchPage: mockFetchPage }) },
}));

import exportRoutes from '../../../src/routes/export/export.routes';
import { EXPORT_MAX_ROWS } from '../../../src/constants/export.constants';

const app = express();
app.use('/export', exportRoutes);

/** Serves `total` rows, `limit` at a time, and reports the total like HypeDexer's envelope. */
function serve(total: number): void {
  mockFetchPage.mockImplementation(async (_path: string, params: { limit: number; offset?: number }) => {
    const start = params.offset ?? 0;
    const n = Math.max(0, Math.min(params.limit, total - start));
    return {
      rows: Array.from({ length: n }, (_, i) => ({ tid: start + i })),
      nextCursor: null,
      hasMore: start + n < total,
      totalCount: total,
    };
  });
}

describe('GET /export/:dataset truncation signal', () => {
  beforeEach(() => mockFetchPage.mockReset());

  it('flags a file cut at the row ceiling, before the body starts', async () => {
    serve(EXPORT_MAX_ROWS + 1234);

    const res = await request(app).get('/export/perp-fills').buffer(true).parse((r, cb) => {
      let size = 0;
      r.on('data', (c: Buffer) => (size += c.length));
      r.on('end', () => cb(null, size));
    });

    expect(res.status).toBe(200);
    expect(res.headers['x-export-truncated']).toBe('true');
    expect(res.headers['x-export-total-rows']).toBe(String(EXPORT_MAX_ROWS + 1234));
  });

  it('does not flag a file that holds everything', async () => {
    serve(1200);

    const res = await request(app).get('/export/perp-fills');

    expect(res.status).toBe(200);
    expect(res.headers['x-export-truncated']).toBeUndefined();
    expect(res.text.trim().split('\n')).toHaveLength(1 + 1200);
  });

  it('does not flag a file with exactly the ceiling', async () => {
    serve(EXPORT_MAX_ROWS);

    const res = await request(app).get('/export/perp-fills').buffer(true).parse((r, cb) => {
      r.on('data', () => undefined);
      r.on('end', () => cb(null, ''));
    });

    expect(res.headers['x-export-truncated']).toBeUndefined();
  });
});
