import {
  HypeDexerFundingClient,
  IndexerFundingHistoryQuery,
  IndexerUserFundingQuery,
} from '../../clients/hypedexer/rest/funding/funding.client';
import type { HypeDexerApiResponse } from '../../types/hypedexer-api.types';

export class IndexerFundingService {
  private static instance: IndexerFundingService;
  private readonly client = HypeDexerFundingClient.getInstance();

  public static getInstance(): IndexerFundingService {
    if (!IndexerFundingService.instance) {
      IndexerFundingService.instance = new IndexerFundingService();
    }
    return IndexerFundingService.instance;
  }

  public async getFundingHistory(params: IndexerFundingHistoryQuery): Promise<HypeDexerApiResponse> {
    return this.client.getFundingHistory(params);
  }

  public async getPredictedFundings(): Promise<HypeDexerApiResponse> {
    return this.client.getPredictedFundings();
  }

  public async getUserFunding(params: IndexerUserFundingQuery): Promise<HypeDexerApiResponse> {
    return this.client.getUserFunding(params);
  }
}
