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
      logDeduplicator.error('Error in initial spot stats update:', { error: err })
    );

    this.pollingInterval = setInterval(() => {
      this.updateSpotStats().catch(err =>
        logDeduplicator.error('Error in spot stats polling:', { error: err })
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
      
      // Récupérer les données USDC spot les plus récentes
      const latestSpotUSDCData = spotUSDCData && spotUSDCData.length > 0 
        ? spotUSDCData[spotUSDCData.length - 1] 
        : null;
      
      const totalSpotUSDC = latestSpotUSDCData?.totalSpotUSDC || 0;
      const totalHIP2 = latestSpotUSDCData?.["HIP-2"] || latestSpotUSDCData?.USDC_HIP2 || 0;
      const totalSpotUSDT0 = latestSpotUSDCData?.totalSpotUSDT0 || 0;
      const totalSpotUSDE = latestSpotUSDCData?.totalSpotUSDE || 0;
      const totalSpotUSDH = latestSpotUSDCData?.totalSpotUSDH || 0;

      const stats: SpotGlobalStats = {
        totalVolume24h,
        totalPairs,
        totalMarketCap,
        totalSpotUSDC,
        totalHIP2,
        totalSpotUSDT0,
        totalSpotUSDE,
        totalSpotUSDH,
        totalStablecoins: totalSpotUSDC + totalSpotUSDT0 + totalSpotUSDE + totalSpotUSDH,
        USDC_holdersCount: latestSpotUSDCData?.USDC_holdersCount || 0,
        USDT0_holdersCount: latestSpotUSDCData?.USDT0_holdersCount || 0,
        USDE_holdersCount: latestSpotUSDCData?.USDE_holdersCount || 0,
        USDH_holdersCount: latestSpotUSDCData?.USDH_holdersCount || 0,
        USDC_HIP2: latestSpotUSDCData?.USDC_HIP2 || 0,
        USDT0_HIP2: latestSpotUSDCData?.USDT0_HIP2 || 0,
        USDE_HIP2: latestSpotUSDCData?.USDE_HIP2 || 0,
        USDH_HIP2: latestSpotUSDCData?.USDH_HIP2 || 0,
        // Variations calculées dans SpotGlobalStatsService (accès au tableau complet des snapshots)
        totalSpotUSDC_change24h: null,
        totalSpotUSDT0_change24h: null,
        totalSpotUSDE_change24h: null,
        totalSpotUSDH_change24h: null,
        totalStablecoins_change24h: null,
        totalSpotUSDC_changePct24h: null,
        totalSpotUSDT0_changePct24h: null,
        totalSpotUSDE_changePct24h: null,
        totalSpotUSDH_changePct24h: null,
        totalStablecoins_changePct24h: null,
        USDC_holdersCount_change24h: null,
        USDT0_holdersCount_change24h: null,
        USDE_holdersCount_change24h: null,
        USDH_holdersCount_change24h: null,
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
      logDeduplicator.error('Failed to update spot stats:', { error });
    }
  }

  private async getMarketsDataFromCache(): Promise<MarketData[] | null> {
    try {
      const raw = await redisService.get(HyperliquidSpotStatsClient.SPOT_MARKETS_CACHE_KEY);
      return raw ? JSON.parse(raw) as MarketData[] : null;
    } catch (error) {
      logDeduplicator.error('Error retrieving market data from cache:', { error });
      return null;
    }
  }

  private async getSpotUSDCDataFromCache() {
    try {
      const cachedData = await redisService.get(HyperliquidSpotStatsClient.SPOT_USDC_CACHE_KEY);
      return cachedData ? JSON.parse(cachedData) : null;
    } catch (error) {
      logDeduplicator.error('Error retrieving SpotUSDC data from cache:', { error });
      return null;
    }
  }
} 