/**
 * validateRequest must hand the handler the body Zod validated, not the raw
 * one: handlers spread req.body into writes, so a key the schema does not
 * declare (status, reviewerId…) would otherwise reach the database.
 */
jest.mock('../../../src/core/redis.service', () => ({
  redisService: { get: jest.fn(), set: jest.fn() },
}));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { Request, Response } from 'express';
import { z } from 'zod';
import { validateRequest } from '../../../src/middleware/validation/validation.middleware';

async function run(schema: z.ZodObject, body: unknown) {
  const req = { body, query: {}, params: {}, path: '/x', method: 'PUT', originalUrl: '/x' } as unknown as Request;
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as unknown as Response;
  const next = jest.fn();
  await validateRequest(schema)(req, res, next);
  return { req, res, next };
}

describe('validateRequest body', () => {
  const schema = z.object({
    body: z.object({ name: z.string().trim(), tags: z.array(z.string()).optional() }),
  });

  it('strips keys the schema does not declare', async () => {
    const { req, next } = await run(schema, {
      name: '  Liquid ',
      status: 'APPROVED',
      reviewerId: 1,
      submitterId: 2,
    });
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.body).toEqual({ name: 'Liquid' });
  });

  it('does not inject optional keys the client left out', async () => {
    const { req } = await run(schema, { name: 'Liquid' });
    expect(req.body).toEqual({ name: 'Liquid' });
    expect('tags' in req.body).toBe(false);
  });

  it('leaves the body alone when the schema has no body', async () => {
    const raw = { anything: 1 };
    const { req, next } = await run(z.object({ query: z.object({}) }), raw);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.body).toBe(raw);
  });

  it('still answers 400 to an invalid body', async () => {
    const { res, next } = await run(schema, { status: 'APPROVED' });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });
});
