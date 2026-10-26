/**
 * Hyperfolio proxy errors. Same plain-Error + statusCode + code pattern as
 * defillama.errors.ts so the route helper can map them 1:1 to HTTP.
 */
export class HyperfolioError extends Error {
  public statusCode: number;
  public code: string;

  constructor(message: string, statusCode = 502, code = 'HYPERFOLIO_ERROR') {
    super(message);
    this.name = 'HyperfolioError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

/** `HYPERFOLIO_API_KEY` is not set on this instance. */
export class HyperfolioNotConfiguredError extends HyperfolioError {
  constructor(message = 'Hyperfolio integration is not configured') {
    super(message, 503, 'HYPERFOLIO_NOT_CONFIGURED');
  }
}

/**
 * Upstream throttled us. Hyperfolio answers 403 "Per-second request limit
 * exceeded" for the burst limit and 429 for quota limits; both surface as 429.
 */
export class HyperfolioRateLimitedError extends HyperfolioError {
  constructor(message = 'Hyperfolio rate limit reached, retry shortly') {
    super(message, 429, 'HYPERFOLIO_RATE_LIMITED');
  }
}

/**
 * Our own guard refused the call before it reached Hyperfolio: the process-wide
 * upstream budget is saturated (HyperfolioClient's UpstreamThrottle), or this
 * caller spent its per-IP budget (see HyperfolioClientThrottledError). Same 429
 * + code as an upstream throttle so the frontend treats both alike, but a
 * distinct class so it does NOT open the shared cooldown (one noisy client must
 * not lock everyone else out). It carries no `callerRefusal` marker: the
 * saturation is shared by every visitor, so the cache keeps its failure
 * memory for it (see HyperfolioClientThrottledError for the per-client case).
 */
export class HyperfolioThrottledError extends HyperfolioError {
  constructor(message = 'Too many Hyperfolio lookups, retry shortly') {
    super(message, 429, 'HYPERFOLIO_RATE_LIMITED');
  }
}

/**
 * This caller alone spent its per-IP budget of cache-missing lookups. A
 * `callerRefusal`: the key is fine, so the cache must not leave a failure
 * marker behind it that the other visitors of the key would hit. The
 * process-wide saturation stays a plain HyperfolioThrottledError.
 */
export class HyperfolioClientThrottledError extends HyperfolioThrottledError {
  readonly callerRefusal = true;
}

/**
 * Today's global budget of upstream calls is spent (see hyperfolio.quota.ts).
 * Our own guard, like the throttle: it must not open the circuit breaker.
 */
export class HyperfolioQuotaExhaustedError extends HyperfolioError {
  constructor(message = 'Hyperfolio data is temporarily unavailable') {
    super(message, 503, 'HYPERFOLIO_QUOTA_EXHAUSTED');
  }
}

/**
 * Upstream rejected the input (HTTP 200 with a body-level `error`, or 400):
 * unsupported address form or an unresolvable .hype/.hl domain.
 */
export class HyperfolioBadInputError extends HyperfolioError {
  constructor(message = 'Unsupported address or unresolvable domain') {
    super(message, 400, 'HYPERFOLIO_BAD_INPUT');
  }
}

/** Upstream key rejected — misconfiguration on our side, not the caller's. */
export class HyperfolioUnauthorizedError extends HyperfolioError {
  constructor(message = 'Hyperfolio rejected the API key') {
    super(message, 502, 'HYPERFOLIO_UNAUTHORIZED');
  }
}

/** Upstream failed transiently or returned an unexpected status. */
export class HyperfolioUpstreamError extends HyperfolioError {
  constructor(message = 'Hyperfolio upstream error') {
    super(message, 502, 'HYPERFOLIO_UPSTREAM_ERROR');
  }
}
