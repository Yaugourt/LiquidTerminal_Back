import { HypeDexerOverviewIndexerClient } from '../../clients/hypedexer/rest/overview/overview-indexer.client';
import { cacheService } from '../../core/cache.service';
import { HYPEDEXER_CACHE_KEYS, HYPEDEXER_TTL, HYPEDEXER_USER_CACHE_KEY } from '../../constants/hypedexer.cache';

export class IndexerOverviewService {
  private static instance: IndexerOverviewService;
  private readonly client = HypeDexerOverviewIndexerClient.getInstance();

  public static getInstance(): IndexerOverviewService {
    if (!IndexerOverviewService.instance) {
      IndexerOverviewService.instance = new IndexerOverviewService();
    }
    return IndexerOverviewService.instance;
  }

  public getActiveTraders24h(): Promise<unknown> {
    return cacheService.getOrSet<unknown>(
      HYPEDEXER_CACHE_KEYS.overviewActiveTraders24h,
      () => this.client.getActiveTraders24h(),
      HYPEDEXER_TTL.globalRolling
    );
  }

  public getCoinDistribution(user: string): Promise<unknown> {
    return cacheService.getOrSet(
      HYPEDEXER_USER_CACHE_KEY.coinDistribution(user),
      () => this.client.getCoinDistribution({ user }),
      HYPEDEXER_TTL.userAddress
    );
  }

  public getDailyPnl10d(): Promise<unknown> {
    return cacheService.getOrSet<unknown>(
      HYPEDEXER_CACHE_KEYS.overviewDailyPnl10d,
      () => this.client.getDailyPnl10d(),
      HYPEDEXER_TTL.globalSnapshot
    );
  }

  public getDailyVolume10d(): Promise<unknown> {
    return cacheService.getOrSet<unknown>(
      HYPEDEXER_CACHE_KEYS.overviewDailyVolume10d,
      () => this.client.getDailyVolume10d(),
      HYPEDEXER_TTL.globalSnapshot
    );
  }

  public getTotalFees24h(): Promise<unknown> {
    return cacheService.getOrSet<unknown>(
      HYPEDEXER_CACHE_KEYS.overviewTotalFees24h,
      () => this.client.getTotalFees24h(),
      HYPEDEXER_TTL.globalRolling
    );
  }

  public getTotalFills24h(): Promise<unknown> {
    return cacheService.getOrSet<unknown>(
      HYPEDEXER_CACHE_KEYS.overviewTotalFills24h,
      () => this.client.getTotalFills24h(),
      HYPEDEXER_TTL.globalRolling
    );
  }

  public getTradingVolume24h(): Promise<unknown> {
    return cacheService.getOrSet<unknown>(
      HYPEDEXER_CACHE_KEYS.overviewTradingVolume24h,
      () => this.client.getTradingVolume24h(),
      HYPEDEXER_TTL.globalRolling
    );
  }
}
