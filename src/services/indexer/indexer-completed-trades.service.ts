import {
  HypeDexerCompletedTradesClient,
  IndexerCompletedTradesQuery,
  IndexerCompletedTradesSummaryQuery,
} from '../../clients/hypedexer/rest/completed-trades/completed-trades.client';

export class IndexerCompletedTradesService {
  private static instance: IndexerCompletedTradesService;
  private readonly client = HypeDexerCompletedTradesClient.getInstance();

  public static getInstance(): IndexerCompletedTradesService {
    if (!IndexerCompletedTradesService.instance) {
      IndexerCompletedTradesService.instance = new IndexerCompletedTradesService();
    }
    return IndexerCompletedTradesService.instance;
  }

  public async listCompletedTrades(params: IndexerCompletedTradesQuery): Promise<unknown> {
    return this.client.listCompletedTrades(params);
  }

  public async getSummary(params: IndexerCompletedTradesSummaryQuery): Promise<unknown> {
    return this.client.getSummary(params);
  }

  public async getTradeFills(tradeId: string): Promise<unknown> {
    return this.client.getTradeFills(tradeId);
  }
}
