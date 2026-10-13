import {
  HypeDexerBuildersIndexerClient,
  IndexerBuilderDetailQuery,
  IndexerBuilderUsersQuery,
  IndexerBuildersTopQuery,
  IndexerBuildersTimeframe,
} from '../../clients/hypedexer/rest/builders/builders-indexer.client';
import { HLIndexerBuildersClient } from '../../clients/hypedexer/rest/builders/builders-list-poller.client';
import { cacheService, SHARED_LAST_COPY_KEEP_S } from '../../core/cache.service';
import { HYPEDEXER_BUILDERS_CACHE_KEY, HYPEDEXER_TTL } from '../../constants/hypedexer.cache';

/**
 * Passthrough for HypeDexer /builders/* REST under /indexer/builders. The list
 * itself comes from the Redis key the poller (`builders-list-poller.client.ts`)
 * keeps warm.
 */
export class IndexerBuildersIndexerService {
  private static instance: IndexerBuildersIndexerService;
  private readonly client = HypeDexerBuildersIndexerClient.getInstance();
  private readonly listPoller = HLIndexerBuildersClient.getInstance();

  public static getInstance(): IndexerBuildersIndexerService {
    if (!IndexerBuildersIndexerService.instance) {
      IndexerBuildersIndexerService.instance = new IndexerBuildersIndexerService();
    }
    return IndexerBuildersIndexerService.instance;
  }

  /**
   * Upstream ignores every param of `/builders/list` (same 1 400+ rows, same
   * order, with or without `limit`/`sort`: checked 2026-09-28), so the poller's
   * copy is exactly what a direct call would return — minus ~150 credits.
   */
  public async listBuilders(): Promise<unknown> {
    const response = await this.listPoller.getAllBuilders();
    return response.data;
  }

  public async getGlobalStats(timeframe?: IndexerBuildersTimeframe): Promise<unknown> {
    const tf = timeframe ?? '24h';
    return cacheService.getOrSet(
      HYPEDEXER_BUILDERS_CACHE_KEY.stats(tf),
      () => this.client.getGlobalStats(timeframe),
      HYPEDEXER_TTL.buildersStats,
      // One key per timeframe: the last copy is kept an hour, so an outage still shows the last figures.
      { lastCopyKeepS: SHARED_LAST_COPY_KEEP_S }
    );
  }

  /** Slow upstream: an expired entry is served from its last copy while one refresh runs. */
  public async getStatsAllTimeframes(): Promise<unknown> {
    return cacheService.getOrSet(
      HYPEDEXER_BUILDERS_CACHE_KEY.statsAllTimeframes,
      () => this.client.getStatsAllTimeframes(),
      HYPEDEXER_TTL.buildersAllTimeframes,
      { refreshInBackground: true, lastCopyKeepS: SHARED_LAST_COPY_KEEP_S }
    );
  }

  public async getTopBuilders(params: IndexerBuildersTopQuery = {}): Promise<unknown> {
    const tf = params.timeframe ?? '24h';
    const sort = params.sort ?? 'volume';
    // Every limit is cached: the pages ask for 3, 5 and 100, which all used to
    // bypass the cache (only the default 25 was kept).
    return cacheService.getOrSet(
      HYPEDEXER_BUILDERS_CACHE_KEY.top(tf, sort, params.limit ?? 25),
      () => this.client.getTopBuilders(params),
      HYPEDEXER_TTL.buildersTop
    );
  }

  /**
   * A builder page polls its stats and users every 15 s: shared by every
   * viewer of that builder (one upstream call per key and TTL, not per viewer).
   */
  public async getBuilderStats(
    builderAddress: string,
    params: IndexerBuilderDetailQuery
  ): Promise<unknown> {
    return cacheService.getOrSet(
      HYPEDEXER_BUILDERS_CACHE_KEY.builderStats(builderAddress, params.timeframe ?? 'default'),
      () => this.client.getBuilderStats(builderAddress, params),
      HYPEDEXER_TTL.buildersStats
    );
  }

  public async getBuilderUsers(
    builderAddress: string,
    params: IndexerBuilderUsersQuery
  ): Promise<unknown> {
    return cacheService.getOrSet(
      HYPEDEXER_BUILDERS_CACHE_KEY.builderUsers(
        builderAddress,
        params.timeframe ?? 'default',
        params.limit !== undefined ? String(params.limit) : 'default'
      ),
      () => this.client.getBuilderUsers(builderAddress, params),
      HYPEDEXER_TTL.buildersStats
    );
  }
}
