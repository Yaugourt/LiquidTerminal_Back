import { HypeDexerHip4Client } from '../../clients/hypedexer/rest/hip4/hip4.client';
import { cacheService } from '../../core/cache.service';
import {
  HYPEDEXER_CACHE_KEYS,
  HYPEDEXER_HIP4_CACHE_KEY,
  HYPEDEXER_TTL,
  HYPEDEXER_USER_CACHE_KEY,
} from '../../constants/hypedexer.cache';
import { logDeduplicator } from '../../utils/logDeduplicator';
import {
  enrichMarkets,
  enrichSettlements,
  buildQuestionsWithOutcomes,
  type Hip4MarketEnriched,
  type Hip4QuestionWithOutcomes,
  type Hip4SettlementEnriched,
  type RawHip4Market,
  type RawHip4OutcomeToken,
  type RawHip4Question,
  type RawHip4Settlement,
} from '../../utils/hip4-enrichment.util';

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

  public static getInstance(): IndexerHip4Service {
    if (!IndexerHip4Service.instance) {
      IndexerHip4Service.instance = new IndexerHip4Service();
    }
    return IndexerHip4Service.instance;
  }

  /** Fills — transform raw API shape to frontend-ready shape, then cache if user-scoped.
   * HypeDexer expects `start`/`end` as epoch milliseconds; ISO strings are
   * coerced so the frontend can send either format.
   *
   * Cache key includes coin/outcome_id/limit/offset so filtered requests don't
   * poison the unfiltered key (and vice-versa). Date-bounded requests bypass
   * the cache entirely since they're typically one-off historical queries. */
  public async getFills(p: Parameters<HypeDexerHip4Client['getFills']>[0]): Promise<unknown> {
    const params = p ? { ...p, start: toEpochMs(p.start), end: toEpochMs(p.end) } : p;
    const raw = (params?.user && !params.start && !params.end)
      ? await cacheService.getOrSet(
          HYPEDEXER_USER_CACHE_KEY.hip4Fills(params.user, {
            coin: params.coin,
            outcome_id: params.outcome_id,
            limit: params.limit,
            offset: params.offset,
          }),
          () => this.client.getFills(params),
          HYPEDEXER_TTL.userAddress
        )
      : await this.client.getFills(params);

    if (!Array.isArray(raw)) return raw;
    return raw.map((fill) => this.transformFill(fill as Record<string, unknown>));
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
   * Flat enriched markets. Same pagination contract as questions-with-outcomes:
   * always pull a large raw batch so enrichment can resolve parent templates
   * across the full graph, then slice the resulting card list.
   */
  public async getMarketsEnriched(p: {
    class?: string;
    underlying?: string;
    question_id?: number;
    limit?: number;
    offset?: number;
  } = {}): Promise<Hip4MarketEnriched[]> {
    const hasFilter = p.class != null || p.underlying != null || p.question_id != null;
    const computeFull = async (): Promise<Hip4MarketEnriched[]> =>
      this.assembleEnrichedMarkets({ ...p, limit: 1000, offset: undefined });

    const fullMarkets = hasFilter
      ? await computeFull()
      : await cacheService.getOrSet(
          HYPEDEXER_CACHE_KEYS.hip4MarketsEnriched,
          computeFull,
          HYPEDEXER_TTL.hip4EnrichedList
        );

    if (p.limit == null && p.offset == null) return fullMarkets;
    const start = p.offset ?? 0;
    const end = p.limit != null ? start + p.limit : undefined;
    return fullMarkets.slice(start, end);
  }

  /**
   * Questions with nested outcomes. Singleton markets (no question_id) are
   * surfaced as synthetic 1-outcome questions so the grid handles everything
   * uniformly.
   *
   * Pagination note: the page-size parameters apply to the OUTPUT card list,
   * not the underlying markets fetch — we always pull a large batch of raw
   * markets and questions so the grouping has complete data, then slice the
   * final card array. Limiting the upstream markets fetch would silently drop
   * the majority of cards (a 4-outcome question with one outcome missing
   * still needs to render).
   */
  public async getQuestionsWithOutcomes(p: {
    question_id?: number;
    limit?: number;
    offset?: number;
  } = {}): Promise<Hip4QuestionWithOutcomes[]> {
    const hasFilter = p.question_id != null;
    const RAW_FETCH_LIMIT = 1000;
    const computeFull = async (): Promise<Hip4QuestionWithOutcomes[]> => {
      const [markets, outcomeTokens, questions, midPrices] = await Promise.all([
        this.fetchRawMarkets(p.question_id != null
          ? { question_id: p.question_id, limit: RAW_FETCH_LIMIT }
          : { limit: RAW_FETCH_LIMIT }),
        this.fetchRawOutcomeTokens(),
        this.fetchRawQuestions(p.question_id != null ? { question_id: p.question_id } : {}),
        this.fetchHlMidPrices(),
      ]);
      const enriched = enrichMarkets(markets, outcomeTokens, questions, midPrices);
      return buildQuestionsWithOutcomes(enriched, questions);
    };

    const fullCards = hasFilter
      ? await computeFull()
      : await cacheService.getOrSet(
          HYPEDEXER_CACHE_KEYS.hip4QuestionsWithOutcomes,
          computeFull,
          HYPEDEXER_TTL.hip4EnrichedList
        );

    if (p.limit == null && p.offset == null) return fullCards;
    const start = p.offset ?? 0;
    const end = p.limit != null ? start + p.limit : undefined;
    return fullCards.slice(start, end);
  }

  /** Settlements enriched with winner_name + question_name. No cache (time-sensitive).
   * HypeDexer expects `start`/`end` as epoch milliseconds. */
  public async getSettlements(p: {
    outcome_id?: number;
    start?: string;
    end?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<Hip4SettlementEnriched[]> {
    const params = { ...p, start: toEpochMs(p.start), end: toEpochMs(p.end) };
    const [raw, markets, outcomeTokens, questions, midPrices] = await Promise.all([
      this.client.getSettlements<RawHip4Settlement[]>(params),
      this.fetchRawMarkets(),
      this.fetchRawOutcomeTokens(),
      this.fetchRawQuestions(),
      this.fetchHlMidPrices(),
    ]);
    const enrichedMarkets = enrichMarkets(markets, outcomeTokens, questions, midPrices);
    const all = enrichSettlements(asArray(raw), enrichedMarkets, questions);
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
   * HypeDexer returns `{ status, count, data: [...] }` — we unwrap to the
   * bucket array so the frontend always receives a flat list.
   *
   * Caching strategy:
   *   - Unfiltered calls (no coin, no outcome_id, no date range) are cached per
   *     interval bucket so the most common dashboard requests hit Redis.
   *   - Filtered calls (coin comparison, outcome splits, custom date ranges) are
   *     served fresh — the upstream materialized view is already constant-time.
   */
  public async getAnalytics(p: {
    interval?: string;
    coin?: string;
    outcome_id?: number;
    start?: string;
    end?: string;
    limit?: number;
  } = {}): Promise<unknown[]> {
    const interval = p.interval ?? '1h';
    const hasFilter = p.coin != null || p.outcome_id != null || p.start != null || p.end != null;
    // Analytics expects ISO datetime, not epoch ms. Coerce so callers can send either.
    const params = { ...p, interval, start: toIsoDatetime(p.start), end: toIsoDatetime(p.end) };

    const fetchAndUnwrap = async (): Promise<unknown[]> => {
      const raw = await this.client.getAnalytics<unknown>(params);
      return unwrapAnalyticsEnvelope(raw);
    };

    if (hasFilter) return fetchAndUnwrap();

    return cacheService.getOrSet(
      HYPEDEXER_HIP4_CACHE_KEY.analytics(interval),
      fetchAndUnwrap,
      HYPEDEXER_TTL.hip4Analytics,
    );
  }

  /** Shared assembly pipeline used by both enriched endpoints. */
  private async assembleEnrichedMarkets(p: {
    class?: string;
    underlying?: string;
    question_id?: number;
    limit?: number;
    offset?: number;
  }): Promise<Hip4MarketEnriched[]> {
    const [markets, outcomeTokens, questions, midPrices] = await Promise.all([
      this.fetchRawMarkets(p),
      this.fetchRawOutcomeTokens(),
      this.fetchRawQuestions(),
      this.fetchHlMidPrices(),
    ]);
    return enrichMarkets(markets, outcomeTokens, questions, midPrices);
  }

  /** Fetch live mid prices for all HIP-4 coins (#N) from HL allMids.
   * On failure, falls back to an empty map which makes the enrichment use
   * HypeDexer's (potentially stale) mid_price. The fallback is logged so we
   * can detect prolonged outages where the UI shows snapshot prices. */
  private async fetchHlMidPrices(): Promise<Map<string, number>> {
    try {
      const resp = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'allMids' }),
      });
      if (!resp.ok) {
        logDeduplicator.warn('HIP4 allMids upstream non-OK, falling back to indexer mid_price', { status: resp.status });
        return new Map();
      }
      const data = await resp.json() as Record<string, string>;
      const map = new Map<string, number>();
      for (const [coin, price] of Object.entries(data)) {
        if (coin.startsWith('#')) {
          const px = parseFloat(price);
          if (Number.isFinite(px)) map.set(coin, px);
        }
      }
      return map;
    } catch (e) {
      logDeduplicator.warn('HIP4 allMids fetch failed, falling back to indexer mid_price', {
        error: e instanceof Error ? e.message : String(e),
      });
      return new Map();
    }
  }

  private async fetchRawMarkets(p: {
    outcome_id?: number;
    class?: string;
    underlying?: string;
    question_id?: number;
    limit?: number;
    offset?: number;
  } = {}): Promise<RawHip4Market[]> {
    const raw = await this.client.getMarkets<RawHip4Market[]>(p);
    return asArray(raw);
  }

  private async fetchRawOutcomeTokens(): Promise<RawHip4OutcomeToken[]> {
    const raw = await this.client.getOutcomeTokens<RawHip4OutcomeToken[]>({});
    return asArray(raw);
  }

  private async fetchRawQuestions(p: { question_id?: number } = {}): Promise<RawHip4Question[]> {
    const raw = await this.client.getQuestions<RawHip4Question[]>(p);
    return asArray(raw);
  }
}

function asArray<T>(raw: unknown): T[] {
  return Array.isArray(raw) ? (raw as T[]) : [];
}

function unwrapAnalyticsEnvelope(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object' && 'data' in raw) {
    const data = (raw as { data?: unknown }).data;
    if (Array.isArray(data)) return data;
  }
  return [];
}

/** Coerce a date input (epoch ms numeric string OR ISO datetime) to epoch ms.
 * Returns the original string if it doesn't parse so the caller can decide. */
function toEpochMs(value: string | undefined): string | undefined {
  if (value == null || value === '') return undefined;
  if (/^\d+$/.test(value)) return value;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? String(ms) : value;
}

/** Coerce a date input (epoch ms OR ISO datetime) to ISO 8601. */
function toIsoDatetime(value: string | undefined): string | undefined {
  if (value == null || value === '') return undefined;
  if (/^\d+$/.test(value)) {
    const ms = Number(value);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : value;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : value;
}
