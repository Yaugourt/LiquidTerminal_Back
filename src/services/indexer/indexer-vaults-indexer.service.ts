import { HypeDexerVaultsIndexerClient, UserVaultEquitiesQuery } from '../../clients/hypedexer/rest/vaults/vaults-indexer.client';
import { cacheService } from '../../core/cache.service';
import { HYPEDEXER_USER_CACHE_KEY, HYPEDEXER_TTL } from '../../constants/hypedexer.cache';

export class IndexerVaultsIndexerService {
  private static instance: IndexerVaultsIndexerService;
  private readonly client = HypeDexerVaultsIndexerClient.getInstance();

  public static getInstance(): IndexerVaultsIndexerService {
    if (!IndexerVaultsIndexerService.instance) {
      IndexerVaultsIndexerService.instance = new IndexerVaultsIndexerService();
    }
    return IndexerVaultsIndexerService.instance;
  }

  public getVaultDetails(p: Parameters<HypeDexerVaultsIndexerClient['getVaultDetails']>[0]): Promise<unknown> {
    return this.client.getVaultDetails(p);
  }

  public getVaultSummaries(p: Parameters<HypeDexerVaultsIndexerClient['getVaultSummaries']>[0]): Promise<unknown> {
    return this.client.getVaultSummaries(p);
  }

  public getUserVaultEquities(p: UserVaultEquitiesQuery): Promise<unknown> {
    if (p.startTime || p.endTime) {
      return this.client.getUserVaultEquities(p);
    }
    return cacheService.getOrSet(
      HYPEDEXER_USER_CACHE_KEY.vaultEquities(p.user),
      () => this.client.getUserVaultEquities(p),
      HYPEDEXER_TTL.userAddress
    );
  }

  public getDailySnapshots(p: Parameters<HypeDexerVaultsIndexerClient['getDailySnapshots']>[0]): Promise<unknown> {
    return this.client.getDailySnapshots(p);
  }

  public getEquitySnapshots(p: Parameters<HypeDexerVaultsIndexerClient['getEquitySnapshots']>[0]): Promise<unknown> {
    return this.client.getEquitySnapshots(p);
  }

  public getVaultLedger(p: Parameters<HypeDexerVaultsIndexerClient['getVaultLedger']>[0]): Promise<unknown> {
    return this.client.getVaultLedger(p);
  }
}
