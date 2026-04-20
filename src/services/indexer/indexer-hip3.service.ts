import { HypeDexerHip3Client } from '../../clients/hypedexer/rest/hip3/hip3.client';
import { cacheService } from '../../core/cache.service';
import { HYPEDEXER_CACHE_KEYS, HYPEDEXER_TTL, HYPEDEXER_USER_CACHE_KEY } from '../../constants/hypedexer.cache';

/**
 * Passthrough to HypeDexer /hip3/* with Redis cache on global (param-free) endpoints.
 */
export class IndexerHip3Service {
  private static instance: IndexerHip3Service;
  private readonly client = HypeDexerHip3Client.getInstance();

  public static getInstance(): IndexerHip3Service {
    if (!IndexerHip3Service.instance) {
      IndexerHip3Service.instance = new IndexerHip3Service();
    }
    return IndexerHip3Service.instance;
  }

  public getAssets(p: Parameters<HypeDexerHip3Client['getAssets']>[0]): Promise<unknown> {
    return this.client.getAssets(p);
  }

  public getAssetByTicker(ticker: string): Promise<unknown> {
    return this.client.getAssetByTicker(ticker);
  }

  public getDexs(p: Parameters<HypeDexerHip3Client['getDexs']>[0]): Promise<unknown> {
    return this.client.getDexs(p);
  }

  public getDexById(id: string): Promise<unknown> {
    return this.client.getDexById(id);
  }

  public getOverview(): Promise<unknown> {
    return cacheService.getOrSet<unknown>(
      HYPEDEXER_CACHE_KEYS.hip3Overview,
      () => this.client.getOverview(),
      HYPEDEXER_TTL.globalRolling
    );
  }

  public getPriorityFeesGossipStatus(): Promise<unknown> {
    return this.client.getPriorityFeesGossipStatus();
  }

  public getPriorityFeesGossipHistory(
    p: Parameters<HypeDexerHip3Client['getPriorityFeesGossipHistory']>[0]
  ): Promise<unknown> {
    return this.client.getPriorityFeesGossipHistory(p);
  }

  public getAuctions(p: Parameters<HypeDexerHip3Client['getAuctions']>[0]): Promise<unknown> {
    return this.client.getAuctions(p);
  }

  public getAuctionCurrent(): Promise<unknown> {
    return cacheService.getOrSet<unknown>(
      HYPEDEXER_CACHE_KEYS.hip3AuctionCurrent,
      () => this.client.getAuctionCurrent(),
      HYPEDEXER_TTL.globalRolling
    );
  }

  public getAuctionsHistory(p: Parameters<HypeDexerHip3Client['getAuctionsHistory']>[0]): Promise<unknown> {
    return this.client.getAuctionsHistory(p);
  }

  public getFills(p: Parameters<HypeDexerHip3Client['getFills']>[0]): Promise<unknown> {
    return this.client.getFills(p);
  }

  public getLeaderboard(p: Parameters<HypeDexerHip3Client['getLeaderboard']>[0]): Promise<unknown> {
    return this.client.getLeaderboard(p);
  }

  public getOhlcv(p: Parameters<HypeDexerHip3Client['getOhlcv']>[0]): Promise<unknown> {
    return this.client.getOhlcv(p);
  }

  public getOracleStats(p: Parameters<HypeDexerHip3Client['getOracleStats']>[0]): Promise<unknown> {
    return this.client.getOracleStats(p);
  }

  public getSnapshots(p: Parameters<HypeDexerHip3Client['getSnapshots']>[0]): Promise<unknown> {
    return this.client.getSnapshots(p);
  }

  public getStatsTraders(p: Parameters<HypeDexerHip3Client['getStatsTraders']>[0]): Promise<unknown> {
    return this.client.getStatsTraders(p);
  }

  public getTopMovers(p: Parameters<HypeDexerHip3Client['getTopMovers']>[0]): Promise<unknown> {
    return this.client.getTopMovers(p);
  }

  public getUserCoins(address: string, p: Parameters<HypeDexerHip3Client['getUserCoins']>[1]): Promise<unknown> {
    // No date params in getUserCoins — always cache
    return cacheService.getOrSet(
      HYPEDEXER_USER_CACHE_KEY.hip3Coins(address),
      () => this.client.getUserCoins(address, p),
      HYPEDEXER_TTL.userAddress
    );
  }

  public getUserFills(address: string, p: Parameters<HypeDexerHip3Client['getUserFills']>[1]): Promise<unknown> {
    if (p?.start || p?.end) {
      return this.client.getUserFills(address, p);
    }
    return cacheService.getOrSet(
      HYPEDEXER_USER_CACHE_KEY.hip3Fills(address),
      () => this.client.getUserFills(address, p),
      HYPEDEXER_TTL.userAddress
    );
  }

  public getUserOverview(address: string): Promise<unknown> {
    return cacheService.getOrSet(
      HYPEDEXER_USER_CACHE_KEY.hip3Overview(address),
      () => this.client.getUserOverview(address),
      HYPEDEXER_TTL.userAddress
    );
  }
}
