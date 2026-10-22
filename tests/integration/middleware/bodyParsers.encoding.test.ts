/**
 * The global body parsers run before any auth, so they must never hand an
 * attacker's compressed bytes to zlib (Node CVE-2026-111497, Brotli decoder):
 * any Content-Encoding other than identity gets a 415.
 */
import express from 'express';
import request from 'supertest';
import { brotliCompressSync, deflateSync, gzipSync } from 'zlib';
import { jsonBodyParser, urlencodedBodyParser } from '../../../src/middleware/bodyParsers.middleware';

function buildApp(): express.Express {
  const app = express();
  app.use(jsonBodyParser);
  app.use(urlencodedBodyParser);
  app.post('/echo', (req, res) => {
    res.json({ body: req.body });
  });
  return app;
}

describe('global body parsers', () => {
  const app = buildApp();
  const json = JSON.stringify({ name: 'liquid' });

  it('still parses plain JSON and form bodies', async () => {
    const asJson = await request(app).post('/echo').set('Content-Type', 'application/json').send(json);
    expect(asJson.status).toBe(200);
    expect(asJson.body).toEqual({ body: { name: 'liquid' } });

    const asForm = await request(app)
      .post('/echo')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('name=liquid');
    expect(asForm.status).toBe(200);
    expect(asForm.body).toEqual({ body: { name: 'liquid' } });
  });

  it.each([
    ['br', brotliCompressSync],
    ['gzip', gzipSync],
    ['deflate', deflateSync],
  ])('refuses a %s-encoded JSON body with 415', async (encoding, compress) => {
    const res = await request(app)
      .post('/echo')
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', encoding)
      .send(compress(Buffer.from(json)));
    expect(res.status).toBe(415);
  });

  it('refuses a compressed form body with 415', async () => {
    const res = await request(app)
      .post('/echo')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .set('Content-Encoding', 'br')
      .send(brotliCompressSync(Buffer.from('name=liquid')));
    expect(res.status).toBe(415);
  });
});
