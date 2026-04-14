import { HypeDexerHip3Client } from '../../clients/hypedexer/rest/hip3/hip3.client';
import type { HypeDexerApiResponse } from '../../types/hypedexer-api.types';

/**
 * Passthrough to HypeDexer /hip3/* (no Redis cache).
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

  public getAssets(p: Parameters<HypeDexerHip3Client['getAssets']>[0]): Promise<HypeDexerApiResponse> {
    return this.client.getAssets(p);
  }

  public getAssetByTicker(ticker: string): Promise<HypeDexerApiResponse> {
    return this.client.getAssetByTicker(ticker);
  }

  public getDexs(p: Parameters<HypeDexerHip3Client['getDexs']>[0]): Promise<HypeDexerApiResponse> {
    return this.client.getDexs(p);
  }

  public getDexById(id: string): Promise<HypeDexerApiResponse> {
    return this.client.getDexById(id);
  }

  public getOverview(): Promise<HypeDexerApiResponse> {
    return this.client.getOverview();
  }

  public getPriorityFeesGossipStatus(): Promise<HypeDexerApiResponse> {
    return this.client.getPriorityFeesGossipStatus();
  }

  public getPriorityFeesGossipHistory(
    p: Parameters<HypeDexerHip3Client['getPriorityFeesGossipHistory']>[0]
  ): Promise<HypeDexerApiResponse> {
    return this.client.getPriorityFeesGossipHistory(p);
  }

  public getAuctions(p: Parameters<HypeDexerHip3Client['getAuctions']>[0]): Promise<HypeDexerApiResponse> {
    return this.client.getAuctions(p);
  }

  public getAuctionCurrent(): Promise<HypeDexerApiResponse> {
    return this.client.getAuctionCurrent();
  }

  public getAuctionsHistory(p: Parameters<HypeDexerHip3Client['getAuctionsHistory']>[0]): Promise<HypeDexerApiResponse> {
    return this.client.getAuctionsHistory(p);
  }

  public getFills(p: Parameters<HypeDexerHip3Client['getFills']>[0]): Promise<HypeDexerApiResponse> {
    return this.client.getFills(p);
  }

  public getLeaderboard(p: Parameters<HypeDexerHip3Client['getLeaderboard']>[0]): Promise<HypeDexerApiResponse> {
    return this.client.getLeaderboard(p);
  }

  public getOhlcv(p: Parameters<HypeDexerHip3Client['getOhlcv']>[0]): Promise<HypeDexerApiResponse> {
    return this.client.getOhlcv(p);
  }

  public getOracleStats(p: Parameters<HypeDexerHip3Client['getOracleStats']>[0]): Promise<HypeDexerApiResponse> {
    return this.client.getOracleStats(p);
  }

  public getSnapshots(p: Parameters<HypeDexerHip3Client['getSnapshots']>[0]): Promise<HypeDexerApiResponse> {
    return this.client.getSnapshots(p);
  }

  public getStatsTraders(p: Parameters<HypeDexerHip3Client['getStatsTraders']>[0]): Promise<HypeDexerApiResponse> {
    return this.client.getStatsTraders(p);
  }

  public getTopMovers(p: Parameters<HypeDexerHip3Client['getTopMovers']>[0]): Promise<HypeDexerApiResponse> {
    return this.client.getTopMovers(p);
  }

  public getUserCoins(address: string, p: Parameters<HypeDexerHip3Client['getUserCoins']>[1]): Promise<HypeDexerApiResponse> {
    return this.client.getUserCoins(address, p);
  }

  public getUserFills(address: string, p: Parameters<HypeDexerHip3Client['getUserFills']>[1]): Promise<HypeDexerApiResponse> {
    return this.client.getUserFills(address, p);
  }

  public getUserOverview(address: string): Promise<HypeDexerApiResponse> {
    return this.client.getUserOverview(address);
  }
}
