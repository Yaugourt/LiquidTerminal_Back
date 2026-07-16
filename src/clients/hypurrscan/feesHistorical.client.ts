import { BaseApiService } from '../../core/base.api.service';
import { FeeData } from '../../types/fees.types';
import { CircuitBreakerService } from '../../core/circuit.breaker.service';
import { RateLimiterService } from '../../core/hyperLiquid.ratelimiter.service';
import { redisService } from '../../core/redis.service';
import { logDeduplicator } from '../../utils/logDeduplicator';

/**
 * HypurrscanFeesHistoricalClient — polls `/fees` (daily, ~553 days cumulative).
 *
 * Distinct from `HypurrscanFeesClient` which polls `/feesRecent` (10 min, ~8 days).
 * Both endpoints share the same payload shape `[{time, total_fees, total_spot_fees}]`
 * (cumulative, micro-USD), but the historical endpoint is the only source with
 * enough depth to feed the long-window revenue chart.
 *
 * Cumulative series are idempotent on re-poll, so 6 h cadence is sufficient.
 */
export class HypurrscanFeesHistoricalClient extends BaseApiService {
  private static instance: HypurrscanFeesHistoricalClient;
  private static readonly BASE_URL = process.env.HYPURRSCAN_API_URL || 'https://api.hypurrscan.io';
  private static readonly PATH = '/fees';
  private static readonly REQUEST_WEIGHT = 1;
  private static readonly MAX_WEIGHT_PER_MINUTE = 1000;
  private static readonly CACHE_KEY = 'fees:historical:raw';
  private static readonly UPDATE_CHANNEL = 'fees:historical:updated';
  private static readonly UPDATE_INTERVAL = 6 * 60 * 60 * 1000;

  private circuitBreaker: CircuitBreakerService;
  private rateLimiter: RateLimiterService;
  private lastUpdate: number = 0;
  private pollingInterval: NodeJS.Timeout | null = null;

  private constructor() {
    super(HypurrscanFeesHistoricalClient.BASE_URL + HypurrscanFeesHistoricalClient.PATH);
    this.circuitBreaker = CircuitBreakerService.getInstance('feesHistorical');
    this.rateLimiter = RateLimiterService.getInstance('feesHistorical', {
      maxWeightPerMinute: HypurrscanFeesHistoricalClient.MAX_WEIGHT_PER_MINUTE,
      requestWeight: HypurrscanFeesHistoricalClient.REQUEST_WEIGHT
    });
  }

  public static getInstance(): HypurrscanFeesHistoricalClient {
    if (!HypurrscanFeesHistoricalClient.instance) {
      HypurrscanFeesHistoricalClient.instance = new HypurrscanFeesHistoricalClient();
    }
    return HypurrscanFeesHistoricalClient.instance;
  }

  public static get updateChannel(): string {
    return HypurrscanFeesHistoricalClient.UPDATE_CHANNEL;
  }

  public static get cacheKey(): string {
    return HypurrscanFeesHistoricalClient.CACHE_KEY;
  }

  public startPolling(): void {
    if (this.pollingInterval) {
      logDeduplicator.warn('Fees historical polling already started');
      return;
    }

    logDeduplicator.info('Starting fees historical polling');
    this.updateData().catch(error => {
      logDeduplicator.error('Error in initial fees historical update:', { error: error instanceof Error ? error.message : String(error) });
    });

    this.pollingInterval = setInterval(() => {
      this.updateData().catch(error => {
        logDeduplicator.error('Error in fees historical polling:', { error: error instanceof Error ? error.message : String(error) });
      });
    }, HypurrscanFeesHistoricalClient.UPDATE_INTERVAL);
  }

  public stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
      logDeduplicator.info('Fees historical polling stopped');
    }
  }

  private async updateData(): Promise<void> {
    try {
      const data = await this.circuitBreaker.execute(() => this.get<FeeData[]>(''));
      await redisService.set(HypurrscanFeesHistoricalClient.CACHE_KEY, JSON.stringify(data));
      const now = Date.now();
      await redisService.publish(HypurrscanFeesHistoricalClient.UPDATE_CHANNEL, JSON.stringify({
        type: 'DATA_UPDATED',
        timestamp: now
      }));
      this.lastUpdate = now;
      logDeduplicator.info('Fees historical data updated', {
        entriesCount: data.length,
        firstTime: data[0]?.time,
        lastTime: data[data.length - 1]?.time
      });
    } catch (error) {
      logDeduplicator.error('Failed to update fees historical data:', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  public async getHistoricalData(): Promise<FeeData[]> {
    const cached = await redisService.get(HypurrscanFeesHistoricalClient.CACHE_KEY);
    if (cached) return JSON.parse(cached);

    logDeduplicator.warn('No historical fees data in cache, forcing update');
    await this.updateData();
    const fresh = await redisService.get(HypurrscanFeesHistoricalClient.CACHE_KEY);
    if (!fresh) throw new Error('Failed to get historical fees data after update');
    return JSON.parse(fresh);
  }

  public checkRateLimit(ip: string): boolean {
    return this.rateLimiter.checkRateLimit(ip);
  }

  public static getRequestWeight(): number {
    return HypurrscanFeesHistoricalClient.REQUEST_WEIGHT;
  }
}
