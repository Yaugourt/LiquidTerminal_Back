import { BaseApiService } from '../../../core/base.api.service';
import { LeaderboardResponse } from '../../../types/leaderboard.types';
import { CircuitBreakerService } from '../../../core/circuit.breaker.service';
import { RateLimiterService } from '../../../core/hyperLiquid.ratelimiter.service';
import { redisService } from '../../../core/redis.service';
import { logDeduplicator } from '../../../utils/logDeduplicator';

export class HyperliquidLeaderboardClient extends BaseApiService {
  private static instance: HyperliquidLeaderboardClient;
  private static readonly API_URL = process.env.HYPERLIQUID_STATS_URL || 'https://stats-data.hyperliquid.xyz/Mainnet';
  private static readonly REQUEST_WEIGHT = 10;
  private static readonly MAX_WEIGHT_PER_MINUTE = 1200;

  private readonly CACHE_KEY = 'leaderboard:data';
  private readonly UPDATE_CHANNEL = 'leaderboard:updated';
  private readonly UPDATE_INTERVAL = 60000; // 1 minute
  private pollingInterval: NodeJS.Timeout | null = null;

  private circuitBreaker: CircuitBreakerService;
  private rateLimiter: RateLimiterService;

  private constructor() {
    super(HyperliquidLeaderboardClient.API_URL);
    this.circuitBreaker = CircuitBreakerService.getInstance('leaderboard');
    this.rateLimiter = RateLimiterService.getInstance('leaderboard', {
      maxWeightPerMinute: HyperliquidLeaderboardClient.MAX_WEIGHT_PER_MINUTE,
      requestWeight: HyperliquidLeaderboardClient.REQUEST_WEIGHT,
    });
  }

  public static getInstance(): HyperliquidLeaderboardClient {
    if (!HyperliquidLeaderboardClient.instance) {
      HyperliquidLeaderboardClient.instance = new HyperliquidLeaderboardClient();
    }
    return HyperliquidLeaderboardClient.instance;
  }

  public startPolling(): void {
    if (this.pollingInterval) {
      logDeduplicator.warn('Leaderboard polling already started');
      return;
    }

    logDeduplicator.info('Starting leaderboard polling');
    this.updateLeaderboardData().catch(err =>
      logDeduplicator.error('Error in initial leaderboard update:', { error: err instanceof Error ? err.message : String(err) })
    );

    this.pollingInterval = setInterval(() => {
      this.updateLeaderboardData().catch(err =>
        logDeduplicator.error('Error in leaderboard polling:', { error: err instanceof Error ? err.message : String(err) })
      );
    }, this.UPDATE_INTERVAL);
  }

  public stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
      logDeduplicator.info('Leaderboard polling stopped');
    }
  }

  private async updateLeaderboardData(): Promise<void> {
    try {
      const leaderboardData = await this.circuitBreaker.execute(() =>
        this.get<LeaderboardResponse>('/leaderboard')
      );

      await redisService.set(this.CACHE_KEY, JSON.stringify(leaderboardData), 300); // 5 minutes TTL

      await redisService.publish(this.UPDATE_CHANNEL, JSON.stringify({
        type: 'DATA_UPDATED',
        timestamp: Date.now(),
      }));

      logDeduplicator.info('Leaderboard data updated & cached', {
        entries: leaderboardData.leaderboardRows.length,
      });
    } catch (error) {
      logDeduplicator.error('Failed to update leaderboard data:', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  public async getLeaderboardData(): Promise<LeaderboardResponse | null> {
    try {
      const cachedData = await redisService.get(this.CACHE_KEY);
      if (cachedData) {
        return JSON.parse(cachedData);
      }

      // Si pas de cache, déclencher une mise à jour
      await this.updateLeaderboardData();
      
      const newCachedData = await redisService.get(this.CACHE_KEY);
      return newCachedData ? JSON.parse(newCachedData) : null;
    } catch (error) {
      logDeduplicator.error('Error getting leaderboard data:', { error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }

  public static getRequestWeight(): number {
    return HyperliquidLeaderboardClient.REQUEST_WEIGHT;
  }

  public checkRateLimit(ip: string): boolean {
    return this.rateLimiter.checkRateLimit(ip);
  }
} 