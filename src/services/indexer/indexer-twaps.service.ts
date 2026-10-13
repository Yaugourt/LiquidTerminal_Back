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
   * Shared by every visitor. Two readers: the TWAP flow card (150 rows polled
   * every minute) and the front's primary TWAP source (pages of 500, polled
   * every 30 s by /market/twap, the dashboard board and token pages), which
   * gets the shorter TTL so a new TWAP shows up within ~half a minute and its
   * pages come from close snapshots.
   */
  public listTwaps(params: IndexerTwapsListQuery): Promise<unknown> {
    const paging = (params.limit ?? 0) >= IndexerTwapsService.SOURCE_PAGE_LIMIT;
    return cacheService.getOrSet(
      buildHypedexerCacheKey('twaps', 'list', { ...params }),
      () => this.client.listTwaps(params),
      paging ? HYPEDEXER_TTL.twapSourcePages : HYPEDEXER_TTL.marketList
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
