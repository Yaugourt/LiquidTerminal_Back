import { HypeDexerEvmIndexerClient } from '../../clients/hypedexer/rest/evm/evm-indexer.client';
import type { EvmBlocksQuery, EvmBridgeEventsQuery, EvmLedgerTransfersQuery, EvmTransactionsQuery } from '../../clients/hypedexer/rest/evm/evm-indexer.client';
import { cacheService } from '../../core/cache.service';
import { HYPEDEXER_CACHE_KEYS, HYPEDEXER_TTL } from '../../constants/hypedexer.cache';

export class IndexerEvmService {
  private static instance: IndexerEvmService;
  private readonly client = HypeDexerEvmIndexerClient.getInstance();

  public static getInstance(): IndexerEvmService {
    if (!IndexerEvmService.instance) {
      IndexerEvmService.instance = new IndexerEvmService();
    }
    return IndexerEvmService.instance;
  }

  public getEvmStats(): Promise<unknown> {
    return cacheService.getOrSet<unknown>(
      HYPEDEXER_CACHE_KEYS.evmStats,
      () => this.client.getEvmStats(),
      HYPEDEXER_TTL.evmStats
    );
  }

  public getEvmStatsDaily(days?: number): Promise<unknown> {
    if (days !== undefined) {
      return this.client.getEvmStatsDaily({ days });
    }
    return cacheService.getOrSet<unknown>(
      HYPEDEXER_CACHE_KEYS.evmStatsDaily,
      () => this.client.getEvmStatsDaily(),
      HYPEDEXER_TTL.evmStatsDaily
    );
  }

  public getEvmBlocks(params?: EvmBlocksQuery): Promise<unknown> {
    const hasFilter =
      params !== undefined &&
      (params.limit !== undefined || params.start_time !== undefined || params.end_time !== undefined);

    if (hasFilter) {
      return this.client.getEvmBlocks(params);
    }
    return cacheService.getOrSet<unknown>(
      HYPEDEXER_CACHE_KEYS.evmBlocks,
      () => this.client.getEvmBlocks(),
      HYPEDEXER_TTL.evmBlocks
    );
  }

  public getEvmTransactions(params?: EvmTransactionsQuery): Promise<unknown> {
    const hasFilter =
      params !== undefined &&
      (params.limit !== undefined ||
        params.block_number !== undefined ||
        params.to_addr !== undefined ||
        params.start_time !== undefined ||
        params.end_time !== undefined);

    if (hasFilter) {
      return this.client.getEvmTransactions(params);
    }
    return cacheService.getOrSet<unknown>(
      HYPEDEXER_CACHE_KEYS.evmTransactions,
      () => this.client.getEvmTransactions(),
      HYPEDEXER_TTL.evmTransactions
    );
  }

  public getEvmBridgeEvents(params?: EvmBridgeEventsQuery): Promise<unknown> {
    return cacheService.getOrSet<unknown>(
      HYPEDEXER_CACHE_KEYS.evmBridgeEvents,
      () => this.client.getEvmBridgeEvents(params),
      HYPEDEXER_TTL.evmBridgeEvents
    );
  }

  public getEvmLedgerTransfers(params?: EvmLedgerTransfersQuery): Promise<unknown> {
    return cacheService.getOrSet<unknown>(
      HYPEDEXER_CACHE_KEYS.evmLedgerTransfers,
      () => this.client.getEvmLedgerTransfers(params),
      HYPEDEXER_TTL.evmLedgerTransfers
    );
  }
}
