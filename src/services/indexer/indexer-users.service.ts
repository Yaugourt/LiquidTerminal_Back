import { HypeDexerUsersIndexerClient, IndexerUsersLeaderboardQuery } from '../../clients/hypedexer/rest/users/users-indexer.client';
import type { HypeDexerApiResponse } from '../../types/hypedexer-api.types';

export class IndexerUsersService {
  private static instance: IndexerUsersService;
  private readonly client = HypeDexerUsersIndexerClient.getInstance();

  public static getInstance(): IndexerUsersService {
    if (!IndexerUsersService.instance) {
      IndexerUsersService.instance = new IndexerUsersService();
    }
    return IndexerUsersService.instance;
  }

  public async getLeaderboard(q: IndexerUsersLeaderboardQuery): Promise<HypeDexerApiResponse> {
    return this.client.getLeaderboard(q);
  }

  public async getUserCoins(
    user: string,
    params: { start_time?: string; end_time?: string; limit?: number }
  ): Promise<HypeDexerApiResponse> {
    return this.client.getUserCoins(user, params);
  }

  public async getUserOverview(
    user: string,
    params: { start_time?: string; end_time?: string }
  ): Promise<HypeDexerApiResponse> {
    return this.client.getUserOverview(user, params);
  }

  public async getUserPerformance(
    user: string,
    params: { start_time?: string; end_time?: string }
  ): Promise<HypeDexerApiResponse> {
    return this.client.getUserPerformance(user, params);
  }
}
