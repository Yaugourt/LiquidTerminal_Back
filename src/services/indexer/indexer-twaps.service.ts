import {
  HypeDexerTwapsClient,
  IndexerTwapsListQuery,
  IndexerTwapsStatsQuery,
  IndexerTwapsUserQuery,
} from '../../clients/hypedexer/rest/twaps/twaps.client';
import { buildHypedexerCacheKey } from '../../clients/hypedexer/rest/shared/hypedexer-cache.helper';
import { cacheService } from '../../core/cache.service';
import { HYPEDEXER_USER_CACHE_KEY, HYPEDEXER_TTL, HYPEDEXER_TWAPS_CACHE_KEY } from '../../constants/hypedexer.cache';

/** A row of `/twaps` as the front reads it (timestamps are UTC without a zone suffix). */
export interface IndexerTwap {
  twapId: number;
  status: string;
  coin: string;
  user: string;
  side: string;
  sz: number;
  executedSz: number;
  executedNtl: number;
  minutes: number;
  reduceOnly: boolean;
  randomize: boolean;
  startTime: string;
  updatedAt: string;
}

/**
 * What the front lists: the last 24 h of TWAPs (`recent`) and the ones still
 * running from before (`running`), without their deep rows (the first page
 * and what was seen on it since the deep walk). The deep rows are ~90% of the
 * bytes and change once a minute: they are served apart by getTwapSourceDeep,
 * and `deepAt` tells which walk this payload was merged against.
 */
export interface IndexerTwapSource {
  recent: IndexerTwap[];
  running: IndexerTwap[];
  /** Start of the deep walk per query; null when its first page is not full (nothing deeper). */
  deepAt: Record<SourceQueryName, number | null>;
  /** Epoch ms of the refresh that built it. */
  updatedAt: number;
}

/** The deep rows per query; null when the query has nothing deeper. */
export type IndexerTwapSourceDeep = Record<SourceQueryName, DeepRows | null>;

/** The two queries behind the source, by name. */
type SourceQueryName = 'recent' | 'running';
const SOURCE_QUERIES: Record<SourceQueryName, IndexerTwapsListQuery> = {
  recent: { hours: 24 },
  // Running TWAPs last at most 7 days (10,080 min): 170 h covers them all.
  running: { status: 'activated', hours: 170 },
};

const PAGE = 500;
const MAX_PAGES = 12;

/** Deep rows of one query and the start of the walk that read them. */
export interface DeepRows {
  at: number;
  rows: IndexerTwap[];
}

/** First-page rows seen by this process, by twapId, with when. */
type SeenRows = Map<number, { row: IndexerTwap; at: number }>;

