import { BaseApiService } from '../../core/base.api.service';
import { CircuitBreakerService } from '../../core/circuit.breaker.service';
import { RateLimiterService } from '../../core/hyperLiquid.ratelimiter.service';
import { ValidationRawData } from '../../types/staking.types';
import { redisService } from '../../core/redis.service';
import { withDistributedLock } from '../../utils/distributedLock';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { startGuardedInterval } from '../../utils/guardedInterval';

export class HypurrscanValidationClient extends BaseApiService {
  private static instance: HypurrscanValidationClient;
  private static readonly API_URL = process.env.HYPURRSCAN_API_URL || 'https://api.hypurrscan.io';
  private static readonly REQUEST_WEIGHT = 1;
  private static readonly MAX_WEIGHT_PER_MINUTE = 1000;
  private static readonly UPDATE_INTERVAL = 50000; // 20 secondes
  private static readonly CACHE_KEY = 'hypurrscan:validations';
  private static readonly UPDATE_CHANNEL = 'hypurrscan:validations:updated';

  private circuitBreaker: CircuitBreakerService;
  private rateLimiter: RateLimiterService;
  private lastUpdate: number = 0;
  private pollingInterval: NodeJS.Timeout | null = null;

  private constructor() {
    super(HypurrscanValidationClient.API_URL);
    this.circuitBreaker = CircuitBreakerService.getInstance('hypurrscan-validation');
    this.rateLimiter = RateLimiterService.getInstance('hypurrscan-validation', {
      maxWeightPerMinute: HypurrscanValidationClient.MAX_WEIGHT_PER_MINUTE,
      requestWeight: HypurrscanValidationClient.REQUEST_WEIGHT
    });
  }

  public static getInstance(): HypurrscanValidationClient {
    if (!HypurrscanValidationClient.instance) {
      HypurrscanValidationClient.instance = new HypurrscanValidationClient();
    }
    return HypurrscanValidationClient.instance;
  }

  public startPolling(): void {
    if (this.pollingInterval) {
      logDeduplicator.warn('Hypurrscan validation polling already started');
      return;
    }

    logDeduplicator.info('Starting Hypurrscan validation polling');
    this.pollingInterval = startGuardedInterval(
      'Hypurrscan validation polling',
      () => this.updateValidations(),
      HypurrscanValidationClient.UPDATE_INTERVAL
    );
  }

  public stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
      logDeduplicator.info('Hypurrscan validation polling stopped');
    }
  }

  private async updateValidations(): Promise<void> {
    const executed = await withDistributedLock('poll:validation', 75, async () => {
    try {
      const data = await this.circuitBreaker.execute(() => 
        this.get<ValidationRawData[]>('/validating')
      );
      
      await redisService.set(HypurrscanValidationClient.CACHE_KEY, JSON.stringify(data));
      const now = Date.now();
      await redisService.publish(HypurrscanValidationClient.UPDATE_CHANNEL, JSON.stringify({
        type: 'DATA_UPDATED',
        timestamp: now
      }));
      this.lastUpdate = now;
      logDeduplicator.info('Validations data updated successfully', {
        validationsCount: data.length,
        lastUpdate: this.lastUpdate
      });
    } catch (error) {
      logDeduplicator.error('Failed to update validations data:', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    });

    if (!executed) {
      logDeduplicator.info('Validation refresh skipped - another instance holds the lock');
    }
  }

  public async getValidations(): Promise<ValidationRawData[]> {
    try {
      const cached = await redisService.get(HypurrscanValidationClient.CACHE_KEY);
      if (cached) {
        logDeduplicator.info('Retrieved validations from cache', {
          lastUpdate: this.lastUpdate
        });
        return JSON.parse(cached);
      }

      logDeduplicator.warn('No validations in cache, forcing update');
      await this.updateValidations();
      const freshData = await redisService.get(HypurrscanValidationClient.CACHE_KEY);
      if (!freshData) {
        throw new Error('Failed to get validations data after update');
      }
      return JSON.parse(freshData);
    } catch (error) {
      logDeduplicator.error('Error fetching validations:', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  public checkRateLimit(ip: string): boolean {
    return this.rateLimiter.checkRateLimit(ip);
  }

  public static getRequestWeight(): number {
    return HypurrscanValidationClient.REQUEST_WEIGHT;
  }
} 