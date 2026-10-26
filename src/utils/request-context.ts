import { AsyncLocalStorage } from 'async_hooks';
import type { NextFunction, Request, Response } from 'express';
import { rateLimitKeyForIp } from './client-ip';
import { UpstreamBudgetExceededError } from '../errors/upstreamBudget.errors';

/** Where a client stands against its budget of billed HypeDexer calls (see peekUpstreamBudget). */
export interface UpstreamBudgetState {
  /** At or over a limit of the minute or hour window. */
  exhausted: boolean;
  /** When exhausted: seconds until the window that refused rolls over (the longer one when both did). */
  retryAfterS: number;
}

/**
 * The client a billed upstream call is made for: the per-IP key its budget is
 * counted under (see countUpstreamCall). `open` is true while its request is
 * still being answered. `exhausted` is decided once, when the request enters,
 * and never changes while it runs: a request that starts within budget is
 * served whole, even when the calls it makes (or a shared computation it
 * triggers) take the counter past the limit.
 */
export interface UpstreamCaller extends UpstreamBudgetState {
  ipKey: string;
  open: boolean;
}

const storage = new AsyncLocalStorage<UpstreamCaller>();

/**
 * Runs `next` for an Express request with its client as the upstream caller.
 *
 * Set only on routes whose cache keys the caller picks (passthrough and
 * per-address limiters): there a fresh key is a billed HypeDexer call. The
 * client's budget is read once here (`peek`: no increment) and the verdict is
 * kept for the whole request. The context closes when the response finishes
 * or the connection drops, because anything started inside a request keeps its
 * async context for good: a timer or poller lazily created by the first
 * visitor to a page must never spend that visitor's budget, and a background
 * refresh that outlives the response is not theirs to pay for either.
 *
 * `peek` is passed in (the limiter owns the counters) so this module imports
 * nothing from the middleware.
 */
export async function runWithUpstreamCaller(
  req: Request,
  res: Response,
  next: NextFunction,
  peek: (ipKey: string) => Promise<UpstreamBudgetState>
): Promise<void> {
  // Two limiters on one route (passthrough, then per-address) share one caller.
  if (currentUpstreamCaller()) {
    next();
    return;
  }
  const ipKey = rateLimitKeyForIp(req.ip ?? '');
  let state: UpstreamBudgetState;
  try {
    state = await peek(ipKey);
  } catch {
    // Never block a visitor because the budget could not be read.
    state = { exhausted: false, retryAfterS: 0 };
  }
  const caller: UpstreamCaller = { ipKey, open: true, exhausted: state.exhausted, retryAfterS: state.retryAfterS };
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

/**
 * The refusal to throw before starting new upstream work for this caller, or
 * undefined: the caller is within budget, or there is none (pollers, the
 * export, a finished request). Checked only where work would START (a cache
 * recompute, an uncached call); work that is already running is joined, never
 * refused.
 */
export function upstreamRefusal(): UpstreamBudgetExceededError | undefined {
  const caller = currentUpstreamCaller();
  return caller?.exhausted ? new UpstreamBudgetExceededError(caller.retryAfterS) : undefined;
}
