import { createHash } from 'crypto';
import { cacheService } from '../../core/cache.service';
import { redisService } from '../../core/redis.service';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { HYPERFOLIO_CACHE_KEYS, HYPERFOLIO_TTL } from '../../constants/hyperfolio.cache';
import {
  HyperfolioBadInputError,
  HyperfolioRateLimitedError,
  HyperfolioThrottledError,
} from '../../errors/hyperfolio.errors';
import {
  HyperfolioCompositionResponse,
  HyperfolioNftsQuery,
  HyperfolioNftsResponse,
  HyperfolioPointsResponse,
  HyperfolioPortfolioHistoryResponse,
  HyperfolioPositionsResponse,
  HyperfolioTransactionsQuery,
  HyperfolioTransactionsResponse,
  HyperfolioYieldQuery,
  HyperfolioYieldResponse,
} from '../../types/hyperfolio.types';
import { HyperfolioClient } from '../../clients/hyperfolio/hyperfolio.client';
import { sanitizeYieldResponse } from '../../utils/hyperfolio-yield.util';

/** After an upstream throttle, short-circuit callers for this long. */
const RATE_LIMIT_COOLDOWN_MS = 10_000;

/**
 * Cached in place of a payload when Hyperfolio rejected the input (bad address,
 * unresolvable `.hype`/`.hl` name), for the endpoint's own TTL: repeating the
 * same bogus lookup is answered from Redis instead of costing an upstream call.
 */
const BAD_INPUT_MARKER = { __hyperfolioBadInput: true } as const;
type BadInputMarker = typeof BAD_INPUT_MARKER;

function isBadInputMarker(value: unknown): value is BadInputMarker {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { __hyperfolioBadInput?: unknown }).__hyperfolioBadInput === true
  );
}

/** Stable, short signature for a query object (cache key suffix). */
function signature(query: object): string {
  const entries = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .sort(([a], [b]) => a.localeCompare(b));
  return createHash('sha1').update(JSON.stringify(entries)).digest('hex').slice(0, 16);
}

/**
 * Thin, Redis-cached service over HyperfolioClient. Every read is served from
 * cache for its TTL so a busy wallet page costs one upstream call per panel.
 */
export class HyperfolioService {
  private static instance: HyperfolioService;
  private readonly client = HyperfolioClient.getInstance();
  private rateLimitedUntil = 0;

  public static getInstance(): HyperfolioService {
    if (!HyperfolioService.instance) {
      HyperfolioService.instance = new HyperfolioService();
    }
    return HyperfolioService.instance;
  }

  /**
   * Redis-cached read. Only a cache miss reaches Hyperfolio, and a miss is
   * gated three ways: the shared cooldown opened by an upstream throttle
   * (cached answers are still served meanwhile; only an upstream throttle
   * arms it), the caller's per-IP budget, and (in the client) the
   * process-wide upstream budget.
   *
   * cacheService.getOrSet calls `fetchFn` a second time when the first call
   * throws (its catch-all "fall back to direct fetch"). Here that would double
   * every failed upstream call — a 45 s transactions timeout would hold the
   * request 90 s — so the first failure is memoised and replayed instead.
   */
  private async cached<T>(key: string, ttl: number, ip: string, fetchFn: () => Promise<T>): Promise<T> {
    let failure: unknown = null;
    const result = await cacheService.getOrSet<T | BadInputMarker>(key, async () => {
      if (failure) throw failure;
      // Outside the try: a miss refused by the cooldown must not re-arm it,
      // or steady traffic would keep it open forever.
      if (Date.now() < this.rateLimitedUntil) {
        failure = new HyperfolioRateLimitedError();
        throw failure;
      }
      try {
        if (!this.client.checkRateLimit(ip)) {
          throw new HyperfolioThrottledError();
        }
        return await fetchFn();
      } catch (error) {
        if (error instanceof HyperfolioBadInputError) {
          return BAD_INPUT_MARKER;
        }
        if (error instanceof HyperfolioRateLimitedError) {
          this.rateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
          logDeduplicator.warn('Hyperfolio rate limited, cooling down', { key });
        }
        failure = error;
        throw error;
      }
    }, ttl);
    if (isBadInputMarker(result)) {
      throw new HyperfolioBadInputError();
    }
    return result;
  }

