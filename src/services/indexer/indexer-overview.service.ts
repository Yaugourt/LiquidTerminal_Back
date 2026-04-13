import { HypeDexerOverviewIndexerClient } from '../../clients/hypedexer/rest/overview/overview-indexer.client';
import type { HypeDexerApiResponse } from '../../types/hypedexer-api.types';

export class IndexerOverviewService {
  private static instance: IndexerOverviewService;
  private readonly client = HypeDexerOverviewIndexerClient.getInstance();

  public static getInstance(): IndexerOverviewService {
    if (!IndexerOverviewService.instance) {
      IndexerOverviewService.instance = new IndexerOverviewService();
    }
    return IndexerOverviewService.instance;
  }

  public getActiveTraders24h(): Promise<HypeDexerApiResponse> {
    return this.client.getActiveTraders24h();
  }

  public getCoinDistribution(user: string): Promise<HypeDexerApiResponse> {
    return this.client.getCoinDistribution({ user });
  }

  public getDailyPnl10d(): Promise<HypeDexerApiResponse> {
    return this.client.getDailyPnl10d();
  }

  public getDailyVolume10d(): Promise<HypeDexerApiResponse> {
    return this.client.getDailyVolume10d();
  }

  public getTotalFees24h(): Promise<HypeDexerApiResponse> {
    return this.client.getTotalFees24h();
  }

  public getTotalFills24h(): Promise<HypeDexerApiResponse> {
    return this.client.getTotalFills24h();
  }

  public getTradingVolume24h(): Promise<HypeDexerApiResponse> {
    return this.client.getTradingVolume24h();
  }
}
