import { HypeDexerUsersIndexerClient, IndexerUsersLeaderboardQuery } from '../../clients/hypedexer/rest/users/users-indexer.client';
import { cacheService } from '../../core/cache.service';
import { HYPEDEXER_USER_CACHE_KEY, HYPEDEXER_TTL } from '../../constants/hypedexer.cache';

export class IndexerUsersService {
  private static instance: IndexerUsersService;
  private readonly client = HypeDexerUsersIndexerClient.getInstance();

  public static getInstance(): IndexerUsersService {
    if (!IndexerUsersService.instance) {
      IndexerUsersService.instance = new IndexerUsersService();
    }
    return IndexerUsersService.instance;
  }

  public async getLeaderboard(q: IndexerUsersLeaderboardQuery): Promise<unknown> {
    return this.client.getLeaderboard(q);
  }

  public async getUserCoins(
    user: string,
    params: { start_time?: string; end_time?: string; limit?: number }
  ): Promise<unknown> {
    if (params?.start_time || params?.end_time) {
      return this.client.getUserCoins(user, params);
    }
    return cacheService.getOrSet(
      HYPEDEXER_USER_CACHE_KEY.coins(user),
      () => this.client.getUserCoins(user, params),
      HYPEDEXER_TTL.userAddress
    );
  }

  public async getUserOverview(
    user: string,
    params: { start_time?: string; end_time?: string }
  ): Promise<unknown> {
    if (params?.start_time || params?.end_time) {
      return this.client.getUserOverview(user, params);
    }
    return cacheService.getOrSet(
      HYPEDEXER_USER_CACHE_KEY.overview(user),
      () => this.client.getUserOverview(user, params),
      HYPEDEXER_TTL.userAddress
    );
  }

  public async getUserPerformance(
    user: string,
    params: { start_time?: string; end_time?: string }
  ): Promise<unknown> {
    if (params?.start_time || params?.end_time) {
      return this.client.getUserPerformance(user, params);
    }
    return cacheService.getOrSet(
      HYPEDEXER_USER_CACHE_KEY.performance(user),
      () => this.client.getUserPerformance(user, params),
      HYPEDEXER_TTL.userAddress
    );
  }
}
