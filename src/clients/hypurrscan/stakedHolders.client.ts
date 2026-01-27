import { BaseApiService } from '../../core/base.api.service';
import { CircuitBreakerService } from '../../core/circuit.breaker.service';
import { RateLimiterService } from '../../core/hyperLiquid.ratelimiter.service';
import { StakedHoldersData } from '../../types/staking.types';
import { redisService } from '../../core/redis.service';
import { logDeduplicator } from '../../utils/logDeduplicator';

export class HypurrscanStakedHoldersClient extends BaseApiService {
  private static instance: HypurrscanStakedHoldersClient;
  private static readonly API_URL = 'https://api.hypurrscan.io';
  private static readonly REQUEST_WEIGHT = 1;
  private static readonly MAX_WEIGHT_PER_MINUTE = 1000;
  private static readonly UPDATE_INTERVAL = 50000; // 50 secondes
  private static readonly CACHE_KEY = 'hypurrscan:staked_holders';
  private static readonly UPDATE_CHANNEL = 'hypurrscan:staked_holders:updated';

  private circuitBreaker: CircuitBreakerService;
  private rateLimiter: RateLimiterService;
  private lastUpdate: number = 0;
  private pollingInterval: NodeJS.Timeout | null = null;

  private constructor() {
    super(HypurrscanStakedHoldersClient.API_URL);
    this.circuitBreaker = CircuitBreakerService.getInstance('hypurrscan_staked_holders');
    this.rateLimiter = RateLimiterService.getInstance('hypurrscan_staked_holders', {
      maxWeightPerMinute: HypurrscanStakedHoldersClient.MAX_WEIGHT_PER_MINUTE,
      requestWeight: HypurrscanStakedHoldersClient.REQUEST_WEIGHT
    });
  }

  public static getInstance(): HypurrscanStakedHoldersClient {
    if (!HypurrscanStakedHoldersClient.instance) {
      HypurrscanStakedHoldersClient.instance = new HypurrscanStakedHoldersClient();
    }
    return HypurrscanStakedHoldersClient.instance;
  }

  public startPolling(): void {
    if (this.pollingInterval) {
      logDeduplicator.warn('Hypurrscan staked holders polling already started');
      return;
    }

    logDeduplicator.info('Starting Hypurrscan staked holders polling');
    // Faire une première mise à jour immédiate
    this.updateStakedHolders().catch(error => {
      logDeduplicator.error('Error in initial staked holders update:', { error });
    });

    // Démarrer le polling régulier
    this.pollingInterval = setInterval(() => {
      this.updateStakedHolders().catch(error => {
        logDeduplicator.error('Error in staked holders polling:', { error });
      });
    }, HypurrscanStakedHoldersClient.UPDATE_INTERVAL);
  }

  public stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
      logDeduplicator.info('Stopped Hypurrscan staked holders polling');
    }
  }

  private async updateStakedHolders(): Promise<void> {
    try {
      const data = await this.circuitBreaker.execute(async () => {
        const response = await this.fetchWithTimeout<StakedHoldersData>('/holders/stakedHYPE', {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
          }
        });
        return response;
      });

      if (data) {
        this.lastUpdate = Date.now();
        await redisService.set(HypurrscanStakedHoldersClient.CACHE_KEY, JSON.stringify(data), 60);
        
        await redisService.publish(HypurrscanStakedHoldersClient.UPDATE_CHANNEL, JSON.stringify({
          timestamp: this.lastUpdate,
          holdersCount: data.holdersCount,
          lastUpdate: data.lastUpdate
        }));

        logDeduplicator.info('Updated staked holders data', {
          holdersCount: data.holdersCount,
          lastUpdate: this.lastUpdate
        });
      }
    } catch (error) {
      logDeduplicator.error('Failed to update staked holders data:', { error });
      throw error;
    }
  }

  public async getStakedHolders(): Promise<StakedHoldersData> {
    try {
      const cached = await redisService.get(HypurrscanStakedHoldersClient.CACHE_KEY);
      if (cached) {
        logDeduplicator.info('Retrieved staked holders from cache', {
          lastUpdate: this.lastUpdate
        });
        return JSON.parse(cached);
      }

      logDeduplicator.warn('No staked holders in cache, forcing update');
      await this.updateStakedHolders();
      const freshData = await redisService.get(HypurrscanStakedHoldersClient.CACHE_KEY);
      if (!freshData) {
        throw new Error('Failed to get staked holders data after update');
      }
      return JSON.parse(freshData);
    } catch (error) {
      logDeduplicator.error('Error fetching staked holders:', { error });
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
    return HypurrscanStakedHoldersClient.REQUEST_WEIGHT;
  }
} 