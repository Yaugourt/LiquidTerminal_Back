import { BaseApiService } from '../../core/base.api.service';
import { FeeData } from '../../types/fees.types';
import { CircuitBreakerService } from '../../core/circuit.breaker.service';
import { RateLimiterService } from '../../core/hyperLiquid.ratelimiter.service';

/**
 * Hypurrscan cumulative-fee history client (`GET /fees`).
 *
 * Distinct from `HypurrscanFeesClient` (which polls the dense `/feesRecent`
 * snapshot for the live fees widget): `/fees` returns the full ~daily-cadence
 * history of cumulative `total_fees` / `total_spot_fees` (micro-USD) since
 * tracking began, which is what the revenue time-series is built from.
 */
export class HypurrscanFeesHistoryClient extends BaseApiService {
  private static instance: HypurrscanFeesHistoryClient;
  private static readonly API_URL = process.env.HYPURRSCAN_API_URL || 'https://api.hypurrscan.io';
  private static readonly REQUEST_WEIGHT = 1;
  private static readonly MAX_WEIGHT_PER_MINUTE = 1000;

  private circuitBreaker: CircuitBreakerService;
  private rateLimiter: RateLimiterService;

  private constructor() {
    super(HypurrscanFeesHistoryClient.API_URL);
    this.circuitBreaker = CircuitBreakerService.getInstance('fees');
    this.rateLimiter = RateLimiterService.getInstance('fees', {
      maxWeightPerMinute: HypurrscanFeesHistoryClient.MAX_WEIGHT_PER_MINUTE,
      requestWeight: HypurrscanFeesHistoryClient.REQUEST_WEIGHT,
    });
  }

  public static getInstance(): HypurrscanFeesHistoryClient {
    if (!HypurrscanFeesHistoryClient.instance) {
      HypurrscanFeesHistoryClient.instance = new HypurrscanFeesHistoryClient();
    }
    return HypurrscanFeesHistoryClient.instance;
  }

  /** `GET /fees` — full cumulative fee history (ascending by time). */
  public async getFeesHistory(): Promise<FeeData[]> {
    return this.circuitBreaker.execute(() => this.get<FeeData[]>('/fees'));
  }

  public checkRateLimit(ip: string): boolean {
    return this.rateLimiter.checkRateLimit(ip);
  }
}
