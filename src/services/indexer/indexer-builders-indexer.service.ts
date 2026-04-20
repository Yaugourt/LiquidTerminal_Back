import {
  HypeDexerBuildersIndexerClient,
  IndexerBuilderDetailQuery,
  IndexerBuilderUsersQuery,
  IndexerBuildersTopQuery,
  IndexerBuildersTimeframe,
} from '../../clients/hypedexer/rest/builders/builders-indexer.client';

/**
 * Passthrough for HypeDexer /builders/* REST under /indexer/builders (distinct from Redis poller `builders-list-poller.client.ts`).
 */
export class IndexerBuildersIndexerService {
  private static instance: IndexerBuildersIndexerService;
  private readonly client = HypeDexerBuildersIndexerClient.getInstance();

  public static getInstance(): IndexerBuildersIndexerService {
    if (!IndexerBuildersIndexerService.instance) {
      IndexerBuildersIndexerService.instance = new IndexerBuildersIndexerService();
    }
    return IndexerBuildersIndexerService.instance;
  }

  public async listBuilders(legacyQuery?: string): Promise<unknown> {
    return this.client.listBuilders(legacyQuery);
  }

  public async getGlobalStats(timeframe?: IndexerBuildersTimeframe): Promise<unknown> {
    return this.client.getGlobalStats(timeframe);
  }

  public async getStatsAllTimeframes(): Promise<unknown> {
    return this.client.getStatsAllTimeframes();
  }

  public async getTopBuilders(params: IndexerBuildersTopQuery): Promise<unknown> {
    return this.client.getTopBuilders(params);
  }

  public async getBuilderStats(
    builderAddress: string,
    params: IndexerBuilderDetailQuery
  ): Promise<unknown> {
    return this.client.getBuilderStats(builderAddress, params);
  }

  public async getBuilderUsers(
    builderAddress: string,
    params: IndexerBuilderUsersQuery
  ): Promise<unknown> {
    return this.client.getBuilderUsers(builderAddress, params);
  }
}
