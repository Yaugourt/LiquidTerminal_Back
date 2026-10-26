import { AsyncLocalStorage } from 'async_hooks';
import type { NextFunction, Request, Response } from 'express';
import { rateLimitKeyForIp } from './client-ip';

/**
 * The client a billed upstream call is made for: the per-IP key its budget is
 * counted under (see spendUpstreamBudget). `open` is true while its request
 * is still being answered.
 */
export interface UpstreamCaller {
  ipKey: string;
  open: boolean;
}

const storage = new AsyncLocalStorage<UpstreamCaller>();

/**
 * Runs `next` for an Express request with its client as the upstream caller.
 *
 * Set only on routes whose cache keys the caller picks (passthrough and
 * per-address limiters): there a fresh key is a billed HypeDexer call. The
 * context closes when the response finishes or the connection drops, because
 * anything started inside a request keeps its async context for good: a timer
 * or poller lazily created by the first visitor to a page must never spend
 * that visitor's budget, and a background refresh that outlives the response
 * is not theirs to pay for either.
 */
export function runWithUpstreamCaller(req: Request, res: Response, next: NextFunction): void {
  // Two limiters on one route (passthrough, then per-address) share one caller.
  if (currentUpstreamCaller()) {
    next();
    return;
  }
  const caller: UpstreamCaller = { ipKey: rateLimitKeyForIp(req.ip ?? ''), open: true };
  const close = (): void => {
    caller.open = false;
  };
  res.once('finish', close);
  res.once('close', close);
  storage.run(caller, next);
}

/** The client of the request being answered, or undefined outside one (pollers, timers, a finished request). */
export function currentUpstreamCaller(): UpstreamCaller | undefined {
  const caller = storage.getStore();
  return caller?.open ? caller : undefined;
}
