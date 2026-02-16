import { BaseApiService } from '../../../core/base.api.service';
import { ValidatorSummary } from '../../../types/staking.types';
import { CircuitBreakerService } from '../../../core/circuit.breaker.service';
import { RateLimiterService } from '../../../core/hyperLiquid.ratelimiter.service';
import { redisService } from '../../../core/redis.service';
import { logDeduplicator } from '../../../utils/logDeduplicator';

export class ValidatorClient extends BaseApiService {
  private static instance: ValidatorClient;
  private static readonly API_URL = (process.env.HYPERLIQUID_API_URL || 'https://api.hyperliquid.xyz') + '/info';
  private static readonly REQUEST_WEIGHT = 20;
  private static readonly MAX_WEIGHT_PER_MINUTE = 1200;

  private readonly CACHE_KEY = 'staking:validators:raw_data';
  private readonly UPDATE_CHANNEL = 'staking:validators:updated';
  private readonly UPDATE_INTERVAL = 10000; // 10 secondes
  private lastUpdate: number = 0;
  private pollingInterval: NodeJS.Timeout | null = null;

  private circuitBreaker: CircuitBreakerService;
  private rateLimiter: RateLimiterService;

  private constructor() {
    super(ValidatorClient.API_URL);
    this.circuitBreaker = CircuitBreakerService.getInstance('staking');
    this.rateLimiter = RateLimiterService.getInstance('staking', {
      maxWeightPerMinute: ValidatorClient.MAX_WEIGHT_PER_MINUTE,
      requestWeight: ValidatorClient.REQUEST_WEIGHT
    });
  }

  public static getInstance(): ValidatorClient {
    if (!ValidatorClient.instance) {
      ValidatorClient.instance = new ValidatorClient();
    }
    return ValidatorClient.instance;
  }

  public startPolling(): void {
    if (this.pollingInterval) {
      logDeduplicator.warn('Validator polling already started');
      return;
    }

    logDeduplicator.info('Starting validator polling');
    // Faire une première mise à jour immédiate
    this.updateValidators().catch(error => {
      logDeduplicator.error('Error in initial validator update:', { error });
    });

    // Démarrer le polling régulier
    this.pollingInterval = setInterval(() => {
      this.updateValidators().catch(error => {
        logDeduplicator.error('Error in validator polling:', { error });
      });
    }, this.UPDATE_INTERVAL);
  }

  public stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
      logDeduplicator.info('Validator polling stopped');
    }
  }

  private async updateValidators(): Promise<void> {
    try {
      const data = await this.circuitBreaker.execute(() => 
        this.post<ValidatorSummary[]>('', {
          type: "validatorSummaries"
        })
      );
      
      await redisService.set(this.CACHE_KEY, JSON.stringify(data));
      const now = Date.now();
      await redisService.publish(this.UPDATE_CHANNEL, JSON.stringify({
        type: 'DATA_UPDATED',
        timestamp: now
      }));
      this.lastUpdate = now;
      logDeduplicator.info('Validators data updated successfully', {
        count: data.length,
        lastUpdate: this.lastUpdate
      });
    } catch (error) {
      logDeduplicator.error('Failed to update validators data:', { error });
      throw error;
    }
  }

  public async getValidatorSummariesRaw(): Promise<ValidatorSummary[]> {
    try {
      const cached = await redisService.get(this.CACHE_KEY);
      if (cached) {
        logDeduplicator.info('Retrieved validators from cache', {
          lastUpdate: this.lastUpdate
        });
        return JSON.parse(cached) as ValidatorSummary[];
      }

      // Si pas de données en cache, forcer une mise à jour
      logDeduplicator.warn('No validators in cache, forcing update');
      await this.updateValidators();
      const freshData = await redisService.get(this.CACHE_KEY);
      if (!freshData) {
        throw new Error('Failed to get validators data after update');
      }
      return JSON.parse(freshData) as ValidatorSummary[];
    } catch (error) {
      logDeduplicator.error('Error fetching validator summaries:', { error });
      throw error;
    }
  }

  public checkRateLimit(ip: string): boolean {
    return this.rateLimiter.checkRateLimit(ip);
  }

  public static getRequestWeight(): number {
    return ValidatorClient.REQUEST_WEIGHT;
  }
} 