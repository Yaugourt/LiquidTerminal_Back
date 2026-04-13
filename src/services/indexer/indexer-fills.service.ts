import { redisService } from '../../core/redis.service';
import {
  HypeDexerFillsClient,
  IndexerFillsQuery,
  IndexerFillsUserByAddressQuery,
  IndexerFillsSpotQuery,
} from '../../clients/hypedexer/rest/fills/fills.client';
import { HYPEDEXER_CACHE_PREFIX, HYPEDEXER_TTL } from '../../constants/hypedexer.cache';
import type { HypeDexerApiResponse } from '../../types/hypedexer-api.types';

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

  public async getFills(params: IndexerFillsQuery): Promise<HypeDexerApiResponse> {
    return this.client.getFills(params);
  }

  public async getFillsRecent(params: IndexerFillsQuery): Promise<HypeDexerApiResponse> {
    return this.client.getFillsRecent(params);
  }

  public async getUserFills(
    userAddress: string,
    params: IndexerFillsUserByAddressQuery
  ): Promise<HypeDexerApiResponse> {
    return this.client.getUserFills(userAddress, params);
  }

  public async getSpotFills(params: IndexerFillsSpotQuery): Promise<HypeDexerApiResponse> {
    return this.client.getSpotFills(params);
  }

  public async getSpotUserFills(
    userAddress: string,
    params: Omit<IndexerFillsSpotQuery, 'user'>
  ): Promise<HypeDexerApiResponse> {
    return this.client.getSpotUserFills(userAddress, params);
  }

  public async getFillsCount(): Promise<HypeDexerApiResponse> {
    const cached = await redisService.get(FILLS_COUNT_CACHE_KEY);
    if (cached) {
      try {
        return JSON.parse(cached) as HypeDexerApiResponse;
      } catch {
        /* fall through */
      }
    }
    const data = await this.client.getFillsCount();
    await redisService.set(FILLS_COUNT_CACHE_KEY, JSON.stringify(data), HYPEDEXER_TTL.fillsCount);
    return data;
  }
}
