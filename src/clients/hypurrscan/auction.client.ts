import { BaseApiService } from '../../core/base.api.service';
import { CircuitBreakerService } from '../../core/circuit.breaker.service';
import { RateLimiterService } from '../../core/hyperLiquid.ratelimiter.service';
import { AuctionInfo } from '../../types/auction.types';
import { redisService } from '../../core/redis.service';
import { logDeduplicator } from '../../utils/logDeduplicator';

export class HypurrscanClient extends BaseApiService {
  private static instance: HypurrscanClient;
  private static readonly API_URL = 'https://api.hypurrscan.io';
  private static readonly REQUEST_WEIGHT = 1;
  private static readonly MAX_WEIGHT_PER_MINUTE = 1000;
  private static readonly UPDATE_INTERVAL = 20000; // 20 secondes
  private static readonly CACHE_KEY = 'hypurrscan:auctions';
  private static readonly UPDATE_CHANNEL = 'hypurrscan:auctions:updated';

  private circuitBreaker: CircuitBreakerService;
  private rateLimiter: RateLimiterService;
  private lastUpdate: number = 0;
  private pollingInterval: NodeJS.Timeout | null = null;

  private constructor() {
    super(HypurrscanClient.API_URL);
    this.circuitBreaker = CircuitBreakerService.getInstance('hypurrscan');
    this.rateLimiter = RateLimiterService.getInstance('hypurrscan', {
      maxWeightPerMinute: HypurrscanClient.MAX_WEIGHT_PER_MINUTE,
      requestWeight: HypurrscanClient.REQUEST_WEIGHT
    });
  }

  public static getInstance(): HypurrscanClient {
    if (!HypurrscanClient.instance) {
      HypurrscanClient.instance = new HypurrscanClient();
    }
    return HypurrscanClient.instance;
  }

  public startPolling(): void {
    if (this.pollingInterval) {
      logDeduplicator.warn('Hypurrscan polling already started');
      return;
    }

    logDeduplicator.info('Starting Hypurrscan polling');
    // Faire une première mise à jour immédiate
    this.updateAuctions().catch(error => {
      logDeduplicator.error('Error in initial Hypurrscan update:', { error });
    });

    // Démarrer le polling régulier
    this.pollingInterval = setInterval(() => {
      this.updateAuctions().catch(error => {
        logDeduplicator.error('Error in Hypurrscan polling:', { error });
      });
    }, HypurrscanClient.UPDATE_INTERVAL);
  }

  public stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
      logDeduplicator.info('Hypurrscan polling stopped');
    }
  }

  private async updateAuctions(): Promise<void> {
    try {
      const data = await this.circuitBreaker.execute(() => 
        this.get<AuctionInfo[]>('/pastAuctions')
      );
      
      await redisService.set(HypurrscanClient.CACHE_KEY, JSON.stringify(data));
      const now = Date.now();
      await redisService.publish(HypurrscanClient.UPDATE_CHANNEL, JSON.stringify({
        type: 'DATA_UPDATED',
        timestamp: now
      }));
      this.lastUpdate = now;
      logDeduplicator.info('Auctions data updated successfully', {
        auctionsCount: data.length,
        lastUpdate: this.lastUpdate
      });
    } catch (error) {
      logDeduplicator.error('Failed to update auctions data:', { error });
      throw error;
    }
  }

  public async getPastAuctions(): Promise<AuctionInfo[]> {
    try {
      const cached = await redisService.get(HypurrscanClient.CACHE_KEY);
      if (cached) {
        logDeduplicator.info('Retrieved auctions from cache', {
          lastUpdate: this.lastUpdate
        });
        return JSON.parse(cached);
      }

      logDeduplicator.warn('No auctions in cache, forcing update');
      await this.updateAuctions();
      const freshData = await redisService.get(HypurrscanClient.CACHE_KEY);
      if (!freshData) {
        throw new Error('Failed to get auctions data after update');
      }
      return JSON.parse(freshData);
    } catch (error) {
      logDeduplicator.error('Error fetching auctions:', { error });
      throw error;
    }
  }

  /**
   * Vérifie si une requête peut être effectuée selon les rate limits
   * @param ip Adresse IP du client
   */
  public checkRateLimit(ip: string): boolean {
    return this.rateLimiter.checkRateLimit(ip);
  }

  /**
   * Retourne le poids de la requête pour le rate limiting
   */
  public static getRequestWeight(): number {
    return HypurrscanClient.REQUEST_WEIGHT;
  }
} 