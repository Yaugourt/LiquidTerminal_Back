import { HistoricalLiquidationRepository } from '../../repositories/interfaces/historical.repository.interface';
import { historicalLiquidationRepository } from '../../repositories';
import { HistoricalStats } from '../../types/historical.types';
import { redisService } from '../../core/redis.service';
import { CACHE_KEYS, CACHE_TTL } from '../../constants/cache.constants';
import { logDeduplicator } from '../../utils/logDeduplicator';

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
   * Get aggregated stats for the last 24 hours.
   * Cached in Redis for 60 seconds.
   */
  async getStats24h(): Promise<HistoricalStats> {
    const cacheKey = CACHE_KEYS.HISTORICAL_STATS_24H;

    // Check cache
    const cached = await redisService.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as HistoricalStats;
    }

    // Compute from DB
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const stats = await this.repository.getStats(since);

    // Cache result
    await redisService.set(cacheKey, JSON.stringify(stats), CACHE_TTL.SHORT);

    logDeduplicator.info('Historical stats 24h computed', {
      liquidationsCount: stats.liquidationsCount,
      totalVolume: stats.totalVolume,
    });

    return stats;
  }
}
