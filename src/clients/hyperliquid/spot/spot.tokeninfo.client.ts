import { BaseApiService } from '../../../core/base.api.service';
import { TokenInfoResponse } from '../../../types/market.types';
import { CircuitBreakerService } from '../../../core/circuit.breaker.service';
import { RateLimiterService } from '../../../core/hyperLiquid.ratelimiter.service';
import { redisService } from '../../../core/redis.service';
import { logDeduplicator } from '../../../utils/logDeduplicator';

export class HyperliquidTokenInfoClient extends BaseApiService {
  private static instance: HyperliquidTokenInfoClient;
  private static readonly API_URL = (process.env.HYPERLIQUID_API_URL || 'https://api.hyperliquid.xyz') + '/info';
  private static readonly REQUEST_WEIGHT = 20; // Poids standard pour les requêtes info
  private static readonly MAX_WEIGHT_PER_MINUTE = 1200;
  private readonly CACHE_KEY = 'token:info:';
  private readonly UPDATE_CHANNEL = 'token:info:updated';
  private readonly UPDATE_INTERVAL = 10000; // 10 secondes
  private lastUpdate: Record<string, number> = {};
  private pollingInterval: NodeJS.Timeout | null = null;
  private activeTokens: Set<string> = new Set();

  private circuitBreaker: CircuitBreakerService;
  private rateLimiter: RateLimiterService;

  private constructor() {
    super(HyperliquidTokenInfoClient.API_URL);
    this.circuitBreaker = CircuitBreakerService.getInstance('tokenInfo');
    this.rateLimiter = RateLimiterService.getInstance('tokenInfo', {
      maxWeightPerMinute: HyperliquidTokenInfoClient.MAX_WEIGHT_PER_MINUTE,
      requestWeight: HyperliquidTokenInfoClient.REQUEST_WEIGHT
    });
  }

  public static getInstance(): HyperliquidTokenInfoClient {
    if (!HyperliquidTokenInfoClient.instance) {
      HyperliquidTokenInfoClient.instance = new HyperliquidTokenInfoClient();
    }
    return HyperliquidTokenInfoClient.instance;
  }

  public startPolling(): void {
    if (this.pollingInterval) {
      logDeduplicator.warn('Token info polling already started');
      return;
    }

    logDeduplicator.info('Starting token info polling');
    
    // Démarrer le polling régulier
    this.pollingInterval = setInterval(() => {
      this.updateAllTokens().catch(error => {
        logDeduplicator.error('Error in token info polling:', { error: error instanceof Error ? error.message : String(error) });
      });
    }, this.UPDATE_INTERVAL);
  }

  public stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
      logDeduplicator.info('Token info polling stopped');
    }
  }

  private async updateAllTokens(): Promise<void> {
    const updatePromises = Array.from(this.activeTokens).map(tokenId => 
      this.updateTokenInfo(tokenId).catch(error => {
        logDeduplicator.error('Error updating token info:', { tokenId, error: error instanceof Error ? error.message : String(error) });
      })
    );

    await Promise.all(updatePromises);
  }

  private async updateTokenInfo(tokenId: string): Promise<void> {
    try {
      const data = await this.circuitBreaker.execute(() => 
        this.post<TokenInfoResponse>('', {
          type: "tokenDetails",
          tokenId
        })
      );
      
      const cacheKey = `${this.CACHE_KEY}${tokenId}`;
      await redisService.set(cacheKey, JSON.stringify(data));
      const now = Date.now();
      await redisService.publish(this.UPDATE_CHANNEL, JSON.stringify({
        type: 'DATA_UPDATED',
        tokenId,
        timestamp: now
      }));
      this.lastUpdate[tokenId] = now;
      logDeduplicator.info('Token info updated successfully', {
        tokenId,
        lastUpdate: now
      });
    } catch (error) {
      logDeduplicator.error('Failed to update token info:', { tokenId, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  /**
   * Récupère les détails bruts d'un token
   */
  public async getTokenDetailsRaw(tokenId: string): Promise<TokenInfoResponse | null> {
    try {
      // Ajouter le token à la liste des tokens actifs pour le polling
      this.activeTokens.add(tokenId);

      const cacheKey = `${this.CACHE_KEY}${tokenId}`;
      const cached = await redisService.get(cacheKey);
      
      if (cached) {
        logDeduplicator.info('Retrieved token info from cache', {
          tokenId,
          lastUpdate: this.lastUpdate[tokenId]
        });
        return JSON.parse(cached) as TokenInfoResponse;
      }

      logDeduplicator.warn('No token info in cache, forcing update', { tokenId });
      await this.updateTokenInfo(tokenId);
      const freshData = await redisService.get(cacheKey);
      if (!freshData) {
        throw new Error(`Failed to get token info after update for ${tokenId}`);
      }
      return JSON.parse(freshData) as TokenInfoResponse;
    } catch (error) {
      logDeduplicator.error('Error fetching token info:', { tokenId, error: error instanceof Error ? error.message : String(error) });
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
    return HyperliquidTokenInfoClient.REQUEST_WEIGHT;
  }
} 