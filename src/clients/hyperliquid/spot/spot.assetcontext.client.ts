import { BaseApiService } from '../../../core/base.api.service';
import { SpotContext, AssetContext } from '../../../types/market.types';
import { CircuitBreakerService } from '../../../core/circuit.breaker.service';
import { RateLimiterService } from '../../../core/hyperLiquid.ratelimiter.service';
import { redisService } from '../../../core/redis.service';
import { logDeduplicator } from '../../../utils/logDeduplicator';
import { startGuardedInterval } from '../../../utils/guardedInterval';
import { SpotBridgeReserveService } from '../../../services/spot/bridgeReserve.service';
import { assembleSpot, mergeSpotContexts } from './spot.assembler';
import { HyperliquidAssetCtxWSClient } from '../websocket/asset-ctx.ws.client';
import { CtxCadence, CTX_FLUSH_INTERVAL_MS, CTX_REST_ONLY_MS, isCtxStreamEnabled } from '../ctx.cadence';

export class HyperliquidSpotClient extends BaseApiService {
  private static instance: HyperliquidSpotClient;
  private static readonly API_URL = (process.env.HYPERLIQUID_API_URL || 'https://api.hyperliquid.xyz') + '/info';
  private static readonly REQUEST_WEIGHT = 20;
  private static readonly MAX_WEIGHT_PER_MINUTE = 1200;

  private readonly CACHE_KEY_RAW = 'spot:raw_data';
  /** Epoch ms of the last write of CACHE_KEY_RAW: readers can tell frozen data from live data. */
  private readonly CACHE_KEY_RAW_UPDATED_AT = 'spot:raw_data:updated_at';
  private readonly CACHE_KEY_MARKETS = 'spot:markets';
  private readonly CACHE_KEY_TOKENS = 'spot:tokens:without_pairs';
  private readonly UPDATE_CHANNEL = 'spot:data:updated';
  /** REST-only cadence (stream switched off with HL_CTX_STREAM_ENABLED=false). */
  private readonly UPDATE_INTERVAL = CTX_REST_ONLY_MS;
  private pollingInterval: NodeJS.Timeout | null = null;

  /** Set while the activeAssetCtx stream feeds this poller. */
  private cadence: CtxCadence | null = null;
  /** The last REST read, and when it arrived: the base the stream's contexts are laid over. */
  private lastRest: { spotContext: SpotContext; assetContexts: AssetContext[]; at: number } | null = null;

  private circuitBreaker: CircuitBreakerService;
  private rateLimiter: RateLimiterService;

  private constructor() {
    super(HyperliquidSpotClient.API_URL);
    this.circuitBreaker = CircuitBreakerService.getInstance('spot');
    this.rateLimiter = RateLimiterService.getInstance('spot', {
      maxWeightPerMinute: HyperliquidSpotClient.MAX_WEIGHT_PER_MINUTE,
      requestWeight: HyperliquidSpotClient.REQUEST_WEIGHT,
    });
  }

  public static getInstance(): HyperliquidSpotClient {
    if (!HyperliquidSpotClient.instance) {
      HyperliquidSpotClient.instance = new HyperliquidSpotClient();
    }
    return HyperliquidSpotClient.instance;
  }

  public startPolling(): void {
    if (this.pollingInterval) {
      logDeduplicator.warn('Spot polling already started');
      return;
    }

    if (isCtxStreamEnabled()) {
      // Contexts come from the socket every 2 s; REST reconciles (60 s) or covers for it (20 s).
      logDeduplicator.info('Starting spot polling (activeAssetCtx stream)');
      this.cadence = new CtxCadence('spot', 'Spot');
      this.pollingInterval = startGuardedInterval(
        'Spot polling',
        () => this.streamTick(),
        CTX_FLUSH_INTERVAL_MS
      );
      return;
    }

    logDeduplicator.info('Starting spot polling');
    this.pollingInterval = startGuardedInterval(
      'Spot polling',
      () => this.updateSpotData(),
      this.UPDATE_INTERVAL
    );
  }

  private async streamTick(): Promise<void> {
    const cadence = this.cadence;
    if (!cadence) return;
    await cadence.tick(
      () => this.updateSpotData(),
      () => this.publishStreamed()
    );
  }

  /** The last REST read with the stream's newer contexts laid over it, through the same assembler. */
  private async publishStreamed(): Promise<void> {
    const rest = this.lastRest;
    if (!rest) return;
    try {
      const merged = mergeSpotContexts(
        rest.assetContexts,
        HyperliquidAssetCtxWSClient.getInstance().getLive('spot'),
        rest.at
      );
      await this.assembleAndPublish(rest.spotContext, merged);
    } catch (error) {
      logDeduplicator.error('Failed to publish streamed spot data:', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  public stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
      if (this.cadence) {
        HyperliquidAssetCtxWSClient.getInstance().setCoins('spot', []);
        this.cadence = null;
      }
      logDeduplicator.info('Spot polling stopped');
    }
  }

  private async updateSpotData(): Promise<void> {
    try {
      logDeduplicator.info('Making API call to Hyperliquid...');
      const [spotContext, assetContexts] = await this.circuitBreaker.execute(() =>
        this.post<[SpotContext, AssetContext[]]>('', {
          type: 'spotMetaAndAssetCtxs',
        })
      );
      logDeduplicator.info('API call successful, processing data...');

      // One assignment: a flush sees the previous read or this one, never a mix.
      this.lastRest = { spotContext, assetContexts, at: Date.now() };
      this.cadence?.restSucceeded();
      // A new listing gets subscribed, a delisted pair unsubscribed.
      if (this.cadence) {
        HyperliquidAssetCtxWSClient.getInstance().setCoins('spot', spotContext.universe.map((market) => market.name));
      }

      await this.assembleAndPublish(spotContext, assetContexts);
    } catch (error) {
      logDeduplicator.error('Failed to update spot data:', { 
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        type: error instanceof Error ? error.constructor.name : typeof error
      });
    }
  }

  /**
   * Everything the poller writes, from one (meta, contexts) pair: the single
   * path for the REST read and for contexts merged from the socket.
   */
  private async assembleAndPublish(spotContext: SpotContext, assetContexts: AssetContext[]): Promise<void> {
    const bridgeReserves = SpotBridgeReserveService.getInstance();
    await bridgeReserves.load();

    const { markets, tokensWithoutPairs } = assembleSpot(spotContext, assetContexts, (tokenId) =>
      bridgeReserves.reserveOf(tokenId)
    );

    logDeduplicator.info('Caching data to Redis...');
    await Promise.all([
      redisService.set(this.CACHE_KEY_RAW, JSON.stringify([spotContext, assetContexts])),
      redisService.set(this.CACHE_KEY_RAW_UPDATED_AT, String(Date.now())),
      redisService.set(this.CACHE_KEY_MARKETS, JSON.stringify(markets)),
      redisService.set(this.CACHE_KEY_TOKENS, JSON.stringify(tokensWithoutPairs))
    ]);

    logDeduplicator.info('Publishing update event...');
    await redisService.publish(this.UPDATE_CHANNEL, JSON.stringify({
      type: 'DATA_UPDATED',
      timestamp: Date.now(),
    }));

    logDeduplicator.info('Spot data updated & cached', {
      markets: markets.length,
      tokensWithoutPairs: tokensWithoutPairs.length,
    });
  }

  public static getRequestWeight(): number {
    return HyperliquidSpotClient.REQUEST_WEIGHT;
  }

  /**
   * Vérifie si une requête peut être effectuée selon les rate limits
   * @param ip Adresse IP du client
   */
  public checkRateLimit(ip: string): boolean {
    return this.rateLimiter.checkRateLimit(ip);
  }
}
