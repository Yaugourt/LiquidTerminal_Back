import { HypeDexerHip4Client } from '../../clients/hypedexer/rest/hip4/hip4.client';
import { buildHypedexerCacheKey } from '../../clients/hypedexer/rest/shared/hypedexer-cache.helper';
import { cacheService, SHARED_LAST_COPY_KEEP_S } from '../../core/cache.service';
import {
  HYPEDEXER_HIP4_CACHE_KEY,
  HYPEDEXER_TTL,
  HYPEDEXER_USER_CACHE_KEY,
} from '../../constants/hypedexer.cache';
import {
  enrichMarkets,
  enrichSettlements,
  buildQuestionsWithOutcomes,
  isBareMarketRow,
  toSideCoinMarket,
  type Hip4MarketEnriched,
  type Hip4QuestionWithOutcomes,
  type Hip4SettlementEnriched,
  type RawHip4Market,
  type RawHip4OutcomeToken,
  type RawHip4Question,
  type RawHip4Settlement,
} from '../../utils/hip4-enrichment.util';
import { indexOutcomeTemplates, type Hip4TemplateIndex } from '../../utils/hip4-market-names.util';

type Hip4FillsQuery = NonNullable<Parameters<HypeDexerHip4Client['getFills']>[0]>;

const HOUR_MS = 60 * 60 * 1000;
const HL_INFO_URL = 'https://api.hyperliquid.xyz/info';

/** allMids (weight 2) is read at most this often, whatever the number of enriched keys and visitors. */
const MIDS_FRESH_MS = 5_000;
const MIDS_TIMEOUT_MS = 3_000;
/** A last good map up to this old is served while a refresh runs; older, callers wait for it. */
const MIDS_MAX_STALE_MS = 60_000;

/**
 * HIP-4 mid prices from Hyperliquid allMids, shared by every enriched
 * assembly (markets, questions, settlements, outcome lookups): one read per
 * MIDS_FRESH_MS at most (≤ 12 a minute, 24 weight), single-flight, with a
 * timeout; a failed read keeps the last good map instead of dropping the odds.
 */
export class SharedHip4Mids {
  private last: { mids: Map<string, number>; at: number } | null = null;
  private inflight: Promise<Map<string, number>> | null = null;
  /** No new read before then (set by every attempt, failed ones included). */
  private nextReadAt = 0;

  constructor(private readonly read: () => Promise<Map<string, number>>) {}

  public async get(): Promise<Map<string, number>> {
    const last = this.last;
    const age = last ? Date.now() - last.at : Infinity;
    if (last && (age < MIDS_FRESH_MS || Date.now() < this.nextReadAt)) return last.mids;
    // No read has succeeded yet and the last attempt is under 5 s old: no new
    // read (HL down or 429ing must not get one per enriched recompute).
    if (!last && !this.inflight && Date.now() < this.nextReadAt) return new Map<string, number>();
    const refresh = this.refresh();
    if (last && age < MIDS_MAX_STALE_MS) return last.mids;
    return refresh;
  }

  private refresh(): Promise<Map<string, number>> {
    if (!this.inflight) {
      this.nextReadAt = Date.now() + MIDS_FRESH_MS;
      const inflight = this.read()
        .then((mids) => {
          this.last = { mids, at: Date.now() };
          return mids;
        })
        .catch(() => this.last?.mids ?? new Map<string, number>())
        .finally(() => {
          if (this.inflight === inflight) this.inflight = null;
        });
      this.inflight = inflight;
    }
    return this.inflight;
  }
}
/** Markets read one by one to name a settlements page (the list page asks 50 rows, ~17 markets). */
const SETTLEMENT_LOOKUP_CAP = 50;
const SETTLEMENT_LOOKUP_CONCURRENCY = 4;

/** Run `fn` over `items`, at most `limit` in flight, preserving order. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * How long a market's fills stay cached, from the age of its newest fill. An
 * empty answer may be a market about to open, so it is only kept a minute.
 */
