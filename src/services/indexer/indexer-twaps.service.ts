import {
  HypeDexerTwapsClient,
  IndexerTwapsListQuery,
  IndexerTwapsStatsQuery,
  IndexerTwapsUserQuery,
} from '../../clients/hypedexer/rest/twaps/twaps.client';
import type { HypeDexerApiResponse } from '../../types/hypedexer-api.types';

export class IndexerTwapsService {
  private static instance: IndexerTwapsService;
  private readonly client = HypeDexerTwapsClient.getInstance();

  public static getInstance(): IndexerTwapsService {
    if (!IndexerTwapsService.instance) {
      IndexerTwapsService.instance = new IndexerTwapsService();
    }
    return IndexerTwapsService.instance;
  }

  public listTwaps(params: IndexerTwapsListQuery): Promise<HypeDexerApiResponse> {
    return this.client.listTwaps(params);
  }

  public getStats(params: IndexerTwapsStatsQuery): Promise<HypeDexerApiResponse> {
    return this.client.getStats(params);
  }

  public getUserTwaps(userAddress: string, params: IndexerTwapsUserQuery): Promise<HypeDexerApiResponse> {
    return this.client.getUserTwaps(userAddress, params);
  }

  public getTwap(twapId: string): Promise<HypeDexerApiResponse> {
    return this.client.getTwap(twapId);
  }

  public getTwapFills(
    twapId: string,
    params: { limit?: number; offset?: number; order?: string }
  ): Promise<HypeDexerApiResponse> {
    return this.client.getTwapFills(twapId, params);
  }
}
