import { BaseApiService, HttpApiError } from '../../core/base.api.service';
import { CircuitBreakerService } from '../../core/circuit.breaker.service';
import { RateLimiterService } from '../../core/hyperLiquid.ratelimiter.service';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { DEFILLAMA_COINS_API_URL, defillamaJsonHeaders } from './defillama-api.config';
import { DefiLlamaNotFoundError, DefiLlamaUpstreamError } from '../../errors/defillama.errors';
import { DefiLlamaPrices } from '../../types/defillama.types';

/**
 * DefiLlama free price client (host `https://coins.llama.fi`).
 * Coin ids use the `{chain}:{address}` or `coingecko:{id}` form,
 * comma-separated for batching (e.g. `coingecko:hyperliquid,ethereum:0x...`).
 */
export class DefiLlamaCoinsClient extends BaseApiService {
  private static instance: DefiLlamaCoinsClient;
  private static readonly REQUEST_WEIGHT = 5;
  private static readonly MAX_WEIGHT_PER_MINUTE = 500;

  private circuitBreaker: CircuitBreakerService;
  private rateLimiter: RateLimiterService;

  private constructor() {
    super(DEFILLAMA_COINS_API_URL, defillamaJsonHeaders);
    this.circuitBreaker = CircuitBreakerService.getInstance('defillama-coins');
    this.rateLimiter = RateLimiterService.getInstance('defillama-coins', {
      maxWeightPerMinute: DefiLlamaCoinsClient.MAX_WEIGHT_PER_MINUTE,
      requestWeight: DefiLlamaCoinsClient.REQUEST_WEIGHT,
    });
  }

  public static getInstance(): DefiLlamaCoinsClient {
    if (!DefiLlamaCoinsClient.instance) {
      DefiLlamaCoinsClient.instance = new DefiLlamaCoinsClient();
    }
    return DefiLlamaCoinsClient.instance;
  }

  public checkRateLimit(ip: string): boolean {
    return this.rateLimiter.checkRateLimit(ip);
  }

  /** `GET /prices/current/{coins}` — current price for one or more coins. */
  public async getCurrentPrices(coins: string): Promise<DefiLlamaPrices> {
    try {
      return await this.circuitBreaker.execute(async () => {
        const path = `/prices/current/${encodeURIComponent(coins)}`;
        logDeduplicator.info('DefiLlamaCoinsClient', { path });
        return this.get<DefiLlamaPrices>(path);
      });
    } catch (error) {
      if (error instanceof HttpApiError && (error.statusCode === 400 || error.statusCode === 404)) {
        throw new DefiLlamaNotFoundError('Coin not tracked by DefiLlama');
      }
      throw new DefiLlamaUpstreamError(error instanceof Error ? error.message : String(error));
    }
  }
}
