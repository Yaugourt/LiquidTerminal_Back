import { BaseApiService } from '../../core/base.api.service';
import { SpotUSDCData } from '../../types/market.types';
import { USDCDataError } from '../../errors/spot.errors';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { startGuardedInterval } from '../../utils/guardedInterval';
import { redisService } from '../../core/redis.service';
import { CircuitBreakerService } from '../../core/circuit.breaker.service';
import { RateLimiterService } from '../../core/hyperLiquid.ratelimiter.service';

export class SpotUSDCClient extends BaseApiService {
  private static instance: SpotUSDCClient;
  private static readonly API_URL = process.env.HYPURRSCAN_API_URL || 'https://api.hypurrscan.io';
  private static readonly REQUEST_WEIGHT = 1;
  private static readonly MAX_WEIGHT_PER_MINUTE = 1000;

  private readonly CACHE_KEY_RAW = 'spotUSDC:raw_data';
  private readonly UPDATE_CHANNEL = 'spotUSDC:data:updated';
  private readonly UPDATE_INTERVAL = 60000;
  private pollingInterval: NodeJS.Timeout | null = null;
  private circuitBreaker: CircuitBreakerService;
  private rateLimiter: RateLimiterService;

  private constructor() {
    super(SpotUSDCClient.API_URL);
    this.circuitBreaker = CircuitBreakerService.getInstance('spotUSDC');
    this.rateLimiter = RateLimiterService.getInstance('spotUSDC', {
      maxWeightPerMinute: SpotUSDCClient.MAX_WEIGHT_PER_MINUTE,
      requestWeight: SpotUSDCClient.REQUEST_WEIGHT
    });
  }

  public static getInstance(): SpotUSDCClient {
    if (!SpotUSDCClient.instance) {
      SpotUSDCClient.instance = new SpotUSDCClient();
    }
    return SpotUSDCClient.instance;
  }

  public startPolling(): void {
    if (this.pollingInterval) {
      logDeduplicator.warn('SpotUSDC polling already started');
      return;
    }

    logDeduplicator.info('Starting SpotUSDC polling');
    this.pollingInterval = startGuardedInterval(
      'SpotUSDC polling',
      () => this.updateSpotUSDCData(),
      this.UPDATE_INTERVAL
    );
  }

  public stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
      logDeduplicator.info('SpotUSDC polling stopped');
    }
  }

  private async updateSpotUSDCData(): Promise<void> {
    try {
      const data = await this.circuitBreaker.execute(() => 
        this.get<SpotUSDCData>('/spotUSDC')
      );
      
      if (data) {
        await redisService.set(this.CACHE_KEY_RAW, JSON.stringify(data));
        await redisService.publish(this.UPDATE_CHANNEL, JSON.stringify({
          type: 'DATA_UPDATED',
          timestamp: Date.now()
        }));

        logDeduplicator.info('SpotUSDC data updated successfully', {
          lastUpdate: data.lastUpdate,
          totalSpotUSDC: data.totalSpotUSDC
        });
      }
    } catch (error) {
      logDeduplicator.error('Failed to update SpotUSDC data:', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  public async getSpotUSDCData(): Promise<SpotUSDCData> {
    try {
      const cachedData = await redisService.get(this.CACHE_KEY_RAW);
      
      if (cachedData) {
        return JSON.parse(cachedData) as SpotUSDCData;
      }
      
      return await this.circuitBreaker.execute(() => 
        this.get<SpotUSDCData>('/spotUSDC')
      );
    } catch (error) {
      logDeduplicator.error('Error retrieving SpotUSDC data:', { error: error instanceof Error ? error.message : String(error) });
      throw new USDCDataError(error instanceof Error ? error.message : 'Failed to fetch USDC data');
    }
  }

  public static getRequestWeight(): number {
    return SpotUSDCClient.REQUEST_WEIGHT;
  }

  public checkRateLimit(ip: string): boolean {
    return this.rateLimiter.checkRateLimit(ip);
  }
} 