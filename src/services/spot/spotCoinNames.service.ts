import { redisService } from '../../core/redis.service';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { AssetContext, SpotContext } from '../../types/market.types';

/**
 * Resolves a Hyperliquid spot pair id ("@107", or the legacy "PURR/USDC") to
 * its base token name ("HYPE", "PURR") — the name alerts display and users
 * filter on.
 *
 * Reads the spotMeta the spot poller already caches in Redis (`spot:raw_data`)
 * instead of calling Hyperliquid. `resolve()` is synchronous for the WS hot
 * path: until the table is loaded, or for a pair listed after the last load,
 * it returns the id unchanged and schedules a reload.
 */
export class SpotCoinNameService {
  private static instance: SpotCoinNameService;

  private static readonly CACHE_KEY = 'spot:raw_data';
  /** Pairs are only ever added (one spot deploy auction every ~31 h): reload at most this often. */
  private static readonly MIN_RELOAD_INTERVAL_MS = 60_000;
  /** Until a table is loaded (cold Redis at boot, before the spot poller's first write): retry this soon. */
  private static readonly EMPTY_RELOAD_INTERVAL_MS = 5_000;

  private names = new Map<string, string>();
  private lastLoadStartedAt = 0;
  private loading: Promise<void> | null = null;

  private constructor() {}

  public static getInstance(): SpotCoinNameService {
    if (!SpotCoinNameService.instance) {
      SpotCoinNameService.instance = new SpotCoinNameService();
    }
    return SpotCoinNameService.instance;
  }

  /** Base token name of a spot pair id, or the id itself when it is unknown. */
  public resolve(coin: string): string {
    const name = this.names.get(coin);
    if (name !== undefined) return name;
    void this.reload();
    return coin;
  }

  /**
   * Reload the table from Redis; concurrent calls share one load, and loads
   * are rate-limited (once a minute, every 5 s while no table is loaded).
   */
  public reload(): Promise<void> {
    if (this.loading) return this.loading;
    const interval =
      this.names.size === 0 ? SpotCoinNameService.EMPTY_RELOAD_INTERVAL_MS : SpotCoinNameService.MIN_RELOAD_INTERVAL_MS;
    if (Date.now() - this.lastLoadStartedAt < interval) {
      return Promise.resolve();
    }
    this.lastLoadStartedAt = Date.now();
    this.loading = this.load().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async load(): Promise<void> {
    try {
      const raw = await redisService.get(SpotCoinNameService.CACHE_KEY);
      if (!raw) return;
      const [spot] = JSON.parse(raw) as [SpotContext, AssetContext[]];

      const tokenNames = new Map<number, string>();
      for (const token of spot.tokens) tokenNames.set(token.index, token.name);

      const names = new Map<string, string>();
      for (const market of spot.universe) {
        const base = tokenNames.get(market.tokens[0]);
        if (base) names.set(market.name, base);
      }
      this.names = names;
    } catch (error) {
      logDeduplicator.warn('SpotCoinNameService: failed to load the spot pairs', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
