import { logDeduplicator } from '../utils/logDeduplicator';
import { maskSensitiveUrl } from '../utils/url-masking';

/**
 * HTTP API error with status code for granular error handling.
 */
export class HttpApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly responseBody?: string,
    public readonly retryAfter?: string
  ) {
    super(message);
    this.name = 'HttpApiError';
  }

  /** True for 429, 502, 503, 504 — transient errors worth retrying */
  get isRetryable(): boolean {
    return this.statusCode === 429 || (this.statusCode >= 502 && this.statusCode <= 504);
  }

  /** True for 429 — should use longer backoff */
  get isRateLimited(): boolean {
    return this.statusCode === 429;
  }
}

/**
 * Parse the standard HTTP `Retry-After` header value into milliseconds.
 * Accepts either delta-seconds or an HTTP-date. Returns undefined on parse failure.
 */
function parseRetryAfterMs(value: string | undefined | null): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  // delta-seconds form
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.round(seconds * 1000);
    }
  }

  // HTTP-date form
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    const delta = dateMs - Date.now();
    if (delta > 0) return delta;
    return 0;
  }
  return undefined;
}

/**
 * Global cap on concurrent outbound HTTP requests across all API clients.
 * Native fetch has no socket limit: when an upstream slows down, dozens of
 * 30s-timeout requests (plus their retries) pile up and exhaust sockets,
 * which surfaces as "fetch failed" on every client at once.
 */
const MAX_CONCURRENT_OUTBOUND_REQUESTS = 50;
let activeOutboundRequests = 0;
const outboundWaitQueue: Array<() => void> = [];

async function acquireOutboundSlot(): Promise<void> {
  if (activeOutboundRequests < MAX_CONCURRENT_OUTBOUND_REQUESTS) {
    activeOutboundRequests++;
    return;
  }
  await new Promise<void>((resolve) => outboundWaitQueue.push(resolve));
}

function releaseOutboundSlot(): void {
  const next = outboundWaitQueue.shift();
  if (next) {
    // Hand the slot directly to the next waiter; activeOutboundRequests unchanged
    next();
  } else {
    activeOutboundRequests--;
  }
}

export abstract class BaseApiService {
    private readonly API_TIMEOUT = 30000; // 30 secondes au lieu de 5
    private readonly MAX_RETRIES = 3;
    private readonly RETRY_DELAY = 1000; // 1 seconde
    private readonly MAX_RETRY_DELAY_MS = 30_000; // absolute cap per retry

    constructor(
      protected readonly baseUrl: string,
      protected readonly defaultHeaders: Record<string, string> = {
        'Content-Type': 'application/json'
      }
    ) {}

    // Méthode principale pour les requêtes avec timeout
    protected async fetchWithTimeout<T>(
      endpoint: string,
      options: RequestInit,
      timeoutMs: number = this.API_TIMEOUT
    ): Promise<T> {
      const fullUrl = `${this.baseUrl}${endpoint}`;
      const safeUrl = maskSensitiveUrl(fullUrl);

      logDeduplicator.info('Making API request', {
        url: safeUrl,
        method: options.method,
        timeout: timeoutMs
      });

      // Queue wait is intentionally outside the request timeout window
      await acquireOutboundSlot();

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(fullUrl, {
          ...options,
          signal: controller.signal,
          headers: {
            ...this.defaultHeaders,
            ...options.headers,
          },
        });

        if (!response.ok) {
          const body = await response.text();
          const retryAfter = response.headers.get('retry-after') ?? undefined;
          // Keep the response body off the error message to avoid leaking
          // upstream content into logs / client-visible errors. It remains
          // accessible on err.responseBody for internal debugging.
          throw new HttpApiError(
            `API error: ${response.status} ${response.statusText} ${safeUrl}`,
            response.status,
            body,
            retryAfter
          );
        }

        logDeduplicator.info('API request successful', {
          url: safeUrl,
          status: response.status
        });

        return response.json();
      } catch (error) {
        logDeduplicator.error('API request failed', {
          url: safeUrl,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined
        });

        if (error instanceof HttpApiError) {
          throw error;
        }
        if (error instanceof Error) {
          if (error.name === 'AbortError') {
            throw new Error('Request timeout');
          }
          throw new Error(`API request failed: ${error.message}`);
        }
        throw error;
      } finally {
        clearTimeout(timeout);
        releaseOutboundSlot();
      }
    }

    // Méthode pour gérer les retries
    protected async withRetry<T>(
      operation: () => Promise<T>,
      customRetries?: number,
      customDelay?: number
    ): Promise<T> {
      const maxRetries = customRetries ?? this.MAX_RETRIES;
      const delay = customDelay ?? this.RETRY_DELAY;
      let lastError: Error;

      for (let i = 0; i < maxRetries; i++) {
        try {
          return await operation();
        } catch (error) {
          lastError = error as Error;

          // Don't retry non-retryable HTTP errors (4xx except 429)
          if (error instanceof HttpApiError && !error.isRetryable) {
            throw error;
          }

          if (i < maxRetries - 1) {
            // Use longer backoff for rate limiting
            const backoffMultiplier = (error instanceof HttpApiError && error.isRateLimited) ? 3 : 1;
            let retryDelay = delay * (i + 1) * backoffMultiplier;

            // Honor Retry-After when present on 429/503 responses.
            if (error instanceof HttpApiError && (error.statusCode === 429 || error.statusCode === 503)) {
              const retryAfterMs = parseRetryAfterMs(error.retryAfter);
              if (retryAfterMs !== undefined) {
                retryDelay = retryAfterMs;
              }
            }

            // Add ±25% jitter to avoid thundering herd.
            const jitterFactor = 1 + (Math.random() * 0.5 - 0.25);
            retryDelay = Math.round(retryDelay * jitterFactor);

            // Absolute cap per retry (30s) and a sensible floor.
            if (retryDelay > this.MAX_RETRY_DELAY_MS) retryDelay = this.MAX_RETRY_DELAY_MS;
            if (retryDelay < 0) retryDelay = 0;

            logDeduplicator.warn('API request retry', {
              attempt: i + 1,
              maxRetries,
              service: this.constructor.name,
              statusCode: error instanceof HttpApiError ? error.statusCode : undefined,
              retryDelay,
              error: error instanceof Error ? error.message : String(error),
            });
            await this.delay(retryDelay);
          }
        }
      }

      throw lastError!;
    }

    // Méthodes HTTP principales
    public async post<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
      return this.withRetry(() =>
        this.fetchWithTimeout<T>(endpoint, {
          method: 'POST',
          body: JSON.stringify(body),
        })
      );
    }

    public async get<T>(endpoint: string): Promise<T> {
      return this.withRetry(() =>
        this.fetchWithTimeout<T>(endpoint, {
          method: 'GET',
        })
      );
    }

    /**
     * GET without `withRetry` — avoids multiplying long waits when upstream is slow.
     * Use for indexer leaf routes that can exceed the default timeout (e.g. per-builder stats).
     */
    protected async getSingleAttempt<T>(endpoint: string, timeoutMs: number = this.API_TIMEOUT): Promise<T> {
      return this.fetchWithTimeout<T>(endpoint, { method: 'GET' }, timeoutMs);
    }

    // Utilitaires
    private delay(ms: number): Promise<void> {
      return new Promise(resolve => setTimeout(resolve, ms));
    }

    public handleError(error: unknown): never {
      if (error instanceof Error) {
        throw new Error(`${this.constructor.name} error: ${error.message}`);
      }
      throw new Error(`${this.constructor.name} unknown error`);
    }
  }
