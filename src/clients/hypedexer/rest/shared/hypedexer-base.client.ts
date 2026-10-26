import { BaseApiService } from '../../../../core/base.api.service';
import { unwrapHypeDexerApiPayload } from '../../../../utils/hypedexer-api-response.util';
import { currentUpstreamCaller, upstreamRefusal } from '../../../../utils/request-context';
import { countUpstreamCall } from '../../../../middleware/apiRateLimiter';

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

/**
 * Runs `start` as the one call for `key`, or joins the one already in flight.
 * A joiner is free for everyone, an over-budget client included. A caller that
 * would START the call is checked first (`precheck` throws its refusal), before
 * anything is registered: a refusal never lands in the shared in-flight entry,
 * so no joiner can inherit it.
 */
async function singleFlight<T>(key: string, precheck: () => void, start: () => Promise<T>): Promise<T> {
  const existing = inFlightHypedexerRequests.get(key);
  if (existing) {
    return existing as Promise<T>;
  }
  precheck();
  const promise = start();
  inFlightHypedexerRequests.set(key, promise);
  promise.finally(() => {
    // Guarded: a newer call for the key must not lose its entry to this one.
    if (inFlightHypedexerRequests.get(key) === promise) inFlightHypedexerRequests.delete(key);
  }).catch(() => {
    // swallow — the original `promise` still rejects to the caller
  });
  return promise;
}

export abstract class HypeDexerBaseClient extends BaseApiService {
  /**
   * Every HypeDexer REST call is billed. The one that really goes upstream
   * for a client's request (no joining, no cache hit: those never get here)
   * is counted against that client's budget; a client that was already over
   * budget when its request came in (decided once, on entry) is refused
   * instead, before anything starts. A call for a client that is within
   * budget is never refused, even when this very call takes its counter past
   * the limit: the shared computation it belongs to must finish. Retries run
   * inside the BaseApiService method, so each logical call counts once. No
   * caller (pollers, timers, a finished request, the authenticated export,
   * which has its own quota) means nothing to check or count.
   */
  private admitUpstreamCall(): void {
    const caller = currentUpstreamCaller();
    if (!caller) return;
    this.refuseExhaustedCaller();
    countUpstreamCall(caller.ipKey);
  }

  private refuseExhaustedCaller(): void {
    const refusal = upstreamRefusal();
    if (refusal) throw refusal;
  }

  public override async get<T>(endpoint: string): Promise<T> {
    this.admitUpstreamCall();
    return super.get<T>(endpoint);
  }

  public override async post<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
    this.admitUpstreamCall();
    return super.post<T>(endpoint, body);
  }

  protected override async getSingleAttempt<T>(endpoint: string, timeoutMs?: number): Promise<T> {
    this.admitUpstreamCall();
    return super.getSingleAttempt<T>(endpoint, timeoutMs);
  }

  protected async getUnwrapped<T>(endpoint: string): Promise<T> {
    return singleFlight(
      buildInFlightKey('GET', endpoint),
      () => this.refuseExhaustedCaller(),
      async () => {
        const raw = await this.get<unknown>(endpoint);
        return unwrapHypeDexerApiPayload(raw) as T;
      }
    );
  }

  protected async getSingleAttemptUnwrapped<T>(endpoint: string, timeoutMs?: number): Promise<T> {
    return singleFlight(
      buildInFlightKey('GET-SA', endpoint),
      () => this.refuseExhaustedCaller(),
      async () => {
        const raw = await this.getSingleAttempt<unknown>(endpoint, timeoutMs);
        return unwrapHypeDexerApiPayload(raw) as T;
      }
    );
  }
}
