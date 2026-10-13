import { HypurrscanFeedsClient } from '../../clients/hypurrscan/feeds.client';
import {
  HYPURRSCAN_CACHE_KEYS,
  HYPURRSCAN_LAST_COPY_KEEP_S,
  HYPURRSCAN_TTL,
} from '../../constants/hypurrscan.cache';
import { cacheService } from '../../core/cache.service';
import {
  HypurrscanDeploy,
  HypurrscanGlobalAliases,
  HypurrscanPastAuctionPerp,
} from '../../types/hypurrscanFeeds.types';
import { logDeduplicator } from '../../utils/logDeduplicator';

/** The feed can't be read from Hypurrscan and no copy is kept: the routes answer 503. */
export class HypurrscanFeedUnavailableError extends Error {
  constructor(public readonly feed: string) {
    super(`Hypurrscan ${feed} unavailable`);
    this.name = 'HypurrscanFeedUnavailableError';
  }
}

/**
 * Hypurrscan's pastAuctionsPerp, deploys and globalAliases for the browser,
 * which used to poll them directly (uncompressed, ~125 KB, 18 KB and 29 KB per
 * poll per tab). Each feed is one shared cache entry read on demand (no
 * poller): Hypurrscan is asked at most once per TTL whatever the traffic, the
 * last copy (a day) is served while a key refreshes in the background and
 * when Hypurrscan fails, and an answer of the wrong shape is never stored.
 * The copy is stored whatever its size (the opted-in keep skips
 * CACHE_LAST_COPY_MAX_CHARS); the feeds are 17 to 116 KB serialized anyway.
 */
export class HypurrscanFeedsService {
  private static instance: HypurrscanFeedsService;

  private readonly client = HypurrscanFeedsClient.getInstance();

  private constructor() {}

  public static getInstance(): HypurrscanFeedsService {
    if (!HypurrscanFeedsService.instance) {
      HypurrscanFeedsService.instance = new HypurrscanFeedsService();
    }
    return HypurrscanFeedsService.instance;
  }

  public getPastAuctionsPerp(): Promise<HypurrscanPastAuctionPerp[]> {
    return this.read('pastAuctionsPerp', HYPURRSCAN_CACHE_KEYS.pastAuctionsPerp, HYPURRSCAN_TTL.pastAuctionsPerp, () =>
      this.client.getPastAuctionsPerp()
    );
  }

  public getDeploys(): Promise<HypurrscanDeploy[]> {
    return this.read('deploys', HYPURRSCAN_CACHE_KEYS.deploys, HYPURRSCAN_TTL.deploys, () =>
      this.client.getDeploys()
    );
  }

  public getGlobalAliases(): Promise<HypurrscanGlobalAliases> {
    return this.read('globalAliases', HYPURRSCAN_CACHE_KEYS.globalAliases, HYPURRSCAN_TTL.globalAliases, () =>
      this.client.getGlobalAliases()
    );
  }

  private async read<T>(feed: string, key: string, ttlS: number, fetchFn: () => Promise<T>): Promise<T> {
    try {
      return await cacheService.getOrSet(key, fetchFn, ttlS, {
        lastCopyKeepS: HYPURRSCAN_LAST_COPY_KEEP_S,
        refreshInBackground: true,
      });
    } catch (error) {
      logDeduplicator.warn('Hypurrscan feed unavailable, nothing cached', {
        feed,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new HypurrscanFeedUnavailableError(feed);
    }
  }
}
