import { BaseApiService } from '../../../../core/base.api.service';
import { unwrapHypeDexerApiPayload } from '../../../../utils/hypedexer-api-response.util';
import { currentUpstreamCaller } from '../../../../utils/request-context';
import { spendUpstreamBudget } from '../../../../middleware/apiRateLimiter';
import { UpstreamBudgetExceededError, isCallerRefusal } from '../../../../errors/upstreamBudget.errors';

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
 * A joiner never spends: only the call that actually goes upstream does (see
 * HypeDexerBaseClient.spendCallerBudget). If that call was refused for the
 * budget of the client that started it, the joiner is not refused with it: it
 * makes its own call, under its own budget.
 */
async function singleFlight<T>(key: string, start: () => Promise<T>): Promise<T> {
  const existing = inFlightHypedexerRequests.get(key);
  if (existing) {
    try {
      return (await existing) as T;
    } catch (error) {
      if (!isCallerRefusal(error)) throw error;
    }
  }
  const promise = start();
  inFlightHypedexerRequests.set(key, promise);
  promise.finally(() => {
    if (inFlightHypedexerRequests.get(key) === promise) inFlightHypedexerRequests.delete(key);
  }).catch(() => {
    // swallow — the original `promise` still rejects to the caller
  });
  return promise;
}

export abstract class HypeDexerBaseClient extends BaseApiService {
  /**
   * Every HypeDexer REST call is billed, so each logical call (not each
   * retry: the retries run inside the BaseApiService method) passes this gate
   * once, below. It spends the budget of the client whose request is being
   * answered; no client (pollers, timers, a finished request, the
   * authenticated export, which has its own quota) means no budget to spend.
   */
  private async spendCallerBudget(): Promise<void> {
    const caller = currentUpstreamCaller();
    if (!caller) return;
    const result = await spendUpstreamBudget(caller.ipKey);
    if (!result.allowed) throw new UpstreamBudgetExceededError(result.retryAfterS);
  }

  public override async get<T>(endpoint: string): Promise<T> {
    await this.spendCallerBudget();
    return super.get<T>(endpoint);
  }

  public override async post<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
    await this.spendCallerBudget();
    return super.post<T>(endpoint, body);
  }

  protected override async getSingleAttempt<T>(endpoint: string, timeoutMs?: number): Promise<T> {
    await this.spendCallerBudget();
    return super.getSingleAttempt<T>(endpoint, timeoutMs);
  }

  protected async getUnwrapped<T>(endpoint: string): Promise<T> {
    return singleFlight(buildInFlightKey('GET', endpoint), async () => {
      const raw = await this.get<unknown>(endpoint);
      return unwrapHypeDexerApiPayload(raw) as T;
    });
  }

  protected async getSingleAttemptUnwrapped<T>(endpoint: string, timeoutMs?: number): Promise<T> {
    return singleFlight(buildInFlightKey('GET-SA', endpoint), async () => {
      const raw = await this.getSingleAttempt<unknown>(endpoint, timeoutMs);
      return unwrapHypeDexerApiPayload(raw) as T;
    });
  }
}
