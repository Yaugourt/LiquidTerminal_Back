import { redisService } from '../../core/redis.service';
import { cacheService } from '../../core/cache.service';
import {
  HypeDexerFillsClient,
  IndexerFillsQuery,
  IndexerFillsUserByAddressQuery,
  IndexerFillsSpotQuery,
} from '../../clients/hypedexer/rest/fills/fills.client';
import { HYPEDEXER_CACHE_PREFIX, HYPEDEXER_TTL, HYPEDEXER_USER_CACHE_KEY } from '../../constants/hypedexer.cache';

const FILLS_COUNT_CACHE_KEY = `${HYPEDEXER_CACHE_PREFIX}:fills:count`;
const FILLS_LIST_CACHE_PREFIX = `${HYPEDEXER_CACHE_PREFIX}:fills:list`;

/** Short TTL for the global fills feeds — real-time-ish, but enough to collapse
 * repeated identical calls off the paid HypeDexer key and off the outbound pool. */
const FILLS_LIST_TTL = 10;

/**
 * Deterministic cache key from a params object: sorted so key order never
 * changes the key, and scoped by feed name. Every param that changes the
 * upstream result is included, so distinct queries never collide.
 */
function listKey(feed: string, params: Record<string, unknown>): string {
  const parts = Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== '')
    .sort()
    .map((k) => `${k}=${String(params[k])}`)
    .join('&');
  return `${FILLS_LIST_CACHE_PREFIX}:${feed}:${parts}`;
}

/**
 * Passthrough to HypeDexer fills API; optional short cache for global count only.
 */
export class IndexerFillsService {
  private static instance: IndexerFillsService;
  private readonly client = HypeDexerFillsClient.getInstance();

  public static getInstance(): IndexerFillsService {
    if (!IndexerFillsService.instance) {
      IndexerFillsService.instance = new IndexerFillsService();
    }
    return IndexerFillsService.instance;
  }

  public async getFills(params: IndexerFillsQuery): Promise<unknown> {
    return cacheService.getOrSet(
      listKey('fills', params as Record<string, unknown>),
      () => this.client.getFills(params),
      FILLS_LIST_TTL
    );
  }

  public async getFillsRecent(params: IndexerFillsQuery): Promise<unknown> {
    return cacheService.getOrSet(
      listKey('recent', params as Record<string, unknown>),
      () => this.client.getFillsRecent(params),
      FILLS_LIST_TTL
    );
  }

  public async getUserFills(
    userAddress: string,
    params: IndexerFillsUserByAddressQuery
  ): Promise<unknown> {
    if (params?.time_range) {
      return this.client.getUserFills(userAddress, params);
    }
    return cacheService.getOrSet(
      HYPEDEXER_USER_CACHE_KEY.fills(userAddress),
      () => this.client.getUserFills(userAddress, params),
      HYPEDEXER_TTL.userAddress
    );
  }

  public async getSpotFills(params: IndexerFillsSpotQuery): Promise<unknown> {
    return cacheService.getOrSet(
      listKey('spot', params as Record<string, unknown>),
      () => this.client.getSpotFills(params),
      FILLS_LIST_TTL
    );
  }

  public async getSpotUserFills(
    userAddress: string,
    params: Omit<IndexerFillsSpotQuery, 'user'>
  ): Promise<unknown> {
    if (params?.start_time || params?.end_time) {
      return this.client.getSpotUserFills(userAddress, params);
    }
    return cacheService.getOrSet(
      HYPEDEXER_USER_CACHE_KEY.spotFills(userAddress),
      () => this.client.getSpotUserFills(userAddress, params),
      HYPEDEXER_TTL.userAddress
    );
  }

  public async getFillsCount(): Promise<unknown> {
    const cached = await redisService.get(FILLS_COUNT_CACHE_KEY);
    if (cached) {
      try {
        return JSON.parse(cached) as unknown;
      } catch {
        /* fall through */
      }
    }
    const data = await this.client.getFillsCount();
    await redisService.set(FILLS_COUNT_CACHE_KEY, JSON.stringify(data), HYPEDEXER_TTL.fillsCount);
    return data;
  }
}
