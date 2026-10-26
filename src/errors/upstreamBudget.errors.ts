/**
 * A client spent its per-IP budget of billed HypeDexer calls (see
 * spendUpstreamBudget). Our own guard, not an upstream failure: `callerRefusal`
 * tells the cache to leave no failure marker behind it, so one client over its
 * budget does not make every other visitor of the key get the last copy.
 */
export class UpstreamBudgetExceededError extends Error {
  readonly statusCode = 429;
  readonly callerRefusal = true;

  constructor(public readonly retryAfterS: number) {
    super('Too many uncached indexer lookups, retry shortly');
    this.name = 'UpstreamBudgetExceededError';
  }
}

/**
 * True for an error that refuses one caller (its own budget is spent) rather
 * than reporting that the upstream is failing: UpstreamBudgetExceededError,
 * HyperfolioThrottledError. Duck-typed on purpose: the cache must not import
 * the error classes of every domain.
 */
export function isCallerRefusal(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { callerRefusal?: unknown }).callerRefusal === true;
}
