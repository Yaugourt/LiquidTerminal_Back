import cors from 'cors';
import type { NextFunction, Request, Response } from 'express';
import { originAccess } from '../utils/originAccess';
import { logDeduplicator } from '../utils/logDeduplicator';

/**
 * What a browser page of another origin may do with the API: everything for our own pages,
 * reading for a preview deployment of the front, nothing for any other site (see originAccess).
 * A request without an `Origin` is not a page of another site (the bot, a script, the front's
 * server): it goes through, as before.
 */
export const corsMiddleware = cors<Request>((req, callback) => {
  const origin = req.headers.origin;
  const access = origin ? originAccess(origin) : 'full';
  if (access === 'none') {
    logDeduplicator.warn('CORS blocked origin', {
      origin,
      nodeEnv: process.env.NODE_ENV
    });
    callback(new Error('Not allowed by CORS'));
    return;
  }
  callback(null, {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
    // Readable by the front, which backs off for the time a 429 or 503 names, and
    // which tells a CSV cut at the export row ceiling from a complete one.
    exposedHeaders: ['Retry-After', 'X-Export-Truncated', 'X-Export-Total-Rows'],
    credentials: access === 'full'
  });
});

/**
 * POST routes that only read: the Elysium JSON-RPC proxy forwards read-only methods
 * (elysium-rpc.schema.ts). Compared as they are, with and without the last slash: this runs on
 * any path a client can send.
 */
const READ_ONLY_POST_PATHS: ReadonlySet<string> = new Set(['/elysium/rpc', '/elysium/rpc/']);

function isRead(req: Request): boolean {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return true;
  return req.method === 'POST' && READ_ONLY_POST_PATHS.has(req.path);
}

/**
 * A preview deployment talks to the production database (there is no staging), and its address
 * proves nothing about who serves the page: its requests read, whatever its code does. Refused
 * after the CORS headers are set, so that the page can read why. Mounted ahead of the body
 * parsers: a refused write is not even parsed.
 */
export function previewReadOnly(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  if (!origin || originAccess(origin) !== 'read' || isRead(req)) {
    next();
    return;
  }
  res.status(403).json({
    success: false,
    error: 'Preview deployments can read, not write',
    code: 'PREVIEW_READ_ONLY'
  });
}
