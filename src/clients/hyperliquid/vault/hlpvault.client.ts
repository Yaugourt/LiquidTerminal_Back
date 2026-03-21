import { BaseApiService } from '../../../core/base.api.service';
import { VaultDetails } from '../../../types/vault.types';
import { CircuitBreakerService } from '../../../core/circuit.breaker.service';
import { RateLimiterService } from '../../../core/hyperLiquid.ratelimiter.service';
import { logDeduplicator } from '../../../utils/logDeduplicator';
import { redisService } from '../../../core/redis.service';

export class HyperliquidVaultClient extends BaseApiService {
  private static instance: HyperliquidVaultClient;
  private static readonly API_URL = (process.env.HYPERLIQUID_API_URL || 'https://api.hyperliquid.xyz') + '/info';
  private static readonly REQUEST_WEIGHT = 20; // Poids standard pour les requêtes info
  private static readonly MAX_WEIGHT_PER_MINUTE = 1200;
  private static readonly HLP_VAULT_ADDRESS = '0xdfc24b077bc1425ad1dea75bcb6f8158e10df303';
  private static readonly CACHE_KEY = 'vault:hlp:tvl';
  private static readonly UPDATE_CHANNEL = 'vault:hlp:updated';
  private static readonly UPDATE_INTERVAL = 20000; // 20 secondes

  private circuitBreaker: CircuitBreakerService;
  private rateLimiter: RateLimiterService;
  private lastUpdate: number = 0;
  private pollingInterval: NodeJS.Timeout | null = null;

  private constructor() {
    super(HyperliquidVaultClient.API_URL);
    this.circuitBreaker = CircuitBreakerService.getInstance('vault');
    this.rateLimiter = RateLimiterService.getInstance('vault', {
      maxWeightPerMinute: HyperliquidVaultClient.MAX_WEIGHT_PER_MINUTE,
      requestWeight: HyperliquidVaultClient.REQUEST_WEIGHT
    });
  }

  public static getInstance(): HyperliquidVaultClient {
    if (!HyperliquidVaultClient.instance) {
      HyperliquidVaultClient.instance = new HyperliquidVaultClient();
    }
    return HyperliquidVaultClient.instance;
  }

  public startPolling(): void {
    if (this.pollingInterval) {
      logDeduplicator.warn('Vault polling already started');
      return;
    }

    logDeduplicator.info('Starting vault polling');
    // Faire une première mise à jour immédiate
    this.updateHlpTvl().catch(error => {
      logDeduplicator.error('Error in initial vault update:', { error: error instanceof Error ? error.message : String(error) });
    });

    // Démarrer le polling régulier
    this.pollingInterval = setInterval(() => {
      this.updateHlpTvl().catch(error => {
        logDeduplicator.error('Error in vault polling:', { error: error instanceof Error ? error.message : String(error) });
      });
    }, HyperliquidVaultClient.UPDATE_INTERVAL);
  }

  public stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
      logDeduplicator.info('Vault polling stopped');
    }
  }

  /**
   * Récupère les détails du vault pour une adresse donnée
   */
  public async getVaultDetailsRaw(address: string): Promise<VaultDetails> {
    return this.circuitBreaker.execute(() => 
      this.post<VaultDetails>('', {
        type: "vaultDetails",
        vaultAddress: address
      })
    );
  }

  /**
   * Récupère la TVL du vault HLP
   */
  public async getHlpTvl(): Promise<number> {
    try {
      // Essayer d'abord de récupérer depuis le cache
      const cachedTvl = await redisService.get(HyperliquidVaultClient.CACHE_KEY);
      
      if (cachedTvl) {
        return parseFloat(cachedTvl);
      }
      
      // Si pas de données en cache, récupérer depuis l'API
      const vaultDetails = await this.getVaultDetailsRaw(HyperliquidVaultClient.HLP_VAULT_ADDRESS);
      
      // Trouver le portfolio "day"
      const dayPortfolio = vaultDetails.portfolio.find(([key]) => key === 'day');
      
      if (!dayPortfolio) {
        logDeduplicator.warn('No day portfolio found for HLP vault');
        return 0;
      }
      
      const [_, portfolioData] = dayPortfolio;
      
      if (!portfolioData.accountValueHistory || portfolioData.accountValueHistory.length === 0) {
        logDeduplicator.warn('No account value history found for HLP vault day portfolio');
        return 0;
      }
      
      // Trier par timestamp décroissant pour avoir la plus récente en premier
      const sortedHistory = [...portfolioData.accountValueHistory].sort((a, b) => b[0] - a[0]);
      const latestValue = parseFloat(sortedHistory[0][1]);
      
      // Mettre en cache
      await redisService.set(HyperliquidVaultClient.CACHE_KEY, latestValue.toString());
      
      logDeduplicator.info('HLP vault TVL retrieved successfully', { 
        tvl: latestValue,
        timestamp: sortedHistory[0][0]
      });
      
      return latestValue;
    } catch (error) {
      logDeduplicator.error('Error fetching HLP vault TVL:', { 
        error: error instanceof Error ? error.message : String(error)
      });
      return 0;
    }
  }

  /**
   * Met à jour la TVL du vault HLP
   */
  private async updateHlpTvl(): Promise<void> {
    try {
      const tvl = await this.getHlpTvl();
      
      // Publier l'événement de mise à jour
      await redisService.publish(HyperliquidVaultClient.UPDATE_CHANNEL, JSON.stringify({
        type: 'DATA_UPDATED',
        timestamp: Date.now()
      }));
      
      this.lastUpdate = Date.now();
      
      logDeduplicator.info('HLP vault TVL updated', { tvl });
    } catch (error) {
      logDeduplicator.error('Failed to update HLP vault TVL:', { error: error instanceof Error ? error.message : String(error) });
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
    return HyperliquidVaultClient.REQUEST_WEIGHT;
  }
} 