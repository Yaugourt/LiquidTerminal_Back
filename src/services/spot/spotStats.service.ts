import { SpotGlobalStats, MarketData } from '../../types/market.types';
import { redisService } from '../../core/redis.service';
import { logDeduplicator } from '../../utils/logDeduplicator';

export class SpotGlobalStatsService {
  private readonly SPOT_MARKETS_CACHE_KEY = 'spot:markets';
  private readonly SPOT_USDC_CACHE_KEY = 'spotUSDC:raw_data';
  private readonly SPOT_MARKETS_UPDATE_CHANNEL = 'spot:data:updated';
  private readonly SPOT_USDC_UPDATE_CHANNEL = 'hypurrscan:spotUSDC:updated';
  private lastUpdate: Record<string, number> = {};

  constructor() {
    this.setupSubscriptions();
  }

  private setupSubscriptions(): void {
    // S'abonner aux mises à jour des données de marché
    redisService.subscribe(this.SPOT_MARKETS_UPDATE_CHANNEL, async (message) => {
      try {
        const { type, timestamp } = JSON.parse(message);
        if (type === 'DATA_UPDATED') {
          this.lastUpdate['markets'] = timestamp;
          logDeduplicator.info('Spot markets data cache updated', { timestamp });
        }
      } catch (error) {
        logDeduplicator.error('Error processing spot markets cache update:', { 
          error: error instanceof Error ? error.message : String(error) 
        });
      }
    });

    // S'abonner aux mises à jour des données USDC
    redisService.subscribe(this.SPOT_USDC_UPDATE_CHANNEL, async (message) => {
      try {
        const { type, dataType, timestamp } = JSON.parse(message);
        if (type === 'DATA_UPDATED') {
          this.lastUpdate[dataType] = timestamp;
          logDeduplicator.info('Spot USDC data cache updated', { 
            dataType, 
            timestamp 
          });
        }
      } catch (error) {
        logDeduplicator.error('Error processing spot USDC cache update:', { 
          error: error instanceof Error ? error.message : String(error) 
        });
      }
    });
  }

  public async getSpotGlobalStats(): Promise<SpotGlobalStats> {
    try {
      // Récupérer les données en parallèle
      const [marketsData, spotUSDCData] = await Promise.all([
        this.getMarketsDataFromCache(),
        this.getSpotUSDCDataFromCache()
      ]);

      if (!marketsData) {
        throw new Error('No spot market data available');
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
      const totalHIP2 = latestSpotUSDCData?.['HIP-2'] || latestSpotUSDCData?.USDC_HIP2 || 0;
      const totalSpotUSDT0 = latestSpotUSDCData?.totalSpotUSDT0 || 0;
      const totalSpotUSDE = latestSpotUSDCData?.totalSpotUSDE || 0;
      const totalSpotUSDH = latestSpotUSDCData?.totalSpotUSDH || 0;
      const totalStablecoins = totalSpotUSDC + totalSpotUSDT0 + totalSpotUSDE + totalSpotUSDH;

      // Calculer les variations sur 24h
      const variations = this.compute24hVariations(spotUSDCData, latestSpotUSDCData);

      logDeduplicator.info('Spot global stats retrieved successfully', {
        totalVolume24h,
        totalPairs,
        totalMarketCap,
        totalSpotUSDC,
        totalStablecoins,
        lastUpdate: this.lastUpdate
      });

      return {
        totalVolume24h,
        totalPairs,
        totalMarketCap,
        totalSpotUSDC,
        totalHIP2,
        totalSpotUSDT0,
        totalSpotUSDE,
        totalSpotUSDH,
        totalStablecoins,
        USDC_holdersCount: latestSpotUSDCData?.USDC_holdersCount || 0,
        USDT0_holdersCount: latestSpotUSDCData?.USDT0_holdersCount || 0,
        USDE_holdersCount: latestSpotUSDCData?.USDE_holdersCount || 0,
        USDH_holdersCount: latestSpotUSDCData?.USDH_holdersCount || 0,
        USDC_HIP2: latestSpotUSDCData?.USDC_HIP2 || 0,
        USDT0_HIP2: latestSpotUSDCData?.USDT0_HIP2 || 0,
        USDE_HIP2: latestSpotUSDCData?.USDE_HIP2 || 0,
        USDH_HIP2: latestSpotUSDCData?.USDH_HIP2 || 0,
        ...variations,
      };
    } catch (error) {
      logDeduplicator.error('Error retrieving spot global stats:', {
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Find the snapshot closest to 24h ago and compute absolute + percentage changes.
   * The Hypurrscan array is sorted chronologically (oldest first, newest last).
   * Each entry has a `lastUpdate` field (Unix timestamp in seconds).
   */
  private compute24hVariations(
    snapshots: Record<string, number>[] | null,
    latest: Record<string, number> | null
  ): {
    totalSpotUSDC_change24h: number | null;
    totalSpotUSDT0_change24h: number | null;
    totalSpotUSDE_change24h: number | null;
    totalSpotUSDH_change24h: number | null;
    totalStablecoins_change24h: number | null;
    totalSpotUSDC_changePct24h: number | null;
    totalSpotUSDT0_changePct24h: number | null;
    totalSpotUSDE_changePct24h: number | null;
    totalSpotUSDH_changePct24h: number | null;
    totalStablecoins_changePct24h: number | null;
    USDC_holdersCount_change24h: number | null;
    USDT0_holdersCount_change24h: number | null;
    USDE_holdersCount_change24h: number | null;
    USDH_holdersCount_change24h: number | null;
  } {
    const nullResult = {
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

    if (!snapshots || snapshots.length < 2 || !latest) return nullResult;

    const latestTs: number = latest.lastUpdate;
    if (!latestTs) return nullResult;

    const target24hTs = latestTs - 86400;

    // Find the snapshot closest to target (24h ago)
    let snapshot24h: Record<string, number> | null = null;
    let minDiff = Infinity;
    for (const snap of snapshots) {
      const ts: number = snap.lastUpdate;
      if (!ts) continue;
      const diff = Math.abs(ts - target24hTs);
      if (diff < minDiff) {
        minDiff = diff;
        snapshot24h = snap;
      }
    }

    if (!snapshot24h) return nullResult;

    const delta = (current: number, past: number): { change: number; pct: number } | null => {
      if (!past) return null;
      const change = current - past;
      const pct = (change / past) * 100;
      return { change, pct };
    };

    const usdcNow = latest.totalSpotUSDC || 0;
    const usdt0Now = latest.totalSpotUSDT0 || 0;
    const usdeNow = latest.totalSpotUSDE || 0;
    const usdhNow = latest.totalSpotUSDH || 0;
    const stablesNow = usdcNow + usdt0Now + usdeNow + usdhNow;

    const usdcThen = snapshot24h.totalSpotUSDC || 0;
    const usdt0Then = snapshot24h.totalSpotUSDT0 || 0;
    const usdeThen = snapshot24h.totalSpotUSDE || 0;
    const usdhThen = snapshot24h.totalSpotUSDH || 0;
    const stablesThen = usdcThen + usdt0Then + usdeThen + usdhThen;

    const usdcDelta = delta(usdcNow, usdcThen);
    const usdt0Delta = delta(usdt0Now, usdt0Then);
    const usdeDelta = delta(usdeNow, usdeThen);
    const usdhDelta = delta(usdhNow, usdhThen);
    const stablesDelta = delta(stablesNow, stablesThen);

    const usdcHoldersNow = latest.USDC_holdersCount || 0;
    const usdt0HoldersNow = latest.USDT0_holdersCount || 0;
    const usdeHoldersNow = latest.USDE_holdersCount || 0;
    const usdhHoldersNow = latest.USDH_holdersCount || 0;

    const usdcHoldersThen = snapshot24h.USDC_holdersCount || 0;
    const usdt0HoldersThen = snapshot24h.USDT0_holdersCount || 0;
    const usdeHoldersThen = snapshot24h.USDE_holdersCount || 0;
    const usdhHoldersThen = snapshot24h.USDH_holdersCount || 0;

    return {
      totalSpotUSDC_change24h: usdcDelta?.change ?? null,
      totalSpotUSDT0_change24h: usdt0Delta?.change ?? null,
      totalSpotUSDE_change24h: usdeDelta?.change ?? null,
      totalSpotUSDH_change24h: usdhDelta?.change ?? null,
      totalStablecoins_change24h: stablesDelta?.change ?? null,
      totalSpotUSDC_changePct24h: usdcDelta?.pct ?? null,
      totalSpotUSDT0_changePct24h: usdt0Delta?.pct ?? null,
      totalSpotUSDE_changePct24h: usdeDelta?.pct ?? null,
      totalSpotUSDH_changePct24h: usdhDelta?.pct ?? null,
      totalStablecoins_changePct24h: stablesDelta?.pct ?? null,
      USDC_holdersCount_change24h: usdcHoldersThen ? usdcHoldersNow - usdcHoldersThen : null,
      USDT0_holdersCount_change24h: usdt0HoldersThen ? usdt0HoldersNow - usdt0HoldersThen : null,
      USDE_holdersCount_change24h: usdeHoldersThen ? usdeHoldersNow - usdeHoldersThen : null,
      USDH_holdersCount_change24h: usdhHoldersThen ? usdhHoldersNow - usdhHoldersThen : null,
    };
  }

  private async getMarketsDataFromCache(): Promise<MarketData[] | null> {
    try {
      const raw = await redisService.get(this.SPOT_MARKETS_CACHE_KEY);
      return raw ? JSON.parse(raw) as MarketData[] : null;
    } catch (error) {
      logDeduplicator.error('Error retrieving market data from cache:', { error });
      return null;
    }
  }

  private async getSpotUSDCDataFromCache() {
    try {
      const cachedData = await redisService.get(this.SPOT_USDC_CACHE_KEY);
      return cachedData ? JSON.parse(cachedData) : null;
    } catch (error) {
      logDeduplicator.error('Error retrieving SpotUSDC data from cache:', { 
        error: error instanceof Error ? error.message : String(error) 
      });
      return null;
    }
  }
} 