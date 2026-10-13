import { BaseApiService } from '../../core/base.api.service';
import { CircuitBreakerService } from '../../core/circuit.breaker.service';
import {
  HypurrscanDeploy,
  HypurrscanGlobalAliases,
  HypurrscanPastAuctionPerp,
} from '../../types/hypurrscanFeeds.types';

/**
 * One attempt per read, no retries: a failed read is answered with the cached
 * last copy and not retried for a few seconds (cacheService). ~120 KB comes
 * back in ~0.15 s, so this only cuts off a hanging upstream.
 */
export const HYPURRSCAN_FEED_TIMEOUT_MS = 8_000;

/** An answer that is not the expected shape, so it is never cached. */
export class HypurrscanFeedShapeError extends Error {
  constructor(feed: string, expected: string) {
    super(`Hypurrscan ${feed}: expected ${expected}`);
    this.name = 'HypurrscanFeedShapeError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A non-empty array of objects: an empty list would replace a good copy with "nothing happened". */
function assertEntries<T>(feed: string, body: unknown): T[] {
  if (!Array.isArray(body) || body.length === 0 || !body.every(isRecord)) {
    throw new HypurrscanFeedShapeError(feed, 'a non-empty array of objects');
  }
  return body as T[];
}

/**
 * Hypurrscan feeds read on demand by HypurrscanFeedsService (no polling; the
 * service keeps the shared copy). Shapes are relayed as sent, only checked
 * for the basic type.
 */
export class HypurrscanFeedsClient extends BaseApiService {
  private static instance: HypurrscanFeedsClient;
  private static readonly API_URL = process.env.HYPURRSCAN_API_URL || 'https://api.hypurrscan.io';

  private readonly circuitBreaker: CircuitBreakerService;

  private constructor() {
    super(HypurrscanFeedsClient.API_URL);
    this.circuitBreaker = CircuitBreakerService.getInstance('hypurrscan_feeds');
  }

  public static getInstance(): HypurrscanFeedsClient {
    if (!HypurrscanFeedsClient.instance) {
      HypurrscanFeedsClient.instance = new HypurrscanFeedsClient();
    }
    return HypurrscanFeedsClient.instance;
  }

  /** `/pastAuctionsPerp` — every perp deploy auction since the first one, oldest first. */
  public async getPastAuctionsPerp(): Promise<HypurrscanPastAuctionPerp[]> {
    return assertEntries<HypurrscanPastAuctionPerp>('pastAuctionsPerp', await this.read('/pastAuctionsPerp'));
  }

  /** `/deploys` — the latest 50 spot deploy actions, newest first. */
  public async getDeploys(): Promise<HypurrscanDeploy[]> {
    return assertEntries<HypurrscanDeploy>('deploys', await this.read('/deploys'));
  }

  /** `/globalAliases` — address → label for the known addresses. */
  public async getGlobalAliases(): Promise<HypurrscanGlobalAliases> {
    const body = await this.read('/globalAliases');
    if (!isRecord(body) || Object.keys(body).length === 0) {
      throw new HypurrscanFeedShapeError('globalAliases', 'a non-empty object');
    }
    return body as HypurrscanGlobalAliases;
  }

  private read(endpoint: string): Promise<unknown> {
    return this.circuitBreaker.execute(() => this.getSingleAttempt<unknown>(endpoint, HYPURRSCAN_FEED_TIMEOUT_MS));
  }
}