export class IndexerTwapsService {
  private static instance: IndexerTwapsService;
  private readonly client = HypeDexerTwapsClient.getInstance();
  /** The front's TWAP source pages with limit=500; the flow card asks 150. */
  private static readonly SOURCE_PAGE_LIMIT = 500;
  /** Per query, in this process: see readSourceQuery. */
  private readonly seen = new Map<SourceQueryName, SeenRows>();

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
   * credits a page per refresh, shared by every visitor). getTwapSource
   * reads them for the front: the first page on every refresh (new TWAPs and
   * their progress within ~10-25 s end to end), the deeper pages once a
   * minute, so rows past the first 500 are up to ~70 s old there.
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

  /**
   * The front's TWAP source in ONE shared entry (15 s): the last 24 h of
   * TWAPs (`recent`) and the ones still running (`running`). Each query is
   * read as pages of 500 through listTwaps (so the page keys stay shared with
   * fronts that still walk them), up to 12 pages, stopping at the first page
   * of fewer than 500 rows.
   *
   * The first page is re-read on every refresh. The deeper pages (offset > 0)
   * hold older, slower-moving rows: they are walked at most once a minute per
   * query, for every visitor and instance (`twapSourceDeep`), and their last
   * copy keeps being served while a walk runs or fails. Without this each
   * visitor walked them on its own clock, refreshing every deep page at its
   * 10 s TTL and spending ~15 requests of its IP's passthrough budget a walk.
   * Their rows are not part of this payload (see IndexerTwapSource): its
   * `deepAt` names the walk, getTwapSourceDeep serves the rows.
   *
   * Throws when a first page (or a deep walk with no previous copy) fails:
   * cacheService then serves the last aggregate, and the route answers 503
   * when there is none.
   */
  public getTwapSource(): Promise<IndexerTwapSource> {
    return cacheService.getOrSet(
      HYPEDEXER_TWAPS_CACHE_KEY.source,
      () => this.computeTwapSource(),
      HYPEDEXER_TTL.twapSource,
      { lastCopy: true, refreshInBackground: true }
    );
  }

  /**
   * The deep rows of both queries, from the same keys the aggregate walks
   * them under (a missing one is walked, once, for everyone). A query whose
   * first page is not full in the current aggregate has none: null.
   */
  public async getTwapSourceDeep(): Promise<IndexerTwapSourceDeep> {
    const { deepAt } = await this.getTwapSource();
    const [recent, running] = await Promise.all(
      (['recent', 'running'] as const).map((name) => (deepAt[name] === null ? null : this.readDeepRows(name)))
    );
    return { recent, running };
  }

  private async computeTwapSource(): Promise<IndexerTwapSource> {
    const [recent, running] = await Promise.all([this.readSourceQuery('recent'), this.readSourceQuery('running')]);
    return {
      recent: recent.rows,
      running: running.rows,
      deepAt: { recent: recent.deepAt, running: running.deepAt },
      updatedAt: Date.now(),
    };
  }

  /** The deep rows of a query under their own key: a missing copy starts the walk, later ones refresh in the background. */
  private readDeepRows(name: SourceQueryName): Promise<DeepRows> {
    return cacheService.getOrSet(
      HYPEDEXER_TWAPS_CACHE_KEY.sourceDeep(name),
      () => this.walkDeepPages(SOURCE_QUERIES[name]),
      HYPEDEXER_TTL.twapSourceDeep,
      { lastCopy: true, refreshInBackground: true }
    );
  }

  /** One query's rows past its deep walk: the current first page and what was seen on it since. */
  private async readSourceQuery(name: SourceQueryName): Promise<{ rows: IndexerTwap[]; deepAt: number | null }> {
    const first = await this.readSourcePage(SOURCE_QUERIES[name], 0);
    // Not full: nothing is deeper, and nothing can have been pushed past it.
    if (first.length < PAGE) {
      this.seen.delete(name);
      return { rows: [...new Map(first.map((t) => [t.twapId, t])).values()], deepAt: null };
    }
    const deep = await this.readDeepRows(name);
    // A first-page row pushed past the page by newer TWAPs stays listed (with
    // its last-seen state) until a deep walk picks it up at its new offset:
    // keep what was seen since the current walk started.
    const kept: SeenRows = new Map();
    for (const [id, entry] of this.seen.get(name) ?? []) {
      if (entry.at >= deep.at) kept.set(id, entry);
    }
    const now = Date.now();
    // Fresher wins: the current first page over earlier sightings.
    for (const row of first) kept.set(row.twapId, { row, at: now });
    this.seen.set(name, kept);
    return { rows: [...kept.values()].map((e) => e.row), deepAt: deep.at };
  }

  /** Pages 1.. of a query, one after the other, until a page is not full. */
  private async walkDeepPages(query: IndexerTwapsListQuery): Promise<DeepRows> {
    const at = Date.now();
    const rows: IndexerTwap[] = [];
    for (let i = 1; i < MAX_PAGES; i++) {
      const page = await this.readSourcePage(query, i);
      rows.push(...page);
      if (page.length < PAGE) break;
    }
    return { at, rows };
  }

  private async readSourcePage(query: IndexerTwapsListQuery, i: number): Promise<IndexerTwap[]> {
    const raw = await this.listTwaps({ ...query, limit: PAGE, offset: i * PAGE });
    if (!Array.isArray(raw)) throw new Error('Unexpected indexer TWAPs payload');
    return raw as IndexerTwap[];
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
