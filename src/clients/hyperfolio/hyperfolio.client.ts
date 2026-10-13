import { BaseApiService, HttpApiError } from '../../core/base.api.service';
import { CircuitBreakerService } from '../../core/circuit.breaker.service';
import { RateLimiterService } from '../../core/hyperLiquid.ratelimiter.service';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { maskSensitiveUrl } from '../../utils/url-masking';
import {
  HYPERFOLIO_API_KEY,
  HYPERFOLIO_API_URL,
  hyperfolioJsonHeaders,
  isHyperfolioConfigured,
} from './hyperfolio-api.config';
import { consumeHyperfolioDailyBudget } from './hyperfolio.quota';
import {
  HyperfolioBadInputError,
  HyperfolioError,
  HyperfolioNotConfiguredError,
  HyperfolioQuotaExhaustedError,
  HyperfolioRateLimitedError,
  HyperfolioThrottledError,
  HyperfolioUnauthorizedError,
  HyperfolioUpstreamError,
} from '../../errors/hyperfolio.errors';
import {
  HyperfolioCompositionResponse,
  HyperfolioErrorBody,
  HyperfolioNftsQuery,
  HyperfolioNftsResponse,
  HyperfolioPointsResponse,
  HyperfolioPortfolioHistoryResponse,
  HyperfolioPositionsResponse,
  HyperfolioTransactionsQuery,
  HyperfolioTransactionsResponse,
  HyperfolioYieldQuery,
  HyperfolioYieldResponse,
} from '../../types/hyperfolio.types';

/** Default upstream timeout for the fast wallet/yield endpoints. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Cold `/wallet/transactions` fetches were measured at 33 s upstream. */
const TRANSACTIONS_TIMEOUT_MS = 45_000;

/** Blocking `/positions` fans out to 30+ protocols upstream. */
const POSITIONS_TIMEOUT_MS = 60_000;

/**
 * Process-wide ceiling on calls sent to Hyperfolio. Its per-second burst limit
 * (~20 req/s per key) is shared by every visitor, so one client busting the
 * cache (random `search`, many wallets) must not be able to push the whole key
 * into the 403/429 zone. Kept well under the upstream limit because the stream
 * route and the JSON routes draw from the same budget. Per process: with N
 * backend instances the effective ceiling is N × this value.
 */
const UPSTREAM_MAX_PER_SECOND = 8;
/** How long a call may queue for a free upstream slot before failing fast. */
const UPSTREAM_MAX_WAIT_MS = 2_000;

/** Upstream burst limit answers 403 with this message (not 429). */
const BURST_LIMIT_MESSAGE = /limit exceeded/i;

/**
 * Single-flight map: identical GETs issued while one is in-flight share the
 * same promise so a page that mounts several panels at once does not fan out
 * into duplicate upstream calls (same idea as HypeDexerBaseClient).
 */
const inFlight: Map<string, Promise<unknown>> = new Map();

/** Serialise query values, repeating array params (`categories=a&categories=b`). */
export function buildHyperfolioQuery(
  params: Record<string, string | number | boolean | string[] | undefined>
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      value.forEach((item) => search.append(key, String(item)));
    } else {
      search.append(key, String(value));
    }
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

/** Sliding one-second window over outbound Hyperfolio calls (all routes). */
class UpstreamThrottle {
  private stamps: number[] = [];

  constructor(private readonly maxPerSecond: number, private readonly maxWaitMs: number) {}

