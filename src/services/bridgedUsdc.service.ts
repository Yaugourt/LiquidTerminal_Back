import { BaseApiService } from '../core/base.api.service';
import { cacheService } from '../core/cache.service';
import { DEFILLAMA_CACHE_KEYS, DEFILLAMA_TTL } from '../constants/defillama.cache';
import { BridgedUsdcData } from '../types/market.types';
import { logDeduplicator } from '../utils/logDeduplicator';

/**
 * How long the last value outlives its key: DefiLlama's series has one point a
 * day, so a copy up to a day old still beats an empty tile during an outage.
 */
const BRIDGED_USDC_LAST_COPY_KEEP_S = 86_400;
/**
 * How long one DefiLlama read may take, outbound queue included: a single
 * attempt (no retries), about 4x a cold answer (~0.6 s for ~120 KB). It is
 * kept under BRIDGED_USDC_READ_WAIT_MS so that a hanging DefiLlama fails
 * within the request's wait: past the cache's serve-while-refresh window
 * (20 min for a 5 min TTL) a read waits for the fetch, and the failure is
 * what lets cacheService answer with the last copy (and back off 10 s)
 * instead of the request giving up with null.
 */
export const BRIDGED_USDC_FETCH_TIMEOUT_MS = 2_500;
/**
 * Outer bound on what a request waits for the value: covers a fetch run by
 * another instance (Redis lock) on top of BRIDGED_USDC_FETCH_TIMEOUT_MS. Past
 * it the field is null for this answer; a fetch still running goes on and
 * fills the key for the next poll.
 */
export const BRIDGED_USDC_READ_WAIT_MS = 3_000;

/** The series' latest USDC figure; throws on an answer without one, so it never replaces a good copy. */
export function latestBridgedUsdc(series: BridgedUsdcData[]): number {
  const latest = Array.isArray(series) ? series[series.length - 1]?.totalCirculating?.peggedUSD : undefined;
  if (typeof latest !== 'number' || !Number.isFinite(latest)) {
    throw new Error('DefiLlama stablecoin series has no latest USDC value');
  }
  return latest;
}

/** `promise`, or a rejection once `ms` have passed (the timer never outlives it). */
function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

export class BridgedUsdcService extends BaseApiService {
  constructor() {
    super('https://stablecoins.llama.fi');
  }

  /**
   * Récupère les données USDC bridgées sur Hyperliquid (one attempt, aborted
   * after BRIDGED_USDC_FETCH_TIMEOUT_MS)
   */
  public async getBridgedUsdcData(): Promise<BridgedUsdcData[]> {
    try {
      return await this.getSingleAttempt<BridgedUsdcData[]>(
        '/stablecoincharts/Hyperliquid?stablecoin=2',
        BRIDGED_USDC_FETCH_TIMEOUT_MS
      );
    } catch (error) {
      throw this.handleError(error);
    }
  }

  /**
   * USDC circulating on Hyperliquid (the series' latest point), shared by every
   * caller through one Redis key: DefiLlama is asked at most once per TTL (5
   * min) whatever the traffic, and the last value is served while it
   * refreshes. Never throws: when DefiLlama fails, or hangs past
   * BRIDGED_USDC_FETCH_TIMEOUT_MS, the last copy is served (up to a day old),
   * else null. Past the 20 min serve-while-refresh window the read waits for
   * the fetch, so during a long outage the requests arriving in one attempt
   * wait up to 2.5 s for the copy, then it is served at once for the 10 s
   * failure backoff: one DefiLlama attempt per ~12.5 s.
   */
  public async getLatestBridgedUsdc(): Promise<number | null> {
    const read = cacheService
      .getOrSet(
        DEFILLAMA_CACHE_KEYS.bridgedUsdc,
        async () =>
          latestBridgedUsdc(
            await withDeadline(this.getBridgedUsdcData(), BRIDGED_USDC_FETCH_TIMEOUT_MS, 'DefiLlama bridged USDC read')
          ),
        DEFILLAMA_TTL.bridgedUsdc,
        { lastCopyKeepS: BRIDGED_USDC_LAST_COPY_KEEP_S, refreshInBackground: true }
      )
      .catch((error: unknown): null => {
        logDeduplicator.warn('Bridged USDC unavailable (DefiLlama), answering without it', {
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      });

    let timer: NodeJS.Timeout | undefined;
    const giveUp = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), BRIDGED_USDC_READ_WAIT_MS);
    });
    try {
      return await Promise.race([read, giveUp]);
    } finally {
      clearTimeout(timer);
    }
  }
}
