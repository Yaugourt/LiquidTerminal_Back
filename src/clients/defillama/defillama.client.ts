import { BaseApiService, HttpApiError } from '../../core/base.api.service';
import { CircuitBreakerService } from '../../core/circuit.breaker.service';
import { RateLimiterService } from '../../core/hyperLiquid.ratelimiter.service';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { DEFILLAMA_API_URL, defillamaJsonHeaders } from './defillama-api.config';
import { DefiLlamaNotFoundError, DefiLlamaUpstreamError } from '../../errors/defillama.errors';
import {
  DefiLlamaChain,
  DefiLlamaProtocolDetail,
  DefiLlamaProtocolListItem,
  DefiLlamaSummary,
} from '../../types/defillama.types';

/** Fees/revenue view selector for `GET /summary/fees/{slug}`. */
export type DefiLlamaFeesDataType = 'dailyFees' | 'dailyRevenue';

/**
 * DefiLlama free REST client (host `https://api.llama.fi`).
 * Covers protocols, TVL, chains, DEX volume and fees/revenue.
 * Token prices live on a different host — see `DefiLlamaCoinsClient`.
 */
export class DefiLlamaClient extends BaseApiService {
  private static instance: DefiLlamaClient;
  private static readonly REQUEST_WEIGHT = 5;
  private static readonly MAX_WEIGHT_PER_MINUTE = 500;

  private circuitBreaker: CircuitBreakerService;
  private rateLimiter: RateLimiterService;

  private constructor() {
    super(DEFILLAMA_API_URL, defillamaJsonHeaders);
    this.circuitBreaker = CircuitBreakerService.getInstance('defillama');
    this.rateLimiter = RateLimiterService.getInstance('defillama', {
      maxWeightPerMinute: DefiLlamaClient.MAX_WEIGHT_PER_MINUTE,
      requestWeight: DefiLlamaClient.REQUEST_WEIGHT,
    });
  }

  public static getInstance(): DefiLlamaClient {
    if (!DefiLlamaClient.instance) {
      DefiLlamaClient.instance = new DefiLlamaClient();
    }
    return DefiLlamaClient.instance;
  }

  public checkRateLimit(ip: string): boolean {
    return this.rateLimiter.checkRateLimit(ip);
  }

  /**
   * GET through the circuit breaker, mapping upstream failures to domain errors.
   * DefiLlama answers 400 for an unknown protocol slug or a missing module,
   * which we surface as a 404 rather than a generic 502.
   */
  private async getPath<T>(path: string): Promise<T> {
    try {
      return await this.circuitBreaker.execute(async () => {
        logDeduplicator.info('DefiLlamaClient', { path });
        return this.get<T>(path);
      });
    } catch (error) {
      if (error instanceof HttpApiError && (error.statusCode === 400 || error.statusCode === 404)) {
        throw new DefiLlamaNotFoundError();
      }
      throw new DefiLlamaUpstreamError(error instanceof Error ? error.message : String(error));
    }
  }

  /** `GET /protocols` — every tracked protocol with current TVL. */
  public getProtocols(): Promise<DefiLlamaProtocolListItem[]> {
    return this.getPath<DefiLlamaProtocolListItem[]>('/protocols');
  }

  /** `GET /protocol/{slug}` — details plus historical TVL and per-chain breakdown. */
  public getProtocol(slug: string): Promise<DefiLlamaProtocolDetail> {
    return this.getPath<DefiLlamaProtocolDetail>(`/protocol/${encodeURIComponent(slug)}`);
  }

  /** `GET /tvl/{slug}` — current TVL as a bare number. */
  public getProtocolTvl(slug: string): Promise<number> {
    return this.getPath<number>(`/tvl/${encodeURIComponent(slug)}`);
  }

  /** `GET /v2/chains` — current TVL for every chain. */
  public getChains(): Promise<DefiLlamaChain[]> {
    return this.getPath<DefiLlamaChain[]>('/v2/chains');
  }

  /** `GET /summary/dexs/{slug}` — DEX volume summary. Charts excluded by default. */
  public getDexSummary(slug: string, includeChart = false): Promise<DefiLlamaSummary> {
    const exclude = includeChart ? 'false' : 'true';
    return this.getPath<DefiLlamaSummary>(
      `/summary/dexs/${encodeURIComponent(slug)}?excludeTotalDataChart=${exclude}&excludeTotalDataChartBreakdown=${exclude}`
    );
  }

  /** `GET /summary/fees/{slug}` — fees (default) or revenue view. */
  public getFeesSummary(
    slug: string,
    dataType: DefiLlamaFeesDataType = 'dailyFees'
  ): Promise<DefiLlamaSummary> {
    return this.getPath<DefiLlamaSummary>(
      `/summary/fees/${encodeURIComponent(slug)}?dataType=${dataType}`
    );
  }
}
