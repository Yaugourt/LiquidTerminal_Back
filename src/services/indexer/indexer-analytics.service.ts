import {
  HypeDexerAnalyticsIndexerClient,
  IndexerAnalyticsFillsStatsQuery,
} from '../../clients/hypedexer/rest/analytics/analytics-indexer.client';
import type { HypeDexerApiResponse } from '../../types/hypedexer-api.types';

export class IndexerAnalyticsService {
  private static instance: IndexerAnalyticsService;
  private readonly client = HypeDexerAnalyticsIndexerClient.getInstance();

  public static getInstance(): IndexerAnalyticsService {
    if (!IndexerAnalyticsService.instance) {
      IndexerAnalyticsService.instance = new IndexerAnalyticsService();
    }
    return IndexerAnalyticsService.instance;
  }

  public async getFillsStats(params: IndexerAnalyticsFillsStatsQuery): Promise<HypeDexerApiResponse> {
    return this.client.getFillsStats(params);
  }
}
