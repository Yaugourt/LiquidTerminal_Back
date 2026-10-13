import {
  HypeDexerTwapsClient,
  IndexerTwapsListQuery,
  IndexerTwapsStatsQuery,
  IndexerTwapsUserQuery,
} from '../../clients/hypedexer/rest/twaps/twaps.client';
import { buildHypedexerCacheKey } from '../../clients/hypedexer/rest/shared/hypedexer-cache.helper';
import { cacheService } from '../../core/cache.service';
import { HYPEDEXER_USER_CACHE_KEY, HYPEDEXER_TTL } from '../../constants/hypedexer.cache';

export class IndexerTwapsService {
  private static instance: IndexerTwapsService;
  private readonly client = HypeDexerTwapsClient.getInstance();
  /** The front's TWAP source pages with limit=500; the flow card asks 150. */
  private static readonly SOURCE_PAGE_LIMIT = 500;

  public static getInstance(): IndexerTwapsService {
    if (!IndexerTwapsService.instance) {
      IndexerTwapsService.instance = new IndexerTwapsService();
    }
    return IndexerTwapsService.instance;
  }

  /**
   * Shared by every visitor. Two readers: the TWAP flow card (150 rows) and
   * the front's primary TWAP source (pages of 500 walked by /market/twap, the
   * dashboard board and token pages). Every source page is kept 10 s (~52
   * credits a page per refresh, shared by every visitor). The front reads
   * the first page on every poll (new TWAPs and their progress within ~10-25
   * s end to end) and walks the deeper pages once a minute (twap-source.ts
   * DEEP_TTL_MS), so rows past the first 500 are up to ~70 s old there.
   *
   * Source pages don't serve their last copy while they refresh: an expired
   * page waits for its fetch, so the pages of one walk come from snapshots
   * at most ~10 s apart and few rows cross a page boundary between them (a
   * copy served without waiting could be a minute older than its
   * neighbours). The copy is still served when a fetch fails.
   */
  public listTwaps(params: IndexerTwapsListQuery): Promise<unknown> {
    const paging = (params.limit ?? 0) >= IndexerTwapsService.SOURCE_PAGE_LIMIT;
    return cacheService.getOrSet(
      buildHypedexerCacheKey('twaps', 'list', { ...params }),
      () => this.client.listTwaps(params),
      paging ? HYPEDEXER_TTL.twapSourcePages : HYPEDEXER_TTL.marketList,
      paging ? { staleWhileRevalidate: false } : {}
    );
  }

  public getStats(params: IndexerTwapsStatsQuery): Promise<unknown> {
    return this.client.getStats(params);
  }

  public getUserTwaps(userAddress: string, params: IndexerTwapsUserQuery): Promise<unknown> {
    // IndexerTwapsUserQuery has no date params — always cache
    return cacheService.getOrSet(
      HYPEDEXER_USER_CACHE_KEY.twaps(userAddress, params),
      () => this.client.getUserTwaps(userAddress, params),
      HYPEDEXER_TTL.userAddress
    );
  }

  public getTwap(twapId: string): Promise<unknown> {
    return this.client.getTwap(twapId);
  }

  public getTwapFills(
    twapId: string,
    params: { limit?: number; offset?: number; order?: string }
  ): Promise<unknown> {
    return this.client.getTwapFills(twapId, params);
  }
}