  public getComposition(address: string, ip: string): Promise<HyperfolioCompositionResponse> {
    return this.cached(
      HYPERFOLIO_CACHE_KEYS.composition(address),
      HYPERFOLIO_TTL.composition,
      ip,
      () => this.client.getComposition(address)
    );
  }

  public getPositions(address: string, ip: string): Promise<HyperfolioPositionsResponse> {
    return this.cached(
      HYPERFOLIO_CACHE_KEYS.positions(address),
      HYPERFOLIO_TTL.positions,
      ip,
      () => this.client.getPositions(address)
    );
  }

  /** Cached positions if present, without touching upstream (stream replay). */
  public async peekPositions(address: string): Promise<HyperfolioPositionsResponse | null> {
    try {
      const raw = await redisService.get(HYPERFOLIO_CACHE_KEYS.positions(address));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as unknown;
      // The key may hold a bad-input marker instead of a payload.
      const protocols = (parsed as { data?: { protocols?: unknown } } | null)?.data?.protocols;
      return Array.isArray(protocols) ? (parsed as HyperfolioPositionsResponse) : null;
    } catch {
      return null;
    }
  }

  /** Warm the positions cache from a fully consumed stream. */
  public async storePositions(address: string, payload: HyperfolioPositionsResponse): Promise<void> {
    try {
      await redisService.set(
        HYPERFOLIO_CACHE_KEYS.positions(address),
        JSON.stringify(payload),
        HYPERFOLIO_TTL.positions
      );
    } catch (error) {
      logDeduplicator.warn('Hyperfolio: failed to warm positions cache', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  public isRateLimited(): boolean {
    return Date.now() < this.rateLimitedUntil;
  }

  public markRateLimited(): void {
    this.rateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
  }

  public getPortfolioHistory(
    address: string,
    days: number,
    ip: string
  ): Promise<HyperfolioPortfolioHistoryResponse> {
    return this.cached(
      HYPERFOLIO_CACHE_KEYS.history(address, days),
      HYPERFOLIO_TTL.history,
      ip,
      () => this.client.getPortfolioHistory(address, days)
    );
  }

  public getTransactions(
    address: string,
    query: HyperfolioTransactionsQuery,
    ip: string
  ): Promise<HyperfolioTransactionsResponse> {
    return this.cached(
      HYPERFOLIO_CACHE_KEYS.transactions(address, signature(query)),
      HYPERFOLIO_TTL.transactions,
      ip,
      () => this.client.getTransactions(address, query)
    );
  }

  public getNfts(address: string, query: HyperfolioNftsQuery, ip: string): Promise<HyperfolioNftsResponse> {
    return this.cached(
      HYPERFOLIO_CACHE_KEYS.nfts(address, signature(query)),
      HYPERFOLIO_TTL.nfts,
      ip,
      () => this.client.getNfts(address, query)
    );
  }

  public getPoints(address: string, ip: string): Promise<HyperfolioPointsResponse> {
    return this.cached(
      HYPERFOLIO_CACHE_KEYS.points(address),
      HYPERFOLIO_TTL.points,
      ip,
      () => this.client.getPoints(address)
    );
  }

  public getYield(query: HyperfolioYieldQuery, ip: string): Promise<HyperfolioYieldResponse> {
    return this.cached(
      HYPERFOLIO_CACHE_KEYS.yield(signature(query)),
      HYPERFOLIO_TTL.yield,
      ip,
      async () => sanitizeYieldResponse(await this.client.getYield(query))
    );
  }
}
