import { BaseApiService } from '../../../core/base.api.service';
import { GasAuctionResponse } from '../../../types/auction.types';
import { CircuitBreakerService } from '../../../core/circuit.breaker.service';
import { RateLimiterService } from '../../../core/hyperLiquid.ratelimiter.service';
import { redisService } from '../../../core/redis.service';
import { logDeduplicator } from '../../../utils/logDeduplicator';
import { startGuardedInterval } from '../../../utils/guardedInterval';
import { HypeDexerInfoClient, viaInfoProxy } from '../../hypedexer/rest/info/info.client';

const DEPLOY_STATE_USER = '0x0000000000000000000000000000000000000000';

export class HyperliquidSpotDeployClient extends BaseApiService {
  private static instance: HyperliquidSpotDeployClient;
  private static readonly API_URL = (process.env.HYPERLIQUID_UI_API_URL || 'https://api-ui.hyperliquid.xyz') + '/info';
  private static readonly REQUEST_WEIGHT = 20; // Poids standard pour les requêtes info
  private static readonly MAX_WEIGHT_PER_MINUTE = 1200;

  private readonly CACHE_KEY = 'spot:deploy:state';
  private readonly UPDATE_CHANNEL = 'spot:deploy:updated';
  // 5 s through HypeDexer's /info (3 credits a call, no Hyperliquid weight),
  // so the auction countdown and a new auction show within seconds. The
  // Dutch-auction price itself moves on a schedule the front computes.
  private readonly UPDATE_INTERVAL = 5000;
  // While the proxy is down, Hyperliquid (api-ui) is read at the former 20 s
  // pace (weight 20 → 60 a minute, counted in the backend's budget as api-ui
  // may share api.hyperliquid.xyz's per-IP weight), not at every 5 s tick.
  private static readonly DIRECT_MIN_INTERVAL_MS = 20000;
  private lastUpdate: number = 0;
  private lastDirectRead: number = 0;
  private pollingInterval: NodeJS.Timeout | null = null;

  private circuitBreaker: CircuitBreakerService;
  private rateLimiter: RateLimiterService;

  private constructor() {
    super(HyperliquidSpotDeployClient.API_URL);
    this.circuitBreaker = CircuitBreakerService.getInstance('spotDeploy');
    this.rateLimiter = RateLimiterService.getInstance('spotDeploy', {
      maxWeightPerMinute: HyperliquidSpotDeployClient.MAX_WEIGHT_PER_MINUTE,
      requestWeight: HyperliquidSpotDeployClient.REQUEST_WEIGHT
    });
  }

  public static getInstance(): HyperliquidSpotDeployClient {
    if (!HyperliquidSpotDeployClient.instance) {
      HyperliquidSpotDeployClient.instance = new HyperliquidSpotDeployClient();
    }
    return HyperliquidSpotDeployClient.instance;
  }

  public startPolling(): void {
    if (this.pollingInterval) {
      logDeduplicator.warn('Spot deploy polling already started');
      return;
    }

    logDeduplicator.info('Starting spot deploy polling');
    this.pollingInterval = startGuardedInterval(
      'Spot deploy polling',
      () => this.updateDeployState(),
      this.UPDATE_INTERVAL
    );
  }

  public stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
      logDeduplicator.info('Spot deploy polling stopped');
    }
  }

  /**
   * The state through the HypeDexer proxy, from Hyperliquid (api-ui) when the
   * proxy fails. null: the proxy is down and the last direct read is too
   * recent (DIRECT_MIN_INTERVAL_MS) to spend 20 more weight on; the cached
   * state stays. `force` (a cold cache) always reads.
   */
  private readState(force: boolean): Promise<GasAuctionResponse | null> {
    return viaInfoProxy<GasAuctionResponse | null>(
      'spotDeployState',
      () => HypeDexerInfoClient.getInstance().spotDeployState(DEPLOY_STATE_USER),
      async () => {
        const now = Date.now();
        if (!force && now - this.lastDirectRead < HyperliquidSpotDeployClient.DIRECT_MIN_INTERVAL_MS) return null;
        this.lastDirectRead = now;
        return this.circuitBreaker.execute(() =>
          this.post<GasAuctionResponse>('', {
            type: "spotDeployState",
            user: DEPLOY_STATE_USER
          })
        );
      }
    );
  }

  private async updateDeployState(force = false): Promise<void> {
    try {
      const data = await this.readState(force);
      if (!data) return;

      // Written and announced only when the state changed: at a 5 s tick it
      // usually has not, and nothing should be told about the same state again.
      const serialized = JSON.stringify(data);
      if (serialized === (await redisService.get(this.CACHE_KEY))) return;

      await redisService.set(this.CACHE_KEY, serialized);
      const now = Date.now();
      await redisService.publish(this.UPDATE_CHANNEL, JSON.stringify({
        type: 'DATA_UPDATED',
        timestamp: now
      }));
      this.lastUpdate = now;
      logDeduplicator.info('Spot deploy state updated successfully', {
        lastUpdate: this.lastUpdate
      });
    } catch (error) {
      logDeduplicator.error('Failed to update spot deploy state:', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  /**
   * Récupère l'état du déploiement spot
   */
  public async getSpotDeployState(): Promise<GasAuctionResponse | null> {
    try {
      const cached = await redisService.get(this.CACHE_KEY);
      if (cached) {
        logDeduplicator.info('Retrieved spot deploy state from cache', {
          lastUpdate: this.lastUpdate
        });
        return JSON.parse(cached) as GasAuctionResponse;
      }

      logDeduplicator.warn('No spot deploy state in cache, forcing update');
      await this.updateDeployState(true);
      const freshData = await redisService.get(this.CACHE_KEY);
      if (!freshData) {
        throw new Error('Failed to get spot deploy state after update');
      }
      return JSON.parse(freshData) as GasAuctionResponse;
    } catch (error) {
      logDeduplicator.error('Error fetching spot deploy state:', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  /**
   * Vérifie si une requête peut être effectuée selon les rate limits
   * @param ip Adresse IP du client
   */
  public checkRateLimit(ip: string): boolean {
    return this.rateLimiter.checkRateLimit(ip);
  }

  /**
   * Retourne le poids de la requête pour le rate limiting
   */
  public static getRequestWeight(): number {
    return HyperliquidSpotDeployClient.REQUEST_WEIGHT;
  }
} 