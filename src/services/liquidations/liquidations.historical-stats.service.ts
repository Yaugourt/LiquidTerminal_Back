import { HistoricalLiquidationRepository } from '../../repositories/interfaces/historical.repository.interface';
import { historicalLiquidationRepository } from '../../repositories';
import { HistoricalStats } from '../../types/historical.types';
import { redisService } from '../../core/redis.service';
import { CACHE_KEYS, CACHE_TTL } from '../../constants/cache.constants';
import { logDeduplicator } from '../../utils/logDeduplicator';

export type HistoricalStatsPeriod = '1h' | '24h' | '7d' | '14d' | '30d';

const PERIOD_HOURS: Record<HistoricalStatsPeriod, number> = {
  '1h': 1,
  '24h': 24,
  '7d': 7 * 24,
  '14d': 14 * 24,
  '30d': 30 * 24,
};

const PERIOD_CACHE_TTL: Record<HistoricalStatsPeriod, number> = {
  '1h': 30,                  // 30s — short window, needs fresher data
  '24h': CACHE_TTL.SHORT,    // 60s
  '7d': CACHE_TTL.MEDIUM,    // 300s
  '14d': CACHE_TTL.MEDIUM,   // 300s
  '30d': CACHE_TTL.MEDIUM,   // 300s
};

/**
 * Service for computing aggregated stats from the historical liquidation database.
 * Follows the Singleton pattern as per architecture.
 */
export class HistoricalStatsService {
  private static instance: HistoricalStatsService;
  private readonly repository: HistoricalLiquidationRepository;

  private constructor() {
    this.repository = historicalLiquidationRepository;
  }

  public static getInstance(): HistoricalStatsService {
    if (!HistoricalStatsService.instance) {
      HistoricalStatsService.instance = new HistoricalStatsService();
    }
    return HistoricalStatsService.instance;
  }

  /**
   * Get aggregated stats for a given period.
   * @param period Time window: '24h', '7d', '14d', '30d'
   * @param coin Optional coin filter (e.g. "BTC", "flx:SILVER")
   */
  async getStats(period: HistoricalStatsPeriod = '24h', coin?: string): Promise<{
    stats: HistoricalStats;
    filters: { period: string; coin: string | null };
    metadata: { computedAt: string; cacheTTL: number; nextUpdateAt: string; dataFrom: string; dataTo: string };
  }> {
    const cacheTTL = PERIOD_CACHE_TTL[period];
    const cacheKey = CACHE_KEYS.HISTORICAL_STATS(period, coin);

    // Check cache
    const cached = await redisService.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    // Compute from DB
    const hours = PERIOD_HOURS[period];
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    const stats = await this.repository.getStats(since, coin);

    const now = new Date();
    const result = {
      stats,
      filters: {
        period,
        coin: coin ?? null,
      },
      metadata: {
        computedAt: now.toISOString(),
        cacheTTL,
        nextUpdateAt: new Date(now.getTime() + cacheTTL * 1000).toISOString(),
        dataFrom: since.toISOString(),
        dataTo: now.toISOString(),
      },
    };

    // Cache result
    await redisService.set(cacheKey, JSON.stringify(result), cacheTTL);

    logDeduplicator.info('Historical stats computed', {
      period,
      liquidationsCount: stats.liquidationsCount,
      totalVolume_USD: stats.totalVolume_USD,
      coin,
    });

    return result;
  }
}
