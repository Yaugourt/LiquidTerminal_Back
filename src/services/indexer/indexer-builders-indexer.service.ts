import {
  HypeDexerBuildersIndexerClient,
  IndexerBuilderDetailQuery,
  IndexerBuilderUsersQuery,
  IndexerBuildersTopQuery,
  IndexerBuildersTimeframe,
} from '../../clients/hypedexer/rest/builders/builders-indexer.client';
import type { HypeDexerApiResponse } from '../../types/hypedexer-api.types';

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

  public async listBuilders(legacyQuery?: string): Promise<HypeDexerApiResponse> {
    return this.client.listBuilders(legacyQuery);
  }

  public async getGlobalStats(timeframe?: IndexerBuildersTimeframe): Promise<HypeDexerApiResponse> {
    return this.client.getGlobalStats(timeframe);
  }

  public async getStatsAllTimeframes(): Promise<HypeDexerApiResponse> {
    return this.client.getStatsAllTimeframes();
  }

  public async getTopBuilders(params: IndexerBuildersTopQuery): Promise<HypeDexerApiResponse> {
    return this.client.getTopBuilders(params);
  }

  public async getBuilderStats(
    builderAddress: string,
    params: IndexerBuilderDetailQuery
  ): Promise<HypeDexerApiResponse> {
    return this.client.getBuilderStats(builderAddress, params);
  }

  public async getBuilderUsers(
    builderAddress: string,
    params: IndexerBuilderUsersQuery
  ): Promise<HypeDexerApiResponse> {
    return this.client.getBuilderUsers(builderAddress, params);
  }
}
