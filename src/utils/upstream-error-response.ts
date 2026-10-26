import type { Response } from 'express';
import { UpstreamBudgetExceededError } from '../errors/upstreamBudget.errors';

/**
 * Answers a route's upstream failure. A client refused by its own HypeDexer
 * miss budget is not an upstream outage: it gets the 429 + Retry-After the
 * limiters send (same JSON shape, so the front backs off for the time the
 * header names), plus a code that tells the two apart. Any other error gets
 * the status and body the route passes in, unchanged.
 */
export function sendUpstreamError(
  res: Response,
  error: unknown,
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): void {
  if (error instanceof UpstreamBudgetExceededError) {
    res.setHeader('Retry-After', String(error.retryAfterS));
    res.status(429).json({
      error: 'Rate limit exceeded',
      message: error.message,
      retryAfter: error.retryAfterS,
      code: 'UPSTREAM_BUDGET_EXCEEDED',
    });
    return;
  }
  if (headers) res.set(headers);
  res.status(status).json(body);
}
