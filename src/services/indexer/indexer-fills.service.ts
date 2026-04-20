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
    return this.client.getFills(params);
  }

  public async getFillsRecent(params: IndexerFillsQuery): Promise<unknown> {
    return this.client.getFillsRecent(params);
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
    return this.client.getSpotFills(params);
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
