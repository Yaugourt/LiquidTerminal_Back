import { BaseApiService } from '../../../core/base.api.service';
import { GasAuctionResponse } from '../../../types/auction.types';
import { CircuitBreakerService } from '../../../core/circuit.breaker.service';
import { RateLimiterService } from '../../../core/hyperLiquid.ratelimiter.service';
import { redisService } from '../../../core/redis.service';
import { logDeduplicator } from '../../../utils/logDeduplicator';

export class HyperliquidSpotDeployClient extends BaseApiService {
  private static instance: HyperliquidSpotDeployClient;
  private static readonly API_URL = (process.env.HYPERLIQUID_UI_API_URL || 'https://api-ui.hyperliquid.xyz') + '/info';
  private static readonly REQUEST_WEIGHT = 20; // Poids standard pour les requêtes info
  private static readonly MAX_WEIGHT_PER_MINUTE = 1200;

  private readonly CACHE_KEY = 'spot:deploy:state';
  private readonly UPDATE_CHANNEL = 'spot:deploy:updated';
  private readonly UPDATE_INTERVAL = 10000; // 10 secondes
  private lastUpdate: number = 0;
  private pollingInterval: NodeJS.Timeout | null = null;

  private circuitBreaker: CircuitBreakerService;
  private rateLimiter: RateLimiterService;

  private constructor() {
    super(HyperliquidSpotDeployClient.API_URL);
    this.circuitBreaker = CircuitBreakerService.getInstance('spotDeploy');
    this.rateLimiter = RateLimiterService.getInstance('spotDeploy', {
      maxWeightPerMinute: HyperliquidSpotDeployClient.MAX_WEIGHT_PER_MINUTE,
      requestWeight: HyperliquidSpotDeployClient.REQUEST_WEIGHT
    });
  }

  public static getInstance(): HyperliquidSpotDeployClient {
    if (!HyperliquidSpotDeployClient.instance) {
      HyperliquidSpotDeployClient.instance = new HyperliquidSpotDeployClient();
    }
    return HyperliquidSpotDeployClient.instance;
  }

  public startPolling(): void {
    if (this.pollingInterval) {
      logDeduplicator.warn('Spot deploy polling already started');
      return;
    }

    logDeduplicator.info('Starting spot deploy polling');
    // Faire une première mise à jour immédiate
    this.updateDeployState().catch(error => {
      logDeduplicator.error('Error in initial spot deploy update:', { error });
    });

    // Démarrer le polling régulier
    this.pollingInterval = setInterval(() => {
      this.updateDeployState().catch(error => {
        logDeduplicator.error('Error in spot deploy polling:', { error });
      });
    }, this.UPDATE_INTERVAL);
  }

  public stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
      logDeduplicator.info('Spot deploy polling stopped');
    }
  }

  private async updateDeployState(): Promise<void> {
    try {
      const data = await this.circuitBreaker.execute(() => 
        this.post<GasAuctionResponse>('', {
          type: "spotDeployState",
          user: "0x0000000000000000000000000000000000000000"
        })
      );
      
      await redisService.set(this.CACHE_KEY, JSON.stringify(data));
      const now = Date.now();
      await redisService.publish(this.UPDATE_CHANNEL, JSON.stringify({
        type: 'DATA_UPDATED',
        timestamp: now
      }));
      this.lastUpdate = now;
      logDeduplicator.info('Spot deploy state updated successfully', {
        lastUpdate: this.lastUpdate
      });
    } catch (error) {
      logDeduplicator.error('Failed to update spot deploy state:', { error });
      throw error;
    }
  }

  /**
   * Récupère l'état du déploiement spot
   */
  public async getSpotDeployState(): Promise<GasAuctionResponse | null> {
    try {
      const cached = await redisService.get(this.CACHE_KEY);
      if (cached) {
        logDeduplicator.info('Retrieved spot deploy state from cache', {
          lastUpdate: this.lastUpdate
        });
        return JSON.parse(cached) as GasAuctionResponse;
      }

      logDeduplicator.warn('No spot deploy state in cache, forcing update');
      await this.updateDeployState();
      const freshData = await redisService.get(this.CACHE_KEY);
      if (!freshData) {
        throw new Error('Failed to get spot deploy state after update');
      }
      return JSON.parse(freshData) as GasAuctionResponse;
    } catch (error) {
      logDeduplicator.error('Error fetching spot deploy state:', { error });
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
    return HyperliquidSpotDeployClient.REQUEST_WEIGHT;
  }
} 