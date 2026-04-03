import {
  HypeDexerCompletedTradesClient,
  IndexerCompletedTradesQuery,
  IndexerCompletedTradesSummaryQuery,
} from '../../clients/hypedexer/rest/completed-trades/completed-trades.client';
import type { HypeDexerApiResponse } from '../../types/hypedexer-api.types';

export class IndexerCompletedTradesService {
  private static instance: IndexerCompletedTradesService;
  private readonly client = HypeDexerCompletedTradesClient.getInstance();

  public static getInstance(): IndexerCompletedTradesService {
    if (!IndexerCompletedTradesService.instance) {
      IndexerCompletedTradesService.instance = new IndexerCompletedTradesService();
    }
    return IndexerCompletedTradesService.instance;
  }

  public async listCompletedTrades(params: IndexerCompletedTradesQuery): Promise<HypeDexerApiResponse> {
    return this.client.listCompletedTrades(params);
  }

  public async getSummary(params: IndexerCompletedTradesSummaryQuery): Promise<HypeDexerApiResponse> {
    return this.client.getSummary(params);
  }

  public async getTradeFills(tradeId: string): Promise<HypeDexerApiResponse> {
    return this.client.getTradeFills(tradeId);
  }
}
