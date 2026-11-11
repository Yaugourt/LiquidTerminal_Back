import { AsyncLocalStorage } from 'node:async_hooks';
import { BaseApiService } from '../../../../core/base.api.service';
import { unwrapHypeDexerApiPayload } from '../../../../utils/hypedexer-api-response.util';
import { currentUpstreamCaller, upstreamRefusal } from '../../../../utils/request-context';
import { countUpstreamCredits, UPSTREAM_CALL_BASE_CREDITS } from '../../../../middleware/apiRateLimiter';

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

/**
 * The client a call was started for, for as long as the call runs. The bill arrives with the
 * answer, and the request may be over by then: a reader of a live key is served the last copy
 * after 1.5 s while the refresh it started goes on. Counted only against a request still open,
 * what such a call cost past its first 2 credits was never counted: a caller asking again at
 * each expiry for a 1,000-row key it had filled once paid 2 credits for calls billed 102.
 */
interface BilledCall {
  ipKey: string;
  siteKey?: string;
  /** Answers already billed for this call (a retry after an answer whose body did not read is billed again). */
  bills: number;
}
const billedCall = new AsyncLocalStorage<BilledCall>();

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
   * is counted against that client's budget, in credits: the price any call
   * has when it starts, the rest when its answer says what it cost
   * (onBilled). A client that was already over
   * budget when its request came in (decided once, on entry) is refused
   * instead, before anything starts. A call for a client that is within
   * budget is never refused, even when this very call takes its counter past
   * the limit: the shared computation it belongs to must finish. Retries run
   * inside the BaseApiService method, so each logical call counts once. No
   * caller (pollers, timers, a finished request, the authenticated export,
   * which has its own quota) means nothing to check or count.
   */
  private admitUpstreamCall(): BilledCall | undefined {
    const caller = currentUpstreamCaller();
    if (!caller) return undefined;
    this.refuseExhaustedCaller();
    countUpstreamCredits(caller, UPSTREAM_CALL_BASE_CREDITS);
    return { ipKey: caller.ipKey, ...(caller.siteKey ? { siteKey: caller.siteKey } : {}), bills: 0 };
  }

  /** Runs `call` as the call started for `payer` (see billedCall), or as nobody's. */
  private billedTo<T>(payer: BilledCall | undefined, call: () => Promise<T>): Promise<T> {
    return payer ? billedCall.run(payer, call) : call();
  }

  /**
   * The answer says what the call cost (2 credits plus 1 per 10 rows): what it costs past the
   * price counted when it started is counted for the client the call was started for. A call
   * that fails is not billed, and keeps the price it started with; a call billed twice (its
   * first answer did not read, and it was sent again) is counted twice.
   */
  protected override onBilled(credits: number): void {
    const payer = billedCall.getStore();
    if (!payer) return;
    const due = payer.bills === 0 ? credits - UPSTREAM_CALL_BASE_CREDITS : credits;
    payer.bills += 1;
    if (due > 0) countUpstreamCredits(payer, due);
  }

  private refuseExhaustedCaller(): void {
    const refusal = upstreamRefusal();
    if (refusal) throw refusal;
  }

  public override async get<T>(endpoint: string): Promise<T> {
    return this.billedTo(this.admitUpstreamCall(), () => super.get<T>(endpoint));
  }

  public override async post<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
    return this.billedTo(this.admitUpstreamCall(), () => super.post<T>(endpoint, body));
  }

  protected override async getSingleAttempt<T>(endpoint: string, timeoutMs?: number): Promise<T> {
    return this.billedTo(this.admitUpstreamCall(), () => super.getSingleAttempt<T>(endpoint, timeoutMs));
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
