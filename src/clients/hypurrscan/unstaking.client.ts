import { BaseApiService } from '../../core/base.api.service';
import { CircuitBreakerService } from '../../core/circuit.breaker.service';
import { RateLimiterService } from '../../core/hyperLiquid.ratelimiter.service';
import { UnstakingQueueRawData } from '../../types/staking.types';
import { redisService } from '../../core/redis.service';
import { logDeduplicator } from '../../utils/logDeduplicator';

export class HypurrscanUnstakingClient extends BaseApiService {
  private static instance: HypurrscanUnstakingClient;
  private static readonly API_URL = 'https://api.hypurrscan.io';
  private static readonly REQUEST_WEIGHT = 2;
  private static readonly MAX_WEIGHT_PER_MINUTE = 1000;
  private static readonly UPDATE_INTERVAL = 40000; // 20 secondes
  private static readonly CACHE_KEY = 'hypurrscan:unstaking';
  private static readonly UPDATE_CHANNEL = 'hypurrscan:unstaking:updated';

  private circuitBreaker: CircuitBreakerService;
  private rateLimiter: RateLimiterService;
  private lastUpdate: number = 0;
  private pollingInterval: NodeJS.Timeout | null = null;

  private constructor() {
    super(HypurrscanUnstakingClient.API_URL);
    this.circuitBreaker = CircuitBreakerService.getInstance('hypurrscan-unstaking');
    this.rateLimiter = RateLimiterService.getInstance('hypurrscan-unstaking', {
      maxWeightPerMinute: HypurrscanUnstakingClient.MAX_WEIGHT_PER_MINUTE,
      requestWeight: HypurrscanUnstakingClient.REQUEST_WEIGHT
    });
  }

  public static getInstance(): HypurrscanUnstakingClient {
    if (!HypurrscanUnstakingClient.instance) {
      HypurrscanUnstakingClient.instance = new HypurrscanUnstakingClient();
    }
    return HypurrscanUnstakingClient.instance;
  }

  public startPolling(): void {
    if (this.pollingInterval) {
      logDeduplicator.warn('Hypurrscan unstaking polling already started');
      return;
    }

    logDeduplicator.info('Starting Hypurrscan unstaking polling');
    // Faire une première mise à jour immédiate
    this.updateUnstakingQueue().catch(error => {
      logDeduplicator.error('Error in initial Hypurrscan unstaking update:', { error });
    });

    // Démarrer le polling régulier
    this.pollingInterval = setInterval(() => {
      this.updateUnstakingQueue().catch(error => {
        logDeduplicator.error('Error in Hypurrscan unstaking polling:', { error });
      });
    }, HypurrscanUnstakingClient.UPDATE_INTERVAL);
  }

  public stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
      logDeduplicator.info('Hypurrscan unstaking polling stopped');
    }
  }

  private async updateUnstakingQueue(): Promise<void> {
    try {
      const data = await this.circuitBreaker.execute(() => 
        this.get<UnstakingQueueRawData[]>('/unstakingQueue')
      );
      
      await redisService.set(HypurrscanUnstakingClient.CACHE_KEY, JSON.stringify(data));
      const now = Date.now();
      await redisService.publish(HypurrscanUnstakingClient.UPDATE_CHANNEL, JSON.stringify({
        type: 'DATA_UPDATED',
        timestamp: now
      }));
      this.lastUpdate = now;
      logDeduplicator.info('Unstaking queue data updated successfully', {
        unstakingCount: data.length,
        lastUpdate: this.lastUpdate
      });
    } catch (error) {
      logDeduplicator.error('Failed to update unstaking queue data:', { error });
      throw error;
    }
  }

  public async getUnstakingQueue(): Promise<UnstakingQueueRawData[]> {
    try {
      const cached = await redisService.get(HypurrscanUnstakingClient.CACHE_KEY);
      if (cached) {
        logDeduplicator.info('Retrieved unstaking queue from cache', {
          lastUpdate: this.lastUpdate
        });
        return JSON.parse(cached);
      }

      logDeduplicator.warn('No unstaking queue in cache, forcing update');
      await this.updateUnstakingQueue();
      const freshData = await redisService.get(HypurrscanUnstakingClient.CACHE_KEY);
      if (!freshData) {
        throw new Error('Failed to get unstaking queue data after update');
      }
      return JSON.parse(freshData);
    } catch (error) {
      logDeduplicator.error('Error fetching unstaking queue:', { error });
      throw error;
    }
  }

  public checkRateLimit(ip: string): boolean {
    return this.rateLimiter.checkRateLimit(ip);
  }

  public static getRequestWeight(): number {
    return HypurrscanUnstakingClient.REQUEST_WEIGHT;
  }
} 