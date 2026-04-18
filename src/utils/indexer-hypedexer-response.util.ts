/**
 * Shared Express helpers for indexer routes that proxy HypeDexer.
 * Keeps LT `{ success, data }` aligned with a single unwrap contract (see `hypedexer-api-response.util.ts`).
 */
import type { Response } from 'express';
import { unwrapHypeDexerApiPayload } from './hypedexer-api-response.util';

/**
 * Read HypeDexer `total_count` from the raw upstream body before unwrap removes the envelope.
 */
export function readHypeDexerTotalCount(body: unknown): number | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const tc = (body as Record<string, unknown>).total_count;
  return typeof tc === 'number' && Number.isFinite(tc) ? tc : undefined;
}

/**
 * Standard indexer JSON for HypeDexer pass-through: unwrap nested APIResponse so LT `data` is the leaf payload.
 */
export function sendIndexerHypeDexerSuccess(res: Response, upstreamBody: unknown): void {
  res.json({ success: true, data: unwrapHypeDexerApiPayload(upstreamBody) });
}

/**
 * For list endpoints that expose pagination metadata at the envelope root (e.g. gossip history).
 */
export function sendIndexerHypeDexerRowsWithTotalCount(res: Response, upstreamBody: unknown): void {
  const totalCount = readHypeDexerTotalCount(upstreamBody);
  const rows = unwrapHypeDexerApiPayload(upstreamBody);
  res.json({
    success: true,
    data: {
      rows: Array.isArray(rows) ? rows : [],
      total_count: totalCount ?? null,
    },
  });
}