  public async acquire(): Promise<void> {
    const deadline = Date.now() + this.maxWaitMs;
    for (;;) {
      const now = Date.now();
      while (this.stamps.length > 0 && now - this.stamps[0] >= 1_000) this.stamps.shift();
      if (this.stamps.length < this.maxPerSecond) {
        this.stamps.push(now);
        return;
      }
      const wait = 1_000 - (now - this.stamps[0]) + 5;
      if (now + wait > deadline) {
        throw new HyperfolioThrottledError();
      }
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

function isBurstLimit(error: unknown): boolean {
  return (
    error instanceof HttpApiError &&
    error.statusCode === 403 &&
    BURST_LIMIT_MESSAGE.test(error.responseBody ?? '')
  );
}

/**
 * Failures the caller or the quota caused, not a sick upstream. They must not
 * count toward the circuit breaker: otherwise five requests for an
 * unresolvable `.hype` name would open it and cut Hyperfolio for everyone.
 */
function isCallerSideFailure(error: unknown, slowEndpoint: boolean): boolean {
  if (
    error instanceof HyperfolioBadInputError ||
    error instanceof HyperfolioThrottledError ||
    error instanceof HyperfolioQuotaExhaustedError
  ) {
    return true;
  }
  if (error instanceof HttpApiError) {
    if (isBurstLimit(error)) return true;
    // 401/403 mean our key is rejected — a real outage for everyone. Any other
    // 4xx is about this request's input (odd page, unknown wallet…).
    return error.statusCode >= 400 && error.statusCode < 500 && error.statusCode !== 401 && error.statusCode !== 403;
  }
  // A cold per-wallet scan (transactions, positions) can outlast its timeout
  // on one heavy wallet while upstream is healthy; callers can pick such
  // wallets on purpose, so those timeouts must not open the breaker.
  return slowEndpoint && isTimeout(error);
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.message === 'Request timeout';
}

function isErrorBody(payload: unknown): payload is HyperfolioErrorBody {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    typeof (payload as { error?: unknown }).error === 'string'
  );
}

/**
 * Hyperfolio REST client (HyperEVM wallet analytics + ecosystem yields).
 * On-demand only, no polling: every read goes through the service cache.
 */
export class HyperfolioClient extends BaseApiService {
  private static instance: HyperfolioClient;
  private static readonly REQUEST_WEIGHT = 10;
  /**
   * 120 upstream misses a minute per IP: a wallet page costs ~6 (composition,
   * positions, history, transactions, nfts, points), so ~20 uncached wallets
   * a minute behind one address (CGNAT, offices). The ceilings that protect
   * the key are the process-wide 8/s and the daily budget; past this one the
   * service serves the last copy instead of an error.
   */
  private static readonly MAX_WEIGHT_PER_MINUTE = 1_200;

  private circuitBreaker: CircuitBreakerService;
  private rateLimiter: RateLimiterService;
  private throttle = new UpstreamThrottle(UPSTREAM_MAX_PER_SECOND, UPSTREAM_MAX_WAIT_MS);

  private constructor() {
    super(HYPERFOLIO_API_URL, hyperfolioJsonHeaders);
    this.circuitBreaker = CircuitBreakerService.getInstance('hyperfolio', {
      maxFailures: 5,
      circuitBreakerTimeout: 30_000,
    });
    this.rateLimiter = RateLimiterService.getInstance('hyperfolio', {
      maxWeightPerMinute: HyperfolioClient.MAX_WEIGHT_PER_MINUTE,
      requestWeight: HyperfolioClient.REQUEST_WEIGHT,
    });
  }

  public static getInstance(): HyperfolioClient {
    if (!HyperfolioClient.instance) {
      HyperfolioClient.instance = new HyperfolioClient();
    }
    return HyperfolioClient.instance;
  }

  /**
   * Per-IP budget of upstream (cache-missing) lookups — 120 per minute with the
   * weights above. Cache hits never reach this, so browsing cached wallets is
   * free; only fan-out that actually costs Hyperfolio quota is metered.
   */
  public checkRateLimit(ip: string): boolean {
    return this.rateLimiter.checkRateLimit(ip);
  }

  /**
   * Translate transport failures into Hyperfolio domain errors. Client-facing
   * messages stay generic: transport details (DNS, socket, breaker state) are
   * logged here, never echoed to the browser.
   */
  public static toDomainError(error: unknown): Error {
    if (error instanceof HyperfolioError) return error;
    if (error instanceof HttpApiError) {
      if (error.statusCode === 429 || isBurstLimit(error)) return new HyperfolioRateLimitedError();
      if (error.statusCode === 401 || error.statusCode === 403) return new HyperfolioUnauthorizedError();
      if (error.statusCode === 400) return new HyperfolioBadInputError();
      return new HyperfolioUpstreamError(`Hyperfolio answered ${error.statusCode}`);
    }
    logDeduplicator.warn('Hyperfolio transport failure', {
      error: error instanceof Error ? error.message : String(error),
    });
    return new HyperfolioUpstreamError();
  }

  private assertConfigured(): void {
    if (!isHyperfolioConfigured()) {
      throw new HyperfolioNotConfiguredError();
    }
  }

  /** Wait for a slot in the process-wide upstream budget (or fail fast). */
  public acquireUpstreamSlot(): Promise<void> {
    return this.throttle.acquire();
  }

  /**
   * GET through the circuit breaker with single-flight dedup. A 200 whose
   * body carries `error` (bad address, unresolvable domain) is a 400 for us.
   * Caller-side failures (bad input, throttles) are carried out of the breaker
   * as values so they never count as upstream failures.
   */
  private async getPath<T>(path: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<T> {
    this.assertConfigured();
    const key = `GET ${path}`;
    const existing = inFlight.get(key);
    if (existing) {
      return existing as Promise<T>;
    }

    const promise = (async (): Promise<T> => {
      try {
        const outcome = await this.circuitBreaker.execute(async () => {
          logDeduplicator.info('HyperfolioClient', { path: maskSensitiveUrl(path) });
          try {
            const payload = await this.getWithBurstRetry<unknown>(path, timeoutMs);
            if (isErrorBody(payload)) {
              logDeduplicator.info('Hyperfolio rejected input', { path: maskSensitiveUrl(path), error: payload.error });
              return { ok: false as const, error: new HyperfolioBadInputError() };
            }
            return { ok: true as const, payload: payload as T };
          } catch (error) {
            if (isCallerSideFailure(error, timeoutMs > DEFAULT_TIMEOUT_MS)) return { ok: false as const, error };
            throw error;
          }
        });
        if (!outcome.ok) throw outcome.error;
        return outcome.payload;
      } catch (error) {
        throw HyperfolioClient.toDomainError(error);
      }
    })();

    inFlight.set(key, promise);
    promise
      .finally(() => {
        inFlight.delete(key);
      })
      .catch(() => {
        // swallow — the original promise still rejects to the caller
      });
    return promise;
  }

  /**
   * One attempt, plus a single retry after the per-second burst 403. Never the
   * generic `withRetry` of BaseApiService: it replays 429s and timeouts up to
   * three times, which multiplies load on a throttled upstream and can hold a
   * request for minutes (3 × 45 s on a cold transactions fetch).
   */
  private async getWithBurstRetry<T>(path: string, timeoutMs: number): Promise<T> {
    await this.acquireUpstream();
    try {
      return await this.getSingleAttempt<T>(path, timeoutMs);
    } catch (error) {
      if (!isBurstLimit(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      await this.acquireUpstream();
      return this.getSingleAttempt<T>(path, timeoutMs);
    }
  }

  /** Every outbound call: per-second slot, then one unit of the daily budget. */
  private async acquireUpstream(): Promise<void> {
    await this.throttle.acquire();
    await consumeHyperfolioDailyBudget();
  }

  /** `GET /wallet/composition` — HyperEVM token balances. */
  public getComposition(address: string): Promise<HyperfolioCompositionResponse> {
    return this.getPath<HyperfolioCompositionResponse>(
      `/wallet/composition${buildHyperfolioQuery({ address })}`
    );
  }

  /** `GET /positions` — DeFi positions grouped by protocol (blocking variant). */
  public getPositions(address: string): Promise<HyperfolioPositionsResponse> {
    return this.getPath<HyperfolioPositionsResponse>(
      `/positions${buildHyperfolioQuery({ address })}`,
      POSITIONS_TIMEOUT_MS
    );
  }

  /** `GET /portfolio-history` — daily net-worth snapshots (0x address only). */
  public getPortfolioHistory(address: string, days: number): Promise<HyperfolioPortfolioHistoryResponse> {
    return this.getPath<HyperfolioPortfolioHistoryResponse>(
      `/portfolio-history${buildHyperfolioQuery({ address, days })}`
    );
  }

  /** `GET /wallet/transactions` — decoded EVM transactions, paginated. */
  public getTransactions(
    address: string,
    query: HyperfolioTransactionsQuery
  ): Promise<HyperfolioTransactionsResponse> {
    return this.getPath<HyperfolioTransactionsResponse>(
      `/wallet/transactions${buildHyperfolioQuery({ address, ...query })}`,
      TRANSACTIONS_TIMEOUT_MS
    );
  }

  /** `GET /nfts` — wallet NFTs sorted by price, paginated. */
  public getNfts(address: string, query: HyperfolioNftsQuery): Promise<HyperfolioNftsResponse> {
    return this.getPath<HyperfolioNftsResponse>(`/nfts${buildHyperfolioQuery({ address, ...query })}`);
  }

  /** `GET /points` — farming points per protocol. */
  public getPoints(address: string): Promise<HyperfolioPointsResponse> {
    return this.getPath<HyperfolioPointsResponse>(`/points${buildHyperfolioQuery({ address })}`);
  }

  /** `GET /yield` — ecosystem yield opportunities with filters, sort and pagination. */
  public getYield(query: HyperfolioYieldQuery): Promise<HyperfolioYieldResponse> {
    return this.getPath<HyperfolioYieldResponse>(`/yield${buildHyperfolioQuery({ ...query })}`);
  }

  /**
   * `GET /positions/stream` — opens the upstream SSE connection and hands the
   * raw body back to the caller, which is responsible for piping and closing.
   * Bypasses BaseApiService (JSON-only) on purpose; the key is still attached.
   */
  public async openPositionsStream(
    address: string,
    signal: AbortSignal
  ): Promise<ReadableStream<Uint8Array>> {
    this.assertConfigured();
    const url = `${HYPERFOLIO_API_URL}/positions/stream${buildHyperfolioQuery({ address })}`;
    await this.acquireUpstream();
    let response: globalThis.Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        signal,
        headers: {
          Accept: 'text/event-stream',
          'User-Agent': hyperfolioJsonHeaders['User-Agent'],
          'x-api-key': HYPERFOLIO_API_KEY ?? '',
        },
      });
    } catch (error) {
      throw HyperfolioClient.toDomainError(error);
    }
    if (!response.ok || !response.body) {
      const body = await response.text().catch(() => '');
      throw HyperfolioClient.toDomainError(
        new HttpApiError(`API error: ${response.status}`, response.status, body)
      );
    }
    return response.body;
  }
}
