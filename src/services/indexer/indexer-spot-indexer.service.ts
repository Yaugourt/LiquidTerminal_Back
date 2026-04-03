import { HypeDexerSpotIndexerClient } from '../../clients/hypedexer/rest/spot/spot-indexer.client';
import type { HypeDexerApiResponse } from '../../types/hypedexer-api.types';

export class IndexerSpotIndexerService {
  private static instance: IndexerSpotIndexerService;
  private readonly client = HypeDexerSpotIndexerClient.getInstance();

  public static getInstance(): IndexerSpotIndexerService {
    if (!IndexerSpotIndexerService.instance) {
      IndexerSpotIndexerService.instance = new IndexerSpotIndexerService();
    }
    return IndexerSpotIndexerService.instance;
  }

  public getAuctionsHist(p: Parameters<HypeDexerSpotIndexerClient['getAuctionsHist']>[0]): Promise<HypeDexerApiResponse> {
    return this.client.getAuctionsHist(p);
  }

  public getAuctionsLive(p: Parameters<HypeDexerSpotIndexerClient['getAuctionsLive']>[0]): Promise<HypeDexerApiResponse> {
    return this.client.getAuctionsLive(p);
  }

  public getPairs(p: Parameters<HypeDexerSpotIndexerClient['getPairs']>[0]): Promise<HypeDexerApiResponse> {
    return this.client.getPairs(p);
  }

  public getTokens(p: Parameters<HypeDexerSpotIndexerClient['getTokens']>[0]): Promise<HypeDexerApiResponse> {
    return this.client.getTokens(p);
  }
}
