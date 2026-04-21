import { HypeDexerHip4Client } from '../../clients/hypedexer/rest/hip4/hip4.client';
import { cacheService } from '../../core/cache.service';
import { HYPEDEXER_CACHE_KEYS, HYPEDEXER_TTL, HYPEDEXER_USER_CACHE_KEY } from '../../constants/hypedexer.cache';

/**
 * Passthrough to HypeDexer /hip4/* with Redis cache on global (param-free) endpoints.
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

  /** Fills — user-specific if `user` provided, no default cache. */
  public getFills(p: Parameters<HypeDexerHip4Client['getFills']>[0]): Promise<unknown> {
    if (p?.user && !p.start && !p.end) {
      return cacheService.getOrSet(
        HYPEDEXER_USER_CACHE_KEY.hip4Fills(p.user),
        () => this.client.getFills(p),
        HYPEDEXER_TTL.userAddress
      );
    }
    return this.client.getFills(p);
  }

  /** Fees — user-specific if `user` provided (no date range), otherwise on-demand. */
  public getFees(p: Parameters<HypeDexerHip4Client['getFees']>[0]): Promise<unknown> {
    if (p?.user && !p.start && !p.end) {
      return cacheService.getOrSet(
        HYPEDEXER_USER_CACHE_KEY.hip4Fees(p.user),
        () => this.client.getFees(p),
        HYPEDEXER_TTL.userAddress
      );
    }
    return this.client.getFees(p);
  }

  /** Markets — global list, cached (quasi-static, new outcomes are rare). */
  public getMarkets(p: Parameters<HypeDexerHip4Client['getMarkets']>[0]): Promise<unknown> {
    const hasFilter = p?.outcome_id != null || p?.class || p?.underlying || p?.question_id;
    if (hasFilter) {
      return this.client.getMarkets(p);
    }
    return cacheService.getOrSet(
      HYPEDEXER_CACHE_KEYS.hip4Markets,
      () => this.client.getMarkets(p),
      HYPEDEXER_TTL.staticList
    );
  }

  /** Outcomes — alias of markets. */
  public getOutcomes(p: Parameters<HypeDexerHip4Client['getOutcomes']>[0]): Promise<unknown> {
    return this.client.getOutcomes(p);
  }

  /** Questions — global list, cached. */
  public getQuestions(p: Parameters<HypeDexerHip4Client['getQuestions']>[0]): Promise<unknown> {
    const hasFilter = p?.question_id != null;
    if (hasFilter) {
      return this.client.getQuestions(p);
    }
    return cacheService.getOrSet(
      HYPEDEXER_CACHE_KEYS.hip4Questions,
      () => this.client.getQuestions(p),
      HYPEDEXER_TTL.staticList
    );
  }

  /** Settlements — time-sensitive, no cache. */
  public getSettlements(p: Parameters<HypeDexerHip4Client['getSettlements']>[0]): Promise<unknown> {
    return this.client.getSettlements(p);
  }

  /** Outcome token metadata — global list, cached. */
  public getOutcomeTokens(p: Parameters<HypeDexerHip4Client['getOutcomeTokens']>[0]): Promise<unknown> {
    const hasFilter = p?.outcome_id != null || p?.coin;
    if (hasFilter) {
      return this.client.getOutcomeTokens(p);
    }
    return cacheService.getOrSet(
      HYPEDEXER_CACHE_KEYS.hip4OutcomeTokens,
      () => this.client.getOutcomeTokens(p),
      HYPEDEXER_TTL.staticList
    );
  }

  /** Fee scale governance events — global list, cached. */
  public getFeeScales(p: Parameters<HypeDexerHip4Client['getFeeScales']>[0]): Promise<unknown> {
    const hasFilter = p?.start || p?.end;
    if (hasFilter) {
      return this.client.getFeeScales(p);
    }
    return cacheService.getOrSet(
      HYPEDEXER_CACHE_KEYS.hip4FeeScales,
      () => this.client.getFeeScales(p),
      HYPEDEXER_TTL.staticList
    );
  }

  /** User actions — user-specific if `user` provided (no date range), otherwise on-demand. */
  public getUserActions(p: Parameters<HypeDexerHip4Client['getUserActions']>[0]): Promise<unknown> {
    if (p?.user && !p.start && !p.end) {
      return cacheService.getOrSet(
        HYPEDEXER_USER_CACHE_KEY.hip4UserActions(p.user),
        () => this.client.getUserActions(p),
        HYPEDEXER_TTL.userAddress
      );
    }
    return this.client.getUserActions(p);
  }
}
