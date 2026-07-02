import { BaseApiService } from '../../../core/base.api.service';
import { ValidatorL1Vote } from '../../../types/staking.types';
import { CircuitBreakerService } from '../../../core/circuit.breaker.service';
import { RateLimiterService } from '../../../core/hyperLiquid.ratelimiter.service';
import { redisService } from '../../../core/redis.service';
import { logDeduplicator } from '../../../utils/logDeduplicator';

/**
 * Polls Hyperliquid `info { type: "validatorL1Votes" }` — the snapshot of
 * PENDING L1 governance votes (no history upstream). The raw snapshot is cached
 * verbatim; the join to validator summaries (stake, Foundation) happens in
 * ValidatorVotesService. Mirrors ValidatorClient (validatorSummaries).
 */
export class ValidatorVotesClient extends BaseApiService {
  private static instance: ValidatorVotesClient;
  private static readonly API_URL = (process.env.HYPERLIQUID_API_URL || 'https://api.hyperliquid.xyz') + '/info';
  private static readonly REQUEST_WEIGHT = 20;
  private static readonly MAX_WEIGHT_PER_MINUTE = 1200;

  private readonly CACHE_KEY = 'staking:validators:votes:raw_data';
  private readonly UPDATE_CHANNEL = 'staking:validators:votes:updated';
  // Governance snapshots change slowly (proposals live for days), so a longer
  // interval than the 10s validator poll is enough and lighter on the upstream.
  private readonly UPDATE_INTERVAL = 30000; // 30 secondes
  private lastUpdate: number = 0;
  private pollingInterval: NodeJS.Timeout | null = null;

  private circuitBreaker: CircuitBreakerService;
  private rateLimiter: RateLimiterService;

  private constructor() {
    super(ValidatorVotesClient.API_URL);
    // Same upstream (HL /info) as the validator feed → share the 'staking' budget.
    this.circuitBreaker = CircuitBreakerService.getInstance('staking');
    this.rateLimiter = RateLimiterService.getInstance('staking', {
      maxWeightPerMinute: ValidatorVotesClient.MAX_WEIGHT_PER_MINUTE,
      requestWeight: ValidatorVotesClient.REQUEST_WEIGHT
    });
  }

  public static getInstance(): ValidatorVotesClient {
    if (!ValidatorVotesClient.instance) {
      ValidatorVotesClient.instance = new ValidatorVotesClient();
    }
    return ValidatorVotesClient.instance;
  }

  public startPolling(): void {
    if (this.pollingInterval) {
      logDeduplicator.warn('Validator votes polling already started');
      return;
    }

    logDeduplicator.info('Starting validator votes polling');
    // First update immediately, then on a regular interval.
    this.updateVotes().catch(error => {
      logDeduplicator.error('Error in initial validator votes update:', { error: error instanceof Error ? error.message : String(error) });
    });

    this.pollingInterval = setInterval(() => {
      this.updateVotes().catch(error => {
        logDeduplicator.error('Error in validator votes polling:', { error: error instanceof Error ? error.message : String(error) });
      });
    }, this.UPDATE_INTERVAL);
  }

  public stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
      logDeduplicator.info('Validator votes polling stopped');
    }
  }

  private async updateVotes(): Promise<void> {
    try {
      const data = await this.circuitBreaker.execute(() =>
        this.post<ValidatorL1Vote[]>('', {
          type: 'validatorL1Votes'
        })
      );

      await redisService.set(this.CACHE_KEY, JSON.stringify(data));
      const now = Date.now();
      await redisService.publish(this.UPDATE_CHANNEL, JSON.stringify({
        type: 'DATA_UPDATED',
        timestamp: now
      }));
      this.lastUpdate = now;
      logDeduplicator.info('Validator votes data updated successfully', {
        count: Array.isArray(data) ? data.length : 0,
        lastUpdate: this.lastUpdate
      });
    } catch (error) {
      logDeduplicator.error('Failed to update validator votes data:', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  public async getValidatorVotesRaw(): Promise<ValidatorL1Vote[]> {
    try {
      const cached = await redisService.get(this.CACHE_KEY);
      if (cached) {
        return JSON.parse(cached) as ValidatorL1Vote[];
      }

      // No data in cache yet, force a refresh.
      logDeduplicator.warn('No validator votes in cache, forcing update');
      await this.updateVotes();
      const freshData = await redisService.get(this.CACHE_KEY);
      if (!freshData) {
        throw new Error('Failed to get validator votes data after update');
      }
      return JSON.parse(freshData) as ValidatorL1Vote[];
    } catch (error) {
      logDeduplicator.error('Error fetching validator votes:', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  public checkRateLimit(ip: string): boolean {
    return this.rateLimiter.checkRateLimit(ip);
  }

  public static getRequestWeight(): number {
    return ValidatorVotesClient.REQUEST_WEIGHT;
  }
}
