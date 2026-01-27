import { BaseApiService } from '../../core/base.api.service';
import { FeeData } from '../../types/fees.types';
import { CircuitBreakerService } from '../../core/circuit.breaker.service';
import { RateLimiterService } from '../../core/hyperLiquid.ratelimiter.service';
import { redisService } from '../../core/redis.service';
import { logDeduplicator } from '../../utils/logDeduplicator';

export class HypurrscanFeesClient extends BaseApiService {
  private static instance: HypurrscanFeesClient;
  private static readonly API_URL = 'https://api.hypurrscan.io/feesRecent';
  private static readonly REQUEST_WEIGHT = 10;
  private static readonly MAX_WEIGHT_PER_MINUTE = 1000;
  private static readonly CACHE_KEY = 'fees:raw_data';
  private static readonly UPDATE_CHANNEL = 'fees:data:updated';
  private static readonly UPDATE_INTERVAL = 30000; 
  private static readonly MICRO_USD_DIVISOR = 1_000_000;

  private circuitBreaker: CircuitBreakerService;
  private rateLimiter: RateLimiterService;
  private lastUpdate: number = 0;
  private pollingInterval: NodeJS.Timeout | null = null;

  private constructor() {
    super(HypurrscanFeesClient.API_URL);
    this.circuitBreaker = CircuitBreakerService.getInstance('fees');
    this.rateLimiter = RateLimiterService.getInstance('fees', {
      maxWeightPerMinute: HypurrscanFeesClient.MAX_WEIGHT_PER_MINUTE,
      requestWeight: HypurrscanFeesClient.REQUEST_WEIGHT
    });
  }

  public static getInstance(): HypurrscanFeesClient {
    if (!HypurrscanFeesClient.instance) {
      HypurrscanFeesClient.instance = new HypurrscanFeesClient();
    }
    return HypurrscanFeesClient.instance;
  }

  public static get updateChannel(): string {
    return HypurrscanFeesClient.UPDATE_CHANNEL;
  }

  public startPolling(): void {
    if (this.pollingInterval) {
      logDeduplicator.warn('Fees polling already started');
      return;
    }

    logDeduplicator.info('Starting fees polling');
    this.updateFeesData().catch(error => {
      logDeduplicator.error('Error in initial fees update:', { error });
    });

    this.pollingInterval = setInterval(() => {
      this.updateFeesData().catch(error => {
        logDeduplicator.error('Error in fees polling:', { error });
      });
    }, HypurrscanFeesClient.UPDATE_INTERVAL);
  }

  public stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
      logDeduplicator.info('Fees polling stopped');
    }
  }

  private async getFeesDataRaw(): Promise<FeeData[]> {
    return this.circuitBreaker.execute(() => 
      this.get<FeeData[]>('')
    );
  }

  private async updateFeesData(): Promise<void> {
    try {
      const feesData = await this.getFeesDataRaw();
      
      await redisService.set(
        HypurrscanFeesClient.CACHE_KEY,
        JSON.stringify(feesData)
      );

      const now = Date.now();
      await redisService.publish(HypurrscanFeesClient.UPDATE_CHANNEL, JSON.stringify({
        type: 'DATA_UPDATED',
        timestamp: now
      }));

      this.lastUpdate = now;
      
      logDeduplicator.info('Fees data updated', { 
        entriesCount: feesData.length,
        lastTimestamp: feesData[feesData.length - 1]?.time,
        lastUpdate: this.lastUpdate
      });
    } catch (error) {
      logDeduplicator.error('Failed to update fees data:', { error });
      throw error;
    }
  }

  public async getFeesData(): Promise<FeeData[]> {
    try {
      const cachedData = await redisService.get(HypurrscanFeesClient.CACHE_KEY);
      if (cachedData) {
        logDeduplicator.info('Retrieved fees data from cache', {
          lastUpdate: this.lastUpdate
        });
        return JSON.parse(cachedData);
      }

      logDeduplicator.warn('No fees data in cache, forcing update');
      await this.updateFeesData();
      const freshData = await redisService.get(HypurrscanFeesClient.CACHE_KEY);
      if (!freshData) {
        throw new Error('Failed to get fees data after update');
      }
      return JSON.parse(freshData);
    } catch (error) {
      logDeduplicator.error('Error fetching fees data:', { error });
      throw error;
    }
  }

  public static convertToUSD(microUsdAmount: number): number {
    return microUsdAmount / HypurrscanFeesClient.MICRO_USD_DIVISOR;
  }

  public checkRateLimit(ip: string): boolean {
    return this.rateLimiter.checkRateLimit(ip);
  }

  public static getRequestWeight(): number {
    return HypurrscanFeesClient.REQUEST_WEIGHT;
  }
} 