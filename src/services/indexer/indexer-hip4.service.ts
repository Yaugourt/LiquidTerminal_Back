import { HypeDexerHip4Client } from '../../clients/hypedexer/rest/hip4/hip4.client';
import { cacheService } from '../../core/cache.service';
import { HYPEDEXER_CACHE_KEYS, HYPEDEXER_TTL, HYPEDEXER_USER_CACHE_KEY } from '../../constants/hypedexer.cache';
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

  /** Fills — transform raw API shape to frontend-ready shape, then cache if user-scoped. */
  public async getFills(p: Parameters<HypeDexerHip4Client['getFills']>[0]): Promise<unknown> {
    const raw = (p?.user && !p.start && !p.end)
      ? await cacheService.getOrSet(
          HYPEDEXER_USER_CACHE_KEY.hip4Fills(p.user),
          () => this.client.getFills(p),
          HYPEDEXER_TTL.userAddress
        )
      : await this.client.getFills(p);

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
   * Flat enriched markets. Backed by a single Redis entry when no filter is applied;
   * filtered calls re-join from fresh upstream data (rare path).
   */
  public async getMarketsEnriched(p: {
    class?: string;
    underlying?: string;
    question_id?: number;
    limit?: number;
    offset?: number;
  } = {}): Promise<Hip4MarketEnriched[]> {
    const hasFilter = p.class != null || p.underlying != null || p.question_id != null;
    const compute = async (): Promise<Hip4MarketEnriched[]> => this.assembleEnrichedMarkets(p);

    if (hasFilter) return compute();
    return cacheService.getOrSet(
      HYPEDEXER_CACHE_KEYS.hip4MarketsEnriched,
      compute,
      HYPEDEXER_TTL.staticList
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
    const hasFilter = p.question_id != null;
    const compute = async (): Promise<Hip4QuestionWithOutcomes[]> => {
      const [markets, outcomeTokens, questions, midPrices] = await Promise.all([
        this.fetchRawMarkets(p.question_id != null ? { question_id: p.question_id, limit: p.limit, offset: p.offset } : { limit: p.limit, offset: p.offset }),
        this.fetchRawOutcomeTokens(),
        this.fetchRawQuestions(p.question_id != null ? { question_id: p.question_id } : {}),
        this.fetchHlMidPrices(),
      ]);
      const enriched = enrichMarkets(markets, outcomeTokens, questions, midPrices);
      return buildQuestionsWithOutcomes(enriched, questions);
    };

    if (hasFilter) return compute();
    return cacheService.getOrSet(
      HYPEDEXER_CACHE_KEYS.hip4QuestionsWithOutcomes,
      compute,
      HYPEDEXER_TTL.staticList
    );
  }

  /** Settlements enriched with winner_name + question_name. No cache (time-sensitive). */
  public async getSettlements(p: {
    outcome_id?: number;
    start?: string;
    end?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<Hip4SettlementEnriched[]> {
    const [raw, markets, outcomeTokens, questions, midPrices] = await Promise.all([
      this.client.getSettlements<RawHip4Settlement[]>(p),
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

  /** Fetch live mid prices for all HIP-4 coins (#N) from HL allMids. */
  private async fetchHlMidPrices(): Promise<Map<string, number>> {
    try {
      const resp = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'allMids' }),
      });
      const data = await resp.json() as Record<string, string>;
      const map = new Map<string, number>();
      for (const [coin, price] of Object.entries(data)) {
        if (coin.startsWith('#')) {
          const px = parseFloat(price);
          if (Number.isFinite(px)) map.set(coin, px);
        }
      }
      return map;
    } catch {
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
