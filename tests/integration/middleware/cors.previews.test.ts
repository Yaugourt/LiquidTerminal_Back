/**
 * The front's preview deployments read the API from a browser and change nothing through it.
 * Our own pages, requests without an Origin and other sites: as before.
 */
import express from 'express';
import request from 'supertest';

jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { corsMiddleware, previewReadOnly } from '../../../src/middleware/cors.middleware';
import { errorHandler } from '../../../src/middleware/error.middleware';
import { SECURITY_CONSTANTS } from '../../../src/constants/security.constants';

const SITE = 'https://liquidterminal.xyz';
const PREVIEW = `https://${SECURITY_CONSTANTS.PREVIEW_PROJECT}-59mwf5195-${SECURITY_CONSTANTS.PREVIEW_SCOPE}.vercel.app`;
const OTHER = 'https://evil.example';

/** Methods that reached a route. */
let reached: string[] = [];

function buildApp(): express.Express {
  const app = express();
  app.use(corsMiddleware);
  app.use(previewReadOnly);
  // Stands for the body parsers: a refused write must not get here.
  app.use((req, _res, next) => {
    reached.push(`${req.method} ${req.path}`);
    next();
  });
  app.all(['/wallet', '/elysium/rpc', '/elysium/rpc/other', '/market/perp'], (_req, res) => {
    res.json({ success: true });
  });
  app.use(errorHandler);
  return app;
}

describe('CORS', () => {
  const app = buildApp();
  beforeEach(() => {
    reached = [];
  });

  describe('a preview deployment', () => {
    it('reads, without credentials', async () => {
      const res = await request(app).get('/market/perp').set('Origin', PREVIEW);
      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe(PREVIEW);
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
      expect(res.headers['access-control-expose-headers']).toContain('Retry-After');
      expect(res.headers.vary).toContain('Origin');
    });

    it('may send the headers the front sends (preflight of a read)', async () => {
      const res = await request(app)
        .options('/market/perp')
        .set('Origin', PREVIEW)
        .set('Access-Control-Request-Method', 'GET')
        .set('Access-Control-Request-Headers', 'authorization,x-request-id');
      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe(PREVIEW);
      expect(res.headers['access-control-allow-headers']).toContain('Authorization');
    });

    it.each(['post', 'put', 'patch', 'delete'] as const)('cannot %s, and its page can read why', async (method) => {
      const res = await request(app)[method]('/wallet').set('Origin', PREVIEW).set('Authorization', 'Bearer token').send({ a: 1 });
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ success: false, error: expect.any(String), code: 'PREVIEW_READ_ONLY' });
      expect(res.headers['access-control-allow-origin']).toBe(PREVIEW);
      expect(reached).toEqual([]);
    });

    it('cannot write with a request that asks no preflight either', async () => {
      const res = await request(app).post('/wallet').set('Origin', PREVIEW).set('Content-Type', 'text/plain').send('x');
      expect(res.status).toBe(403);
      expect(reached).toEqual([]);
    });

    it('reads the Elysium chain through the JSON-RPC proxy, which is a POST, and nothing else that way', async () => {
      expect((await request(app).post('/elysium/rpc').set('Origin', PREVIEW).send({})).status).toBe(200);
      expect((await request(app).post('/elysium/rpc/').set('Origin', PREVIEW).send({})).status).toBe(200);
      expect((await request(app).post('/elysium/rpc/other').set('Origin', PREVIEW).send({})).status).toBe(403);
      expect((await request(app).delete('/elysium/rpc').set('Origin', PREVIEW)).status).toBe(403);
    });
  });

  it.each(['get', 'post', 'put', 'patch', 'delete'] as const)('our own pages %s as before', async (method) => {
    const res = await request(app)[method]('/wallet').set('Origin', SITE);
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(SITE);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('a request without an Origin (the bot, a script, the server side of the front) is not touched', async () => {
    const res = await request(app).post('/wallet').send({ a: 1 });
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it.each(['get', 'post', 'options'] as const)('another site cannot %s', async (method) => {
    const res = await request(app)[method]('/market/perp').set('Origin', OTHER);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ success: false, code: 'CORS_BLOCKED' });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(reached).toEqual([]);
  });
});
