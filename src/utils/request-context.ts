import { AsyncLocalStorage } from 'async_hooks';
import type { NextFunction, Request, Response } from 'express';
import { rateLimitKeyForIp } from './client-ip';
import { UpstreamBudgetExceededError } from '../errors/upstreamBudget.errors';

/** Where a client stands against its budget of billed HypeDexer calls (see peekUpstreamBudget). */
export interface UpstreamBudgetState {
  /** At or over a limit of the minute or hour window. */
  exhausted: boolean;
  /** When exhausted: seconds until the window that refused rolls over (the longer one when both did), at most 60. */
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
 * How long a request whose client dropped the connection (a 'close' without a
 * 'finish') stays the upstream caller: one upstream timeout. Express keeps
 * running the handler after the client is gone, so an over-budget client that
 * resets right after entry would otherwise get its cold recompute started
 * with no caller at all, neither refused nor counted. Past this the handler
 * has either ended or is long past what a request can still be doing.
 */
export const ABORT_GRACE_MS = 30_000;

/**
 * Runs `next` for an Express request with its client as the upstream caller.
 *
 * Set only on routes whose cache keys the caller picks (passthrough and
 * per-address limiters): there a fresh key is a billed HypeDexer call. The
 * client's budget is read once here (`peek`: no increment) and the verdict is
 * kept for the whole request. The context closes when the response finishes,
 * or ABORT_GRACE_MS after the connection drops without a finish, because
 * anything started inside a request keeps its async context for good: a timer
 * or poller lazily created by the first visitor to a page must never spend
 * that visitor's budget, and a background refresh that outlives the response
 * is not theirs to pay for either. The grace (not an immediate close on a
 * drop) keeps the handler chain of an aborted request refused or counted.
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
  let graceTimer: NodeJS.Timeout | undefined;
  const close = (): void => {
    if (graceTimer) clearTimeout(graceTimer);
    caller.open = false;
  };
  // Connection dropped without the response finishing: the handler is still
  // running, so the caller stays for the grace and then closes.
  const aborted = (): void => {
    if (!caller.open || graceTimer) return;
    graceTimer = setTimeout(close, ABORT_GRACE_MS);
    graceTimer.unref();
  };
  res.once('finish', close);
  res.once('close', aborted);
  // The peek above was awaited: the response may have finished, or the client
  // may have dropped, before these listeners existed, and an event that already
  // fired never comes again. (req.destroyed is true for any fully read request,
  // so the socket is what tells a dropped client.)
  if (res.writableFinished) close();
  else if (res.destroyed || req.socket?.destroyed) aborted();
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
