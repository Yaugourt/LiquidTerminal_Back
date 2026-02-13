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
   * @param coin Optional coin filter (e.g. "BTC")
   */
  async getStats24h(coin?: string): Promise<{ stats: HistoricalStats; units: Record<string, string>; filters: { period: string; coin: string | null } }> {
    const normalizedCoin = coin?.toUpperCase();
    const cacheKey = CACHE_KEYS.HISTORICAL_STATS_24H(normalizedCoin);

    // Check cache
    const cached = await redisService.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    // Compute from DB
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const stats = await this.repository.getStats(since, normalizedCoin);

    const now = new Date();
    const result = {
      stats,
      units: {
        totalVolume: 'USD',
        liquidationsCount: 'count',
        longCount: 'count',
        shortCount: 'count',
        longVolume: 'USD',
        shortVolume: 'USD',
        topCoin: 'symbol',
        topCoinVolume: 'USD',
        avgSize: 'USD',
        maxLiq: 'USD',
      },
      filters: {
        period: '24h',
        coin: normalizedCoin ?? null,
      },
      metadata: {
        computedAt: now.toISOString(),
        cacheTTL: CACHE_TTL.SHORT,
        nextUpdateAt: new Date(now.getTime() + CACHE_TTL.SHORT * 1000).toISOString(),
        dataFrom: since.toISOString(),
        dataTo: now.toISOString(),
      },
    };

    // Cache result
    await redisService.set(cacheKey, JSON.stringify(result), CACHE_TTL.SHORT);

    logDeduplicator.info('Historical stats 24h computed', {
      liquidationsCount: stats.liquidationsCount,
      totalVolume: stats.totalVolume,
      coin: normalizedCoin,
    });

    return result;
  }
}
