import { HypeDexerVaultsIndexerClient } from '../../clients/hypedexer/rest/vaults/vaults-indexer.client';
import type { HypeDexerApiResponse } from '../../types/hypedexer-api.types';

export class IndexerVaultsIndexerService {
  private static instance: IndexerVaultsIndexerService;
  private readonly client = HypeDexerVaultsIndexerClient.getInstance();

  public static getInstance(): IndexerVaultsIndexerService {
    if (!IndexerVaultsIndexerService.instance) {
      IndexerVaultsIndexerService.instance = new IndexerVaultsIndexerService();
    }
    return IndexerVaultsIndexerService.instance;
  }

  public getVaultDetails(p: Parameters<HypeDexerVaultsIndexerClient['getVaultDetails']>[0]): Promise<HypeDexerApiResponse> {
    return this.client.getVaultDetails(p);
  }

  public getVaultSummaries(p: Parameters<HypeDexerVaultsIndexerClient['getVaultSummaries']>[0]): Promise<HypeDexerApiResponse> {
    return this.client.getVaultSummaries(p);
  }

  public getUserVaultEquities(p: Parameters<HypeDexerVaultsIndexerClient['getUserVaultEquities']>[0]): Promise<HypeDexerApiResponse> {
    return this.client.getUserVaultEquities(p);
  }

  public getDailySnapshots(p: Parameters<HypeDexerVaultsIndexerClient['getDailySnapshots']>[0]): Promise<HypeDexerApiResponse> {
    return this.client.getDailySnapshots(p);
  }

  public getEquitySnapshots(p: Parameters<HypeDexerVaultsIndexerClient['getEquitySnapshots']>[0]): Promise<HypeDexerApiResponse> {
    return this.client.getEquitySnapshots(p);
  }

  public getVaultLedger(p: Parameters<HypeDexerVaultsIndexerClient['getVaultLedger']>[0]): Promise<HypeDexerApiResponse> {
    return this.client.getVaultLedger(p);
  }
}
