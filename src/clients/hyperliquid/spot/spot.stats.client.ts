import { redisService } from '../../../core/redis.service';
import { SpotGlobalStats, MarketData } from '../../../types/market.types';
import { logDeduplicator } from '../../../utils/logDeduplicator';

export class HyperliquidSpotStatsClient {
  private static instance: HyperliquidSpotStatsClient | null = null;
  private static readonly UPDATE_INTERVAL = 10000; // 10 secondes
  private static readonly SPOT_USDC_CACHE_KEY = 'spotUSDC:raw_data';
  private static readonly SPOT_STATS_CACHE_KEY = 'spot:global_stats';
  private static readonly UPDATE_CHANNEL = 'spot:stats:updated';
  private static readonly SPOT_MARKETS_CACHE_KEY = 'spot:markets';
  
  private pollingInterval: NodeJS.Timeout | null = null;

  private constructor() {}

  public static getInstance(): HyperliquidSpotStatsClient {
    if (!HyperliquidSpotStatsClient.instance) {
      HyperliquidSpotStatsClient.instance = new HyperliquidSpotStatsClient();
    }
    return HyperliquidSpotStatsClient.instance;
  }

  public startPolling(): void {
    if (this.pollingInterval) {
      logDeduplicator.warn('Spot stats polling already started');
      return;
    }

    logDeduplicator.info('Starting spot stats polling');
    this.updateSpotStats().catch(err =>
      logDeduplicator.error('Error in initial spot stats update:', { error: err instanceof Error ? err.message : String(err) })
    );

    this.pollingInterval = setInterval(() => {
      this.updateSpotStats().catch(err =>
        logDeduplicator.error('Error in spot stats polling:', { error: err instanceof Error ? err.message : String(err) })
      );
    }, HyperliquidSpotStatsClient.UPDATE_INTERVAL);
  }

  public stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
      logDeduplicator.info('Spot stats polling stopped');
    }
  }

  private async updateSpotStats(): Promise<void> {
    try {
      // Récupérer les données en parallèle
      const [marketsData, spotUSDCData] = await Promise.all([
        this.getMarketsDataFromCache(),
        this.getSpotUSDCDataFromCache()
      ]);

      if (!marketsData) {
        logDeduplicator.warn('No market data available for stats calculation');
        return;
      }

      // Calculer le volume total sur 24h
      const totalVolume24h = marketsData.reduce((total: number, market: MarketData) => total + market.volume, 0);
      
      // Calculer le nombre total de paires
      const totalPairs = marketsData.length;
      
      // Calculer la capitalisation totale du marché
      const totalMarketCap = marketsData.reduce((total: number, market: MarketData) => total + market.marketCap, 0);
      
      const latestSpotUSDCData = spotUSDCData && spotUSDCData.length > 0
        ? spotUSDCData[spotUSDCData.length - 1]
        : null;

      const totalSpotUSDC = latestSpotUSDCData?.totalSpotUSDC || 0;
      const totalHIP2 = latestSpotUSDCData?.["HIP-2"] || latestSpotUSDCData?.USDC_HIP2 || 0;

      const stats: SpotGlobalStats = {
        totalVolume24h,
        totalPairs,
        totalMarketCap,
        totalSpotUSDC,
        totalHIP2,
      };

      // Mettre en cache les statistiques
      await redisService.set(HyperliquidSpotStatsClient.SPOT_STATS_CACHE_KEY, JSON.stringify(stats));
      
      // Publier l'événement de mise à jour
      await redisService.publish(HyperliquidSpotStatsClient.UPDATE_CHANNEL, JSON.stringify({
        type: 'DATA_UPDATED',
        timestamp: Date.now()
      }));

      logDeduplicator.info('Spot global stats updated & cached', { 
        totalVolume24h,
        totalPairs,
        totalMarketCap,
        totalSpotUSDC,
        totalHIP2
      });
    } catch (error) {
      logDeduplicator.error('Failed to update spot stats:', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async getMarketsDataFromCache(): Promise<MarketData[] | null> {
    try {
      const raw = await redisService.get(HyperliquidSpotStatsClient.SPOT_MARKETS_CACHE_KEY);
      return raw ? JSON.parse(raw) as MarketData[] : null;
    } catch (error) {
      logDeduplicator.error('Error retrieving market data from cache:', { error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }

  private async getSpotUSDCDataFromCache() {
    try {
      const cachedData = await redisService.get(HyperliquidSpotStatsClient.SPOT_USDC_CACHE_KEY);
      return cachedData ? JSON.parse(cachedData) : null;
    } catch (error) {
      logDeduplicator.error('Error retrieving SpotUSDC data from cache:', { error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }
} 