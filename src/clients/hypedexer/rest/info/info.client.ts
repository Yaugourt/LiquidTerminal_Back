import { CircuitBreakerService } from '../../../../core/circuit.breaker.service';
import { HttpApiError } from '../../../../core/base.api.service';
import { logDeduplicator } from '../../../../utils/logDeduplicator';
import { GasAuctionResponse } from '../../../../types/auction.types';
import { ClearinghouseState } from '../../../../types/positioning.types';
import { SpotContext } from '../../../../types/market.types';
import type { AllPerpMetas } from '../../../../utils/twap-enrichment.util';
import type { LedgerUpdate } from '../../../../services/revenue/reserve-yield.ledger';
import { HYPEDEXER_API_URL, hypedexerJsonHeaders } from '../shared/hypedexer-api.config';
import { HypeDexerBaseClient } from '../shared/hypedexer-base.client';

/** Most calls this process keeps in flight on HypeDexer's /info for its background reads. */
export const INFO_MAX_IN_FLIGHT = 6;
/** Callers waiting for one of those slots; past this a call fails at once (the caller falls back). */
const INFO_QUEUE_MAX = 200;
const INFO_QUEUE_WAIT_MS = 15_000;
const INFO_TIMEOUT_MS = 10_000;
/** A 429 is retried twice at most, after the Retry-After it carries (HypeDexer sends seconds), capped. */
const INFO_MAX_429_RETRIES = 2;
const INFO_RETRY_AFTER_CAP_MS = 5_000;
const INFO_RETRY_AFTER_DEFAULT_MS = 1_000;

/** `spotClearinghouseState`, the fields read here. */
export interface SpotClearinghouseState {
  balances?: { coin: string; token: number; total: string }[];
}

/** One slot of the process-wide cap; resolves when the caller may send. */
interface Waiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

let inFlight = 0;
const waiters: Waiter[] = [];

function acquireSlot(): Promise<void> {
  if (inFlight < INFO_MAX_IN_FLIGHT) {
    inFlight += 1;
    return Promise.resolve();
  }
  if (waiters.length >= INFO_QUEUE_MAX) {
    return Promise.reject(new Error('HypeDexer /info queue is full'));
  }
  return new Promise<void>((resolve, reject) => {
    const waiter: Waiter = {
      resolve,
      reject,
      timer: setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index !== -1) waiters.splice(index, 1);
        reject(new Error('HypeDexer /info slot wait timed out'));
      }, INFO_QUEUE_WAIT_MS),
    };
    waiters.push(waiter);
  });
}

function releaseSlot(): void {
  const next = waiters.shift();
  if (next) {
    // The slot goes straight to the oldest waiter: `inFlight` stays as it is.
    clearTimeout(next.timer);
    next.resolve();
    return;
  }
  inFlight -= 1;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** How long a 429 asks to wait: Retry-After in seconds, at most INFO_RETRY_AFTER_CAP_MS. */
function retryAfterMs(error: HttpApiError): number {
  const seconds = Number(error.retryAfter);
  const ms = Number.isFinite(seconds) && seconds >= 0 && error.retryAfter ? seconds * 1000 : INFO_RETRY_AFTER_DEFAULT_MS;
  return Math.min(ms, INFO_RETRY_AFTER_CAP_MS);
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Rows in the order Hyperliquid itself answers: oldest first, ties broken by hash. */
export function sortLedgerAscending(rows: LedgerUpdate[]): LedgerUpdate[] {
  return [...rows].sort((a, b) => {
    if (a.time !== b.time) return a.time - b.time;
    if (a.hash === b.hash) return 0;
    return a.hash < b.hash ? -1 : 1;
  });
}

/**
 * HypeDexer's unified `/info` endpoint: Hyperliquid's own request bodies,
 * answered from the indexer for 3 credits a call and no Hyperliquid weight.
 * Only the types it answers identically are exposed here (probed 2026-10-30):
 * spotDeployState, clearinghouseState, spotClearinghouseState,
 * userNonFundingLedgerUpdates (newest first there, oldest first on
 * Hyperliquid; sorted back here), allPerpMetas, perpDexs, spotMeta. Not for
 * metaAndAssetCtxs (marks ~30 s old) nor allMids (another coin set); the
 * types it refuses (400) stay on Hyperliquid.
 *
 * For background reads, which keep Hyperliquid as their fallback:
 * - the calls in flight are capped process-wide (INFO_MAX_IN_FLIGHT), since
 *   the burst limit (~25-30 requests/s) is shared with every HypeDexer caller;
 * - a 429 waits its Retry-After (5 s at most) and is retried twice at most; the
 *   slot is free during the wait;
 * - circuit breaker id: `hypedexer-info`.
 * Not charged to a caller's upstream budget: these are shared, cadence-driven
 * reads, and a refusal of one visitor must not degrade them for everyone.
 */
export class HypeDexerInfoClient extends HypeDexerBaseClient {
  private static instance: HypeDexerInfoClient;
  private readonly circuitBreaker = CircuitBreakerService.getInstance('hypedexer-info');

  private constructor() {
    super(HYPEDEXER_API_URL, hypedexerJsonHeaders);
  }

  public static getInstance(): HypeDexerInfoClient {
    if (!HypeDexerInfoClient.instance) HypeDexerInfoClient.instance = new HypeDexerInfoClient();
    return HypeDexerInfoClient.instance;
  }

  /** POST /info with a Hyperliquid body, behind the breaker, the in-flight cap and the 429 wait. */
  public info<T>(body: Record<string, unknown>): Promise<T> {
    return this.circuitBreaker.execute(() => this.send<T>(body));
  }

  private async send<T>(body: Record<string, unknown>): Promise<T> {
    const payload = JSON.stringify(body);
    for (let attempt = 0; ; attempt += 1) {
      await acquireSlot();
      let waitMs = 0;
      try {
        return await this.fetchWithTimeout<T>('/info', { method: 'POST', body: payload }, INFO_TIMEOUT_MS);
      } catch (error) {
        if (!(error instanceof HttpApiError) || !error.isRateLimited || attempt >= INFO_MAX_429_RETRIES) throw error;
        waitMs = retryAfterMs(error);
      } finally {
        releaseSlot();
      }
      logDeduplicator.warn('HypeDexer /info rate limited, waiting', { type: String(body.type), waitMs, attempt: attempt + 1 });
      await sleep(waitMs);
    }
  }

  public async spotDeployState(user: string): Promise<GasAuctionResponse> {
    const data = await this.info<unknown>({ type: 'spotDeployState', user });
    if (!isObject(data) || !Array.isArray(data.states)) throw new Error('Unexpected spotDeployState payload');
    return data as unknown as GasAuctionResponse;
  }

  public async clearinghouseState(user: string): Promise<ClearinghouseState> {
    const data = await this.info<unknown>({ type: 'clearinghouseState', user });
    if (!isObject(data)) throw new Error('Unexpected clearinghouseState payload');
    return data as ClearinghouseState;
  }

  public async spotClearinghouseState(user: string): Promise<SpotClearinghouseState> {
    const data = await this.info<unknown>({ type: 'spotClearinghouseState', user });
    if (!isObject(data) || !Array.isArray(data.balances)) throw new Error('Unexpected spotClearinghouseState payload');
    return data as SpotClearinghouseState;
  }

  /** The ledger rows from `startTime`, oldest first (Hyperliquid's order). */
  public async userNonFundingLedgerUpdates(user: string, startTime: number): Promise<LedgerUpdate[]> {
    const data = await this.info<unknown>({ type: 'userNonFundingLedgerUpdates', user, startTime });
    if (!Array.isArray(data)) throw new Error('Unexpected userNonFundingLedgerUpdates payload');
    return sortLedgerAscending(data as LedgerUpdate[]);
  }

  public async allPerpMetas(): Promise<AllPerpMetas> {
    const data = await this.info<unknown>({ type: 'allPerpMetas' });
    if (!Array.isArray(data)) throw new Error('Unexpected allPerpMetas payload');
    return data as AllPerpMetas;
  }

  public async perpDexs(): Promise<Array<Record<string, unknown> | null>> {
    const data = await this.info<unknown>({ type: 'perpDexs' });
    if (!Array.isArray(data)) throw new Error('Unexpected perpDexs payload');
    return data as Array<Record<string, unknown> | null>;
  }

  public async spotMeta(): Promise<SpotContext> {
    const data = await this.info<unknown>({ type: 'spotMeta' });
    if (!isObject(data) || !Array.isArray(data.tokens) || !Array.isArray(data.universe)) {
      throw new Error('Unexpected spotMeta payload');
    }
    return data as unknown as SpotContext;
  }
}

/** Reads currently on Hyperliquid because the proxy failed: one warning per outage, one line when it ends. */
const readsOnFallback = new Set<string>();

/**
 * One background read through HypeDexer's /info, Hyperliquid direct when the
 * proxy fails (error, breaker open, bad payload). The fallback is logged once
 * per outage of `read`, not once per call.
 */
export async function viaInfoProxy<T>(read: string, proxy: () => Promise<T>, direct: () => Promise<T>): Promise<T> {
  try {
    const data = await proxy();
    if (readsOnFallback.delete(read)) {
      logDeduplicator.info('HypeDexer /info proxy is back, no longer reading from Hyperliquid', { read });
    }
    return data;
  } catch (error) {
    if (!readsOnFallback.has(read)) {
      readsOnFallback.add(read);
      logDeduplicator.warn('HypeDexer /info proxy failed, reading from Hyperliquid until it is back', {
        read,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return direct();
  }
}

/** Test helper: forget the outages in progress. */
export function resetInfoProxyOutages(): void {
  readsOnFallback.clear();
}
