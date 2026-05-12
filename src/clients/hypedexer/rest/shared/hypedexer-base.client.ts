import { BaseApiService } from '../../../../core/base.api.service';
import { unwrapHypeDexerApiPayload } from '../../../../utils/hypedexer-api-response.util';

/**
 * Module-level in-flight request map for single-flight dedup.
 * Multiple callers that request the same GET endpoint while one is still
 * in-flight will share the same underlying Promise instead of firing
 * parallel duplicate requests against HypeDexer.
 *
 * Keyed by HTTP method + full endpoint (path + query string).
 * The entry is cleared in `.finally()` so subsequent calls retry normally.
 */
const inFlightHypedexerRequests: Map<string, Promise<unknown>> = new Map();

function buildInFlightKey(method: string, endpoint: string): string {
  return `${method} ${endpoint}`;
}

export abstract class HypeDexerBaseClient extends BaseApiService {
  protected async getUnwrapped<T>(endpoint: string): Promise<T> {
    const key = buildInFlightKey('GET', endpoint);
    const existing = inFlightHypedexerRequests.get(key);
    if (existing) {
      return existing as Promise<T>;
    }
    const promise = (async (): Promise<T> => {
      const raw = await this.get<unknown>(endpoint);
      return unwrapHypeDexerApiPayload(raw) as T;
    })();
    inFlightHypedexerRequests.set(key, promise);
    promise.finally(() => {
      inFlightHypedexerRequests.delete(key);
    }).catch(() => {
      // swallow — the original `promise` still rejects to the caller
    });
    return promise;
  }

  protected async getSingleAttemptUnwrapped<T>(endpoint: string, timeoutMs?: number): Promise<T> {
    const key = buildInFlightKey('GET-SA', endpoint);
    const existing = inFlightHypedexerRequests.get(key);
    if (existing) {
      return existing as Promise<T>;
    }
    const promise = (async (): Promise<T> => {
      const raw = await this.getSingleAttempt<unknown>(endpoint, timeoutMs);
      return unwrapHypeDexerApiPayload(raw) as T;
    })();
    inFlightHypedexerRequests.set(key, promise);
    promise.finally(() => {
      inFlightHypedexerRequests.delete(key);
    }).catch(() => {
      // swallow — the original `promise` still rejects to the caller
    });
    return promise;
  }
}
