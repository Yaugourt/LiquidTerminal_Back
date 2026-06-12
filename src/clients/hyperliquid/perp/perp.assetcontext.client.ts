import { BaseApiService } from '../../../core/base.api.service';
import { PerpMarket, PerpAssetContext } from '../../../types/market.types';
import { CircuitBreakerService } from '../../../core/circuit.breaker.service';
import { RateLimiterService } from '../../../core/hyperLiquid.ratelimiter.service';
import { redisService } from '../../../core/redis.service';
import { logDeduplicator } from '../../../utils/logDeduplicator';
import { startGuardedInterval } from '../../../utils/guardedInterval';

export class HyperliquidPerpClient extends BaseApiService {
  private static instance: HyperliquidPerpClient;
  private static readonly API_URL = (process.env.HYPERLIQUID_API_URL || 'https://api.hyperliquid.xyz') + '/info';
  private static readonly REQUEST_WEIGHT = 20; // Poids standard pour les requêtes info
  private static readonly MAX_WEIGHT_PER_MINUTE = 1200;

  private readonly CACHE_KEY_RAW = 'perp:raw_data';
  private readonly CACHE_KEY_MARKETS = 'perp:markets';
  private readonly UPDATE_CHANNEL = 'perp:data:updated';
  private readonly UPDATE_INTERVAL = 10000; // 10 secondes
  private lastUpdate: number = 0;
  private pollingInterval: NodeJS.Timeout | null = null;

  private circuitBreaker: CircuitBreakerService;
  private rateLimiter: RateLimiterService;

  private constructor() {
    super(HyperliquidPerpClient.API_URL);
    this.circuitBreaker = CircuitBreakerService.getInstance('perp');
    this.rateLimiter = RateLimiterService.getInstance('perp', {
      maxWeightPerMinute: HyperliquidPerpClient.MAX_WEIGHT_PER_MINUTE,
      requestWeight: HyperliquidPerpClient.REQUEST_WEIGHT
    });
  }

  public static getInstance(): HyperliquidPerpClient {
    if (!HyperliquidPerpClient.instance) {
      HyperliquidPerpClient.instance = new HyperliquidPerpClient();
    }
    return HyperliquidPerpClient.instance;
  }

  public startPolling(): void {
    if (this.pollingInterval) {
      logDeduplicator.warn('Perp polling already started');
      return;
    }

    logDeduplicator.info('Starting perp polling');
    this.pollingInterval = startGuardedInterval(
      'Perp polling',
      () => this.updatePerpData(),
      this.UPDATE_INTERVAL
    );
  }

  public stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
      logDeduplicator.info('Perp polling stopped');
    }
  }

  private async updatePerpData(): Promise<void> {
    try {
      const [meta, assetContexts] = await this.circuitBreaker.execute(() => 
        this.post<[{ universe: PerpMarket[] }, PerpAssetContext[]]>('', {
          type: "metaAndAssetCtxs"
        })
      );
      
      const marketsData = meta.universe
        .map((market: PerpMarket, index: number) => {
          const assetContext = assetContexts[index];
          const currentPrice = Number(assetContext.markPx);
          const prevDayPrice = Number(assetContext.prevDayPx);
          const change = prevDayPrice !== 0 ? Number((((currentPrice - prevDayPrice) / prevDayPrice) * 100).toFixed(2)) : 0;
          const volume = Number(assetContext.dayNtlVlm);

          return {
            index: index,
            name: market.name,
            logo: `https://app.hyperliquid.xyz/coins/${market.name}.svg`,
            price: currentPrice,
            change24h: change,
            volume: volume,
            openInterest: Number(assetContext.openInterest),
            funding: Number(assetContext.funding),
            maxLeverage: market.maxLeverage,
            onlyIsolated: market.onlyIsolated || false
          };
        })
        .filter(market => market.volume > 0); // Filtrer les tokens avec un volume de 0

      await Promise.all([
        redisService.set(this.CACHE_KEY_RAW, JSON.stringify([meta, assetContexts])),
        redisService.set(this.CACHE_KEY_MARKETS, JSON.stringify(marketsData))
      ]);

      const now = Date.now();
      await redisService.publish(this.UPDATE_CHANNEL, JSON.stringify({
        type: 'DATA_UPDATED',
        timestamp: now
      }));
      this.lastUpdate = now;
      logDeduplicator.info('Perp data updated & cached', {
        markets: marketsData.length,
        filteredOut: meta.universe.length - marketsData.length
      });
    } catch (error) {
      logDeduplicator.error('Failed to update perp data:', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  /**
   * Récupère les données brutes de l'API
   */
  public async getMetaAndAssetCtxsRaw(): Promise<[{ universe: PerpMarket[] }, PerpAssetContext[]]> {
    try {
      const cached = await redisService.get(this.CACHE_KEY_RAW);
      if (cached) {
        logDeduplicator.info('Retrieved perp data from cache', {
          lastUpdate: this.lastUpdate
        });
        return JSON.parse(cached) as [{ universe: PerpMarket[] }, PerpAssetContext[]];
      }

      logDeduplicator.warn('No perp data in cache, forcing update');
      await this.updatePerpData();
      const freshData = await redisService.get(this.CACHE_KEY_RAW);
      if (!freshData) {
        throw new Error('Failed to get perp data after update');
      }
      return JSON.parse(freshData) as [{ universe: PerpMarket[] }, PerpAssetContext[]];
    } catch (error) {
      logDeduplicator.error('Error fetching perp data:', { error: error instanceof Error ? error.message : String(error) });
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
    return HyperliquidPerpClient.REQUEST_WEIGHT;
  }
} 