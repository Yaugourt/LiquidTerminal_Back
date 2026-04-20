import {
  HypeDexerAnalyticsIndexerClient,
  IndexerAnalyticsFillsStatsQuery,
  IndexerAnalyticsPriorityFeesStatsQuery,
} from '../../clients/hypedexer/rest/analytics/analytics-indexer.client';

export class IndexerAnalyticsService {
  private static instance: IndexerAnalyticsService;
  private readonly client = HypeDexerAnalyticsIndexerClient.getInstance();

  public static getInstance(): IndexerAnalyticsService {
    if (!IndexerAnalyticsService.instance) {
      IndexerAnalyticsService.instance = new IndexerAnalyticsService();
    }
    return IndexerAnalyticsService.instance;
  }

  public async getFillsStats(params: IndexerAnalyticsFillsStatsQuery): Promise<unknown> {
    return this.client.getFillsStats(params);
  }

  public async getPriorityFeesStats(
    params: IndexerAnalyticsPriorityFeesStatsQuery
  ): Promise<unknown> {
    return this.client.getPriorityFeesStats(params);
  }
}
