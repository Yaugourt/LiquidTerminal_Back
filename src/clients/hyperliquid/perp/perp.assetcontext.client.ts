import { BaseApiService } from '../../../core/base.api.service';
import { PerpMarket, PerpAssetContext } from '../../../types/market.types';
import { CircuitBreakerService } from '../../../core/circuit.breaker.service';
import { RateLimiterService } from '../../../core/hyperLiquid.ratelimiter.service';
import { redisService } from '../../../core/redis.service';
import { logDeduplicator } from '../../../utils/logDeduplicator';
import { startGuardedInterval } from '../../../utils/guardedInterval';
import { assemblePerp, mergePerpContexts, PerpMetaAndContexts } from './perp.assembler';
import { HyperliquidAssetCtxWSClient } from '../websocket/asset-ctx.ws.client';
import { CtxCadence, CTX_FLUSH_INTERVAL_MS, CTX_REST_ONLY_MS, isCtxStreamEnabled } from '../ctx.cadence';

export class HyperliquidPerpClient extends BaseApiService {
  private static instance: HyperliquidPerpClient;
  private static readonly API_URL = (process.env.HYPERLIQUID_API_URL || 'https://api.hyperliquid.xyz') + '/info';
  private static readonly REQUEST_WEIGHT = 20; // Poids standard pour les requêtes info
  private static readonly MAX_WEIGHT_PER_MINUTE = 1200;

  private readonly CACHE_KEY_RAW = 'perp:raw_data';
  private readonly CACHE_KEY_MARKETS = 'perp:markets';
  private readonly UPDATE_CHANNEL = 'perp:data:updated';
  /** REST-only cadence (stream switched off with HL_CTX_STREAM_ENABLED=false). */
  private readonly UPDATE_INTERVAL = CTX_REST_ONLY_MS;
  private lastUpdate: number = 0;
  private pollingInterval: NodeJS.Timeout | null = null;

  /** Set while the activeAssetCtx stream feeds this poller. */
  private cadence: CtxCadence | null = null;
  /** The last REST read, and when it arrived: the base the stream's contexts are laid over. */
  private lastRest: { meta: { universe: PerpMarket[] }; assetContexts: PerpAssetContext[]; at: number } | null = null;

  private circuitBreaker: CircuitBreakerService;
  private rateLimiter: RateLimiterService;

  private constructor() {
    super(HyperliquidPerpClient.API_URL);
    this.circuitBreaker = CircuitBreakerService.getInstance('perp');
    this.rateLimiter = RateLimiterService.getInstance('perp', {
      maxWeightPerMinute: HyperliquidPerpClient.MAX_WEIGHT_PER_MINUTE,
      requestWeight: HyperliquidPerpClient.REQUEST_WEIGHT
    });
  }

  public static getInstance(): HyperliquidPerpClient {
    if (!HyperliquidPerpClient.instance) {
      HyperliquidPerpClient.instance = new HyperliquidPerpClient();
    }
    return HyperliquidPerpClient.instance;
  }

  public startPolling(): void {
    if (this.pollingInterval) {
      logDeduplicator.warn('Perp polling already started');
      return;
    }

    if (isCtxStreamEnabled()) {
      // Contexts come from the socket every 2 s; REST reconciles (60 s) or covers for it (20 s).
      logDeduplicator.info('Starting perp polling (activeAssetCtx stream)');
      this.cadence = new CtxCadence('perp', 'Perp');
      this.pollingInterval = startGuardedInterval(
        'Perp polling',
        () => this.streamTick(),
        CTX_FLUSH_INTERVAL_MS
      );
      return;
    }

    logDeduplicator.info('Starting perp polling');
    this.pollingInterval = startGuardedInterval(
      'Perp polling',
      () => this.updatePerpData(),
      this.UPDATE_INTERVAL
    );
  }

  private async streamTick(): Promise<void> {
    const cadence = this.cadence;
    if (!cadence) return;
    await cadence.tick(
      () => this.updatePerpData(),
      () => this.publishStreamed()
    );
  }

  /** The last REST read with the stream's newer contexts laid over it, through the same assembler. */
  private async publishStreamed(): Promise<void> {
    const rest = this.lastRest;
    if (!rest) return;
    const merged = mergePerpContexts(
      rest.meta,
      rest.assetContexts,
      HyperliquidAssetCtxWSClient.getInstance().getLive('perp'),
      rest.at
    );
    await this.assembleAndPublish(rest.meta, merged);
  }

  public stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
      if (this.cadence) {
        HyperliquidAssetCtxWSClient.getInstance().setCoins('perp', []);
        this.cadence = null;
      }
      logDeduplicator.info('Perp polling stopped');
    }
  }

  private async updatePerpData(): Promise<void> {
    try {
      const [meta, assetContexts] = await this.circuitBreaker.execute(() => 
        this.post<PerpMetaAndContexts>('', {
          type: "metaAndAssetCtxs"
        })
      );

      // One assignment: a flush sees the previous read or this one, never a mix.
      this.lastRest = { meta, assetContexts, at: Date.now() };
      this.cadence?.restSucceeded();
      // A new listing gets subscribed, a delisted perp (no longer trades) unsubscribed.
      if (this.cadence) {
        HyperliquidAssetCtxWSClient.getInstance().setCoins(
          'perp',
          meta.universe.filter((market) => !market.isDelisted).map((market) => market.name)
        );
      }

      await this.assembleAndPublish(meta, assetContexts);
    } catch (error) {
      logDeduplicator.error('Failed to update perp data:', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  /**
   * Everything the poller writes, from one (meta, contexts) pair: the single
   * path for the REST read and for contexts merged from the socket.
   */
  private async assembleAndPublish(meta: { universe: PerpMarket[] }, assetContexts: PerpAssetContext[]): Promise<void> {
    const marketsData = assemblePerp(meta, assetContexts);

    await Promise.all([
      redisService.set(this.CACHE_KEY_RAW, JSON.stringify([meta, assetContexts])),
      redisService.set(this.CACHE_KEY_MARKETS, JSON.stringify(marketsData))
    ]);

    const now = Date.now();
    await redisService.publish(this.UPDATE_CHANNEL, JSON.stringify({
      type: 'DATA_UPDATED',
      timestamp: now
    }));
    this.lastUpdate = now;
    logDeduplicator.info('Perp data updated & cached', {
      markets: marketsData.length,
      filteredOut: meta.universe.length - marketsData.length
    });
  }

  /**
   * Récupère les données brutes de l'API
   */
  public async getMetaAndAssetCtxsRaw(): Promise<[{ universe: PerpMarket[] }, PerpAssetContext[]]> {
    try {
      const cached = await redisService.get(this.CACHE_KEY_RAW);
      if (cached) {
        logDeduplicator.info('Retrieved perp data from cache', {
          lastUpdate: this.lastUpdate
        });
        return JSON.parse(cached) as [{ universe: PerpMarket[] }, PerpAssetContext[]];
      }

      logDeduplicator.warn('No perp data in cache, forcing update');
      await this.updatePerpData();
      const freshData = await redisService.get(this.CACHE_KEY_RAW);
      if (!freshData) {
        throw new Error('Failed to get perp data after update');
      }
      return JSON.parse(freshData) as [{ universe: PerpMarket[] }, PerpAssetContext[]];
    } catch (error) {
      logDeduplicator.error('Error fetching perp data:', { error: error instanceof Error ? error.message : String(error) });
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
    return HyperliquidPerpClient.REQUEST_WEIGHT;
  }
} 