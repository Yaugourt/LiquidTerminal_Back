import { BaseApiService } from '../../core/base.api.service';
import { GlobalStats } from '../../types/market.types';
import { CircuitBreakerService } from '../../core/circuit.breaker.service';
import { RateLimiterService } from '../../core/hyperLiquid.ratelimiter.service';
import { redisService } from '../../core/redis.service';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { startGuardedInterval } from '../../utils/guardedInterval';

interface RawGlobalStats {
  totalVolume: number;
  dailyVolume: number;
  nUsers: number;
}

export class HyperliquidGlobalStatsClient extends BaseApiService {
  private static instance: HyperliquidGlobalStatsClient;
  private static readonly API_URL = (process.env.HYPERLIQUID_API_URL || 'https://api.hyperliquid.xyz') + '/info';
  private static readonly REQUEST_WEIGHT = 20;
  private static readonly MAX_WEIGHT_PER_MINUTE = 1200;

  private readonly CACHE_KEY = 'global_stats';
  private readonly CACHE_DURATION = 60 * 5; // 5 minutes
  private readonly UPDATE_CHANNEL = 'global:stats:updated';
  private readonly UPDATE_INTERVAL = 10000; // 10 seconds
  private lastUpdate: number = 0;
  private pollingInterval: NodeJS.Timeout | null = null;

  private circuitBreaker: CircuitBreakerService;
  private rateLimiter: RateLimiterService;

  private constructor() {
    super(HyperliquidGlobalStatsClient.API_URL);
    this.circuitBreaker = CircuitBreakerService.getInstance('globalStats');
    this.rateLimiter = RateLimiterService.getInstance('globalStats', {
      maxWeightPerMinute: HyperliquidGlobalStatsClient.MAX_WEIGHT_PER_MINUTE,
      requestWeight: HyperliquidGlobalStatsClient.REQUEST_WEIGHT
    });
  }

  public static getInstance(): HyperliquidGlobalStatsClient {
    if (!HyperliquidGlobalStatsClient.instance) {
      HyperliquidGlobalStatsClient.instance = new HyperliquidGlobalStatsClient();
    }
    return HyperliquidGlobalStatsClient.instance;
  }

  public async getGlobalStats(): Promise<RawGlobalStats> {
    try {
      // Check cache first
      const cachedData = await redisService.get(this.CACHE_KEY);
      if (cachedData) {
        return JSON.parse(cachedData);
      }

      // If no cache, make API call with circuit breaker
      const response = await this.circuitBreaker.execute(() =>
        this.post<RawGlobalStats>('', { type: "globalStats" })
      );

      // Cache the data
      await redisService.set(
        this.CACHE_KEY,
        JSON.stringify(response),
        this.CACHE_DURATION
      );

      return response;
    } catch (error) {
      logDeduplicator.error('Error fetching global stats', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        api: HyperliquidGlobalStatsClient.API_URL,
        lastUpdate: this.lastUpdate
      });
      throw error;
    }
  }

  public startPolling(): void {
    if (this.pollingInterval) {
      logDeduplicator.warn('Global stats polling already started');
      return;
    }

    logDeduplicator.info('Starting global stats polling');
    this.pollingInterval = startGuardedInterval(
      'Global stats polling',
      () => this.updateGlobalStats(),
      this.UPDATE_INTERVAL
    );
  }

  public stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
      logDeduplicator.info('Global stats polling stopped');
    }
  }

  private async updateGlobalStats(): Promise<void> {
    try {
      const response = await this.circuitBreaker.execute(() =>
        this.post<RawGlobalStats>('', { type: "globalStats" })
      );

      // Cache the data
      await redisService.set(
        this.CACHE_KEY,
        JSON.stringify(response),
        this.CACHE_DURATION
      );

      const now = Date.now();
      await redisService.publish(this.UPDATE_CHANNEL, JSON.stringify({
        type: 'DATA_UPDATED',
        timestamp: now,
        stats: {
          nUsers: response.nUsers,
          dailyVolume: response.dailyVolume,
          totalVolume: response.totalVolume
        }
      }));
      this.lastUpdate = now;

      logDeduplicator.info('Global stats updated & cached', {
        lastUpdate: this.lastUpdate,
        nUsers: response.nUsers,
        dailyVolume: response.dailyVolume,
        totalVolume: response.totalVolume
      });
    } catch (error) {
      logDeduplicator.error('Failed to update global stats:', { 
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        lastUpdate: this.lastUpdate
      });
      // Ne pas propager l'erreur pour maintenir le polling comme dans spot.assetcontext
    }
  }

  /**
   * Returns the request weight for rate limiting
   */
  public static getRequestWeight(): number {
    return HyperliquidGlobalStatsClient.REQUEST_WEIGHT;
  }

  /**
   * Vérifie si une requête peut être effectuée selon les rate limits
   * @param ip Adresse IP du client
   */
  public checkRateLimit(ip: string): boolean {
    return this.rateLimiter.checkRateLimit(ip);
  }
} 