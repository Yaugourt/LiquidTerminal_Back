import { BaseApiService } from '../../../core/base.api.service';
import { SpotContext, AssetContext, Market, Token, MarketData } from '../../../types/market.types';
import { CircuitBreakerService } from '../../../core/circuit.breaker.service';
import { RateLimiterService } from '../../../core/hyperLiquid.ratelimiter.service';
import { redisService } from '../../../core/redis.service';
import { logDeduplicator } from '../../../utils/logDeduplicator';
import { startGuardedInterval } from '../../../utils/guardedInterval';
import { SpotBridgeReserveService } from '../../../services/spot/bridgeReserve.service';
import * as unitTokens from './unit.json';

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
  private readonly UPDATE_INTERVAL = 10000;
  private pollingInterval: NodeJS.Timeout | null = null;

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

    logDeduplicator.info('Starting spot polling');
    this.pollingInterval = startGuardedInterval(
      'Spot polling',
      () => this.updateSpotData(),
      this.UPDATE_INTERVAL
    );
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

      const tokenMap = spotContext.tokens.reduce((acc, token) => {
        acc[token.index] = token;
        return acc;
      }, {} as Record<number, Token>);

      // Indexed once instead of a linear `find` per market (first match wins, as before).
      const contextByCoin = new Map<string, AssetContext>();
      for (const ctx of assetContexts) {
        if (!contextByCoin.has(ctx.coin)) contextByCoin.set(ctx.coin, ctx);
      }

      const bridgeReserves = SpotBridgeReserveService.getInstance();
      await bridgeReserves.load();

      const markets: MarketData[] = spotContext.universe.map((market: Market) => {
        const ctx = contextByCoin.get(market.name);
        if (!ctx) return null;

        const tokenIndex = market.tokens[0];
        const token = tokenMap[tokenIndex];
        if (!token) return null;

        const current = Number(ctx.markPx);
        const previous = Number(ctx.prevDayPx);
        const change = previous !== 0 ? Number((((current - previous) / previous) * 100).toFixed(2)) : 0;

        const displayName = unitTokens[token.name as keyof typeof unitTokens] || token.name;
        const logoName = displayName;

        // Hyperliquid counts the bridge reserve parked on a token's HyperEVM
        // system address as circulating (XAUT0 at $770,000B).
        const circulating = Number(ctx.circulatingSupply);
        const bridgeReserve = Math.min(bridgeReserves.reserveOf(token.tokenId), circulating);
        const supply = circulating - bridgeReserve;

        return {
          name: displayName,
          logo: `https://app.hyperliquid.xyz/coins/${logoName}_USDC.svg`,
          price: current,
          marketCap: current * supply,
          volume: Number(ctx.dayNtlVlm),
          change24h: change,
          liquidity: Number(ctx.midPx),
          supply,
          marketIndex: market.index,
          tokenId: token.tokenId,
          // Not always USDC: 17 of the 330 pairs were quoted in USDH, USDT0 or USDE on 2026-10-09.
          quote: tokenMap[market.tokens[1]]?.name ?? 'USDC',
          ...(bridgeReserve > 0 ? { bridgeReserve } : {}),
        };
      }).filter(Boolean) as MarketData[];

      // Trier les marchés par volume décroissant
      markets.sort((a, b) => b.volume - a.volume);

      const pairedTokens = new Set(spotContext.universe.map((market) => market.tokens[0]));
      const tokensWithoutPairs = spotContext.tokens
        .filter(token => !pairedTokens.has(token.index))
        .map(token => token.name);

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
    } catch (error) {
      logDeduplicator.error('Failed to update spot data:', { 
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        type: error instanceof Error ? error.constructor.name : typeof error
      });
    }
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