function marketFillsTtl(rows: unknown): number {
  if (!Array.isArray(rows) || rows.length === 0) return HYPEDEXER_TTL.hip4QuietFills;
  let newest = 0;
  for (const row of rows) {
    const t = Number((row as { time_ms?: unknown } | null)?.time_ms);
    if (Number.isFinite(t) && t > newest) newest = t;
  }
  // No readable time (field renamed upstream?): don't mistake it for dormant.
  if (newest === 0) return HYPEDEXER_TTL.hip4QuietFills;
  const age = Date.now() - newest;
  if (age >= 24 * HOUR_MS) return HYPEDEXER_TTL.hip4DormantFills;
  if (age >= HOUR_MS) return HYPEDEXER_TTL.hip4QuietFills;
  return HYPEDEXER_TTL.hip4ActiveFills;
}

/**
 * HIP-4 exposed endpoints — assembles raw HypeDexer responses into frontend-ready
 * shapes. The service is NOT a thin pass-through: it joins markets × outcome-tokens ×
 * questions server-side so the frontend never has to cross-reference them.
 *
 * Exposed surface:
 *   - getMarketsEnriched       → flat, used by charts and fills name resolution
 *   - getQuestionsWithOutcomes → hierarchical, used by the question-grid
 *   - getSettlements           → enriched with winner_name + question_name
 *   - getFills                 → pass-through (raw feed is fine)
 */
export class IndexerHip4Service {
  private static instance: IndexerHip4Service;
  private readonly client = HypeDexerHip4Client.getInstance();
  private readonly mids = new SharedHip4Mids(() => this.readHlMidPrices());

  public static getInstance(): IndexerHip4Service {
    if (!IndexerHip4Service.instance) {
      IndexerHip4Service.instance = new IndexerHip4Service();
    }
    return IndexerHip4Service.instance;
  }

  /** Fills — transform raw API shape to frontend-ready shape. */
  public async getFills(p: Hip4FillsQuery = {}): Promise<unknown> {
    const raw = await this.fetchRawFills(p);
    if (!Array.isArray(raw)) return raw;
    return raw.map((fill) => this.transformFill(fill as Record<string, unknown>));
  }

  private fetchRawFills(p: Hip4FillsQuery): Promise<unknown> {
    if (p.user) {
      if (p.start || p.end) return this.client.getFills(p);
      return cacheService.getOrSet(
        HYPEDEXER_USER_CACHE_KEY.hip4Fills(p.user, {
          coin: p.coin,
          outcome_id: p.outcome_id,
          limit: p.limit,
          offset: p.offset,
        }),
        () => this.client.getFills(p),
        HYPEDEXER_TTL.userFills
      );
    }
    // A market's tape is the same for every visitor: the coin page polls
    // `limit=400` every 15 s and a settled question's chart reads N coins ×
    // 1 000 fills, which used to go upstream once per visitor and per poll.
    return cacheService.getOrSet(
      buildHypedexerCacheKey('hip4', 'fills', { ...p }),
      () => this.client.getFills(p),
      marketFillsTtl
    );
  }

  private transformFill(f: Record<string, unknown>): Record<string, unknown> {
    const timeMs = typeof f.time_ms === 'number' ? f.time_ms : Number(f.time_ms ?? 0);
    const px = Number(f.px ?? 0);
    const sz = Number(f.sz ?? 0);
    const feeUsdc = typeof f.fee_usdc === 'number' ? f.fee_usdc : Number(f.fee_usdc ?? 0);
    return {
      ...f,
      time: new Date(timeMs).toISOString(),
      notional: Number.isFinite(px * sz) ? px * sz : 0,
      fee: feeUsdc,
    };
  }

  /**
   * Flat enriched markets, one Redis entry per param set. The key used to
   * ignore limit/offset, so whichever of `limit=500` (list page) or the default
   * 100 (detail page) filled it first answered both.
   *
   * `outcome_id` looks up that one market instead (other params ignored): the
   * lists hold the oldest markets only (upstream order, no sort), so a deep
   * link to any recent market needs it.
   *
   * Kept 15 s (hip4EnrichedList): the payload carries the live odds
   * (mid_price). A recompute costs no HypeDexer credits (the lists are cached
   * on their own) and the shared allMids; an expired entry is served from its
   * last copy while one refresh runs.
   */
  public async getMarketsEnriched(p: {
    class?: string;
    underlying?: string;
    question_id?: number;
    outcome_id?: number;
    limit?: number;
    offset?: number;
  } = {}): Promise<Hip4MarketEnriched[]> {
    if (p.outcome_id != null) {
      const outcomeId = p.outcome_id;
      return cacheService.getOrSet(
        buildHypedexerCacheKey('hip4', 'markets-enriched', { outcome_id: outcomeId }),
        () => this.assembleMarketByOutcomeId(outcomeId),
        HYPEDEXER_TTL.hip4EnrichedList
      );
    }
    return cacheService.getOrSet(
      buildHypedexerCacheKey('hip4', 'markets-enriched', { ...p }),
      () => this.assembleEnrichedMarkets(p),
      HYPEDEXER_TTL.hip4EnrichedList
    );
  }

  /**
   * Questions with nested outcomes. Singleton markets (no question_id) are
   * surfaced as synthetic 1-outcome questions so the grid handles everything
   * uniformly.
   */
  public async getQuestionsWithOutcomes(p: {
    question_id?: number;
    limit?: number;
    offset?: number;
  } = {}): Promise<Hip4QuestionWithOutcomes[]> {
    const compute = async (): Promise<Hip4QuestionWithOutcomes[]> => {
      const [markets, outcomeTokens, questions, midPrices, templates] = await Promise.all([
        this.fetchRawMarkets(p.question_id != null ? { question_id: p.question_id, limit: p.limit, offset: p.offset } : { limit: p.limit, offset: p.offset }),
        this.fetchRawOutcomeTokens(),
        this.fetchRawQuestions(p.question_id != null ? { question_id: p.question_id } : {}),
        this.fetchHlMidPrices(),
        this.fetchOutcomeTemplates(),
      ]);
      const enriched = enrichMarkets(markets, outcomeTokens, questions, midPrices, templates);
      return buildQuestionsWithOutcomes(enriched, questions);
    };

    // Keyed on every param, like markets-enriched (limit 200 vs default 100).
    return cacheService.getOrSet(
      buildHypedexerCacheKey('hip4', 'questions-with-outcomes', { ...p }),
      compute,
      HYPEDEXER_TTL.hip4EnrichedList
    );
  }

  /**
   * Settlements enriched with winner_name + question_name. Shared for 30 s
   * (the list page's poll): each read joins three upstream metadata lists,
   * cached on their own.
   */
  public async getSettlements(p: {
    outcome_id?: number;
    start?: string;
    end?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<Hip4SettlementEnriched[]> {
    return cacheService.getOrSet(
      buildHypedexerCacheKey('hip4', 'settlements', { ...p }),
      () => this.assembleSettlements(p),
      HYPEDEXER_TTL.hip4Settlements
    );
  }

  private async assembleSettlements(p: {
    outcome_id?: number;
    start?: string;
    end?: string;
    limit?: number;
    offset?: number;
  }): Promise<Hip4SettlementEnriched[]> {
    const [raw, markets, outcomeTokens, questions, midPrices, templates] = await Promise.all([
      this.client.getSettlements<RawHip4Settlement[]>(p),
      this.fetchRawMarkets(),
      this.fetchRawOutcomeTokens(),
      this.fetchRawQuestions(),
      this.fetchHlMidPrices(),
      this.fetchOutcomeTemplates(),
    ]);
    const settlements = asArray<RawHip4Settlement>(raw);
    // The metadata list holds the oldest markets, the settlements are the
    // newest: read each missing market's row (3 credits, kept a day once settled).
    const listed = new Set(markets.map((m) => m.outcome_id));
    const missing = [...new Set(settlements.map((s) => s.outcome_id))]
      .filter((id) => !listed.has(id))
      .slice(0, SETTLEMENT_LOOKUP_CAP);
    const lookedUp = await mapWithConcurrency(missing, SETTLEMENT_LOOKUP_CONCURRENCY, (id) =>
      this.fetchMarketRow(id).catch((): RawHip4Market[] => [])
    );
    const enrichedMarkets = enrichMarkets([...markets, ...lookedUp.flat()], outcomeTokens, questions, midPrices, templates);
    const all = enrichSettlements(settlements, enrichedMarkets, questions);
    // Deduplicate: multiple broadcaster records per outcome → keep latest (highest block_time).
    const seen = new Map<number, Hip4SettlementEnriched>();
    for (const s of all) {
      const existing = seen.get(s.outcome_id);
      if (!existing || s.settled_at > existing.settled_at) seen.set(s.outcome_id, s);
    }
    return Array.from(seen.values());
  }

  /**
   * Time-bucketed analytics — volume, fills, fees and unique traders.
   *
   * Caching strategy, one Redis entry per param set:
   *   - Unfiltered calls (no coin, no outcome_id, no date range): the charts'
   *     buckets, kept a minute.
   *   - The live-market volume fan-out (coin chunks of daily buckets, no
   *     outcome split, no date range): kept 15 s, the HIP-4 pages' poll.
   *     Each call is billed per row, but every visitor sends the same coin
   *     chunks, so the cost doesn't grow with the audience.
   *   - Other filtered calls (outcome splits, date ranges): kept a minute.
   */
  public async getAnalytics(p: {
    interval?: string;
    coin?: string;
    outcome_id?: number;
    start?: string;
    end?: string;
    limit?: number;
  } = {}): Promise<unknown> {
    const q = { ...p, interval: p.interval ?? '1h' };
    const hasFilter = p.coin != null || p.outcome_id != null || p.start != null || p.end != null;
    const liveVolumes =
      p.coin != null && q.interval === '1d' && p.outcome_id == null && p.start == null && p.end == null;

    return cacheService.getOrSet(
      hasFilter
        ? buildHypedexerCacheKey('hip4', 'analytics', { ...q })
        : HYPEDEXER_HIP4_CACHE_KEY.analytics(q.interval, q.limit),
      () => this.client.getAnalytics(q),
      liveVolumes
        ? HYPEDEXER_TTL.hip4LiveVolumes
        : hasFilter ? HYPEDEXER_TTL.hip4AnalyticsFiltered : HYPEDEXER_TTL.hip4Analytics,
    );
  }

  /**
   * One market by id. `#X` is what Hyperliquid trades: side X % 10 of outcome
   * floor(X / 10), whose row holds the market (X's own row is a bare
   * placeholder). So a side-coin id reads its outcome's row (3 credits) and
   * answers from side X. Any other id, or one without such an outcome, is
   * read as an outcome itself.
   */
  private async assembleMarketByOutcomeId(outcomeId: number): Promise<Hip4MarketEnriched[]> {
    const isSideCoin = outcomeId >= 10 && outcomeId % 10 <= 1;
    const [parentRows, templates, midPrices] = await Promise.all([
      isSideCoin ? this.fetchMarketRow(Math.floor(outcomeId / 10)) : Promise.resolve([]),
      this.fetchOutcomeTemplates(),
      this.fetchHlMidPrices(),
    ]);
    const parent = parentRows.find((m) => !isBareMarketRow(m));
    if (parent) {
      const [market] = enrichMarkets([parent], [], [], undefined, templates);
      return [toSideCoinMarket(market, outcomeId % 10, midPrices)];
    }
    const own = (await this.fetchMarketRow(outcomeId)).filter((m) => !isBareMarketRow(m));
    return enrichMarkets(own, [], [], midPrices, templates);
  }

  /**
   * One outcome's raw row (repeats dropped), shared by deep links and
   * settlements. Rows for other ids are dropped too, in case the filter is
   * ever ignored upstream.
   */
  private async fetchMarketRow(outcomeId: number): Promise<RawHip4Market[]> {
    const rows = await cacheService.getOrSet(
      buildHypedexerCacheKey('hip4', 'market', { outcome_id: outcomeId }),
      async () => {
        const raw = await this.client.getMarkets<RawHip4Market[]>({ outcome_id: outcomeId });
        return asArray<RawHip4Market>(raw).filter((m) => m.outcome_id === outcomeId).slice(0, 1);
      },
      marketRowTtl
    );
    return asArray<RawHip4Market>(rows);
  }

  /** Shared assembly pipeline used by both enriched endpoints. */
  private async assembleEnrichedMarkets(p: {
    class?: string;
    underlying?: string;
    question_id?: number;
    limit?: number;
    offset?: number;
  }): Promise<Hip4MarketEnriched[]> {
    const [markets, outcomeTokens, questions, midPrices, templates] = await Promise.all([
      this.fetchRawMarkets(p),
      this.fetchRawOutcomeTokens(),
      this.fetchRawQuestions(),
      this.fetchHlMidPrices(),
      this.fetchOutcomeTemplates(),
    ]);
    return enrichMarkets(markets, outcomeTokens, questions, midPrices, templates);
  }

  /**
   * Hyperliquid's template registry, shared for an hour. Markets deployed
   * from a template are named `template:binaryPrice` & co.: the registry holds
   * their title and rules formats. A failed read titles them from their
   * structured fields (or coin) and is retried after a minute.
   */
  private async fetchOutcomeTemplates(): Promise<Hip4TemplateIndex> {
    const raw = await cacheService.getOrSet(
      HYPEDEXER_HIP4_CACHE_KEY.outcomeTemplates,
      () => this.fetchHlOutcomeTemplates(),
      (rows) => (rows.length > 0 ? HYPEDEXER_TTL.hip4OutcomeTemplates : HYPEDEXER_TTL.hip4BaseListRetry)
    );
    return indexOutcomeTemplates(raw);
  }

  private async fetchHlOutcomeTemplates(): Promise<unknown[]> {
    try {
      const resp = await fetch(HL_INFO_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'outcomeTemplates' }),
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) return [];
      const data: unknown = await resp.json();
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  /** Live mid prices of every HIP-4 coin (#N), shared (see SharedHip4Mids). */
  private fetchHlMidPrices(): Promise<Map<string, number>> {
    return this.mids.get();
  }

  /** One HL allMids read, HIP-4 coins only. Throws on any failure (the shared map keeps the last one). */
  private async readHlMidPrices(): Promise<Map<string, number>> {
    const resp = await fetch(HL_INFO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'allMids' }),
      signal: AbortSignal.timeout(MIDS_TIMEOUT_MS),
    });
    if (!resp.ok) throw new Error(`allMids answered ${resp.status}`);
    const data = await resp.json() as Record<string, string>;
    const map = new Map<string, number>();
    for (const [coin, price] of Object.entries(data ?? {})) {
      if (coin.startsWith('#')) {
        const px = parseFloat(price);
        if (Number.isFinite(px)) map.set(coin, px);
      }
    }
    return map;
  }

  /*
   * Upstream metadata lists, one shared Redis entry per param set: every
   * enriched endpoint and settlements read them, and they only change when a
   * market is created or settles.
   */

  private async fetchRawMarkets(p: {
    outcome_id?: number;
    class?: string;
    underlying?: string;
    question_id?: number;
    limit?: number;
    offset?: number;
  } = {}): Promise<RawHip4Market[]> {
    const raw = await cacheService.getOrSet(
      buildHypedexerCacheKey('hip4', 'markets', { ...p }),
      () => this.client.getMarkets<RawHip4Market[]>(p),
      baseListTtl
    );
    return asArray(raw);
  }

  private async fetchRawOutcomeTokens(): Promise<RawHip4OutcomeToken[]> {
    const raw = await cacheService.getOrSet(
      buildHypedexerCacheKey('hip4', 'outcome-tokens'),
      () => this.client.getOutcomeTokens<RawHip4OutcomeToken[]>({}),
      baseListTtl,
      // Fixed name, read by every enriched assembly: kept an hour past a failed refresh.
      { lastCopyKeepS: SHARED_LAST_COPY_KEEP_S }
    );
    return asArray(raw);
  }

  private async fetchRawQuestions(p: { question_id?: number } = {}): Promise<RawHip4Question[]> {
    const raw = await cacheService.getOrSet(
      buildHypedexerCacheKey('hip4', 'questions', { ...p }),
      () => this.client.getQuestions<RawHip4Question[]>(p),
      baseListTtl
    );
    return asArray(raw);
  }
}

function asArray<T>(raw: unknown): T[] {
  return Array.isArray(raw) ? (raw as T[]) : [];
}

/** An empty list is more likely an upstream hiccup than the truth: retry it sooner. */
function baseListTtl(rows: unknown): number {
  return Array.isArray(rows) && rows.length > 0 ? HYPEDEXER_TTL.hip4BaseList : HYPEDEXER_TTL.hip4BaseListRetry;
}

/** A settled market's row is final; an open one changes; an unknown id may be a market about to be listed. */
function marketRowTtl(rows: RawHip4Market[]): number {
  if (rows.length === 0) return HYPEDEXER_TTL.hip4BaseListRetry;
  return rows.some((m) => Boolean(m.settled ?? m.is_settled))
    ? HYPEDEXER_TTL.hip4SettledMarket
    : HYPEDEXER_TTL.hip4OpenMarket;
}
