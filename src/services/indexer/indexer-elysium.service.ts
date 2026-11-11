import { HypeDexerElysiumIndexerClient } from '../../clients/hypedexer/rest/elysium/elysium-indexer.client';
import type {
  ElysiumBatchesQuery,
  ElysiumBlocksQuery,
  ElysiumBridgeReservesQuery,
  ElysiumBridgeRetryablesQuery,
  ElysiumBridgeTokensQuery,
  ElysiumBridgeTransfersQuery,
  ElysiumNetworkQuery,
  ElysiumStatsDailyQuery,
  ElysiumTokensQuery,
  ElysiumTransactionsQuery,
  ElysiumUserActivityQuery,
  ElysiumUserBridgeQuery,
} from '../../clients/hypedexer/rest/elysium/elysium-indexer.client';
import { buildHypedexerCacheKey } from '../../clients/hypedexer/rest/shared/hypedexer-cache.helper';
import { cacheService } from '../../core/cache.service';
import { RateLimiterService } from '../../core/hyperLiquid.ratelimiter.service';
import { HYPEDEXER_TTL } from '../../constants/hypedexer.cache';
import { UpstreamBudgetExceededError } from '../../errors/upstreamBudget.errors';
import { ClientBudget } from '../../utils/clientBudget';
import { positiveIntEnv } from '../../utils/env';
import { currentUpstreamCaller } from '../../utils/request-context';

const ELYSIUM_CACHE_DOMAIN = 'elysium';

/**
 * The sizes a list is read from the provider in. The routes accept any `limit` from 1 to 100
 * and any `days` from 1 to 365, and each value used to be a cache key of its own: 100 keys per
 * list and filter, 365 for the daily figures, each one a billed call when it expires. A list is
 * now read at the first of these sizes that holds what was asked, kept under that size, and cut
 * to what was asked: the same rows as before (the lists are newest first, or largest first),
 * from 4 keys instead of 100.
 */
export const LIST_SIZES: readonly number[] = [10, 25, 50, 100];
export const DAILY_SIZES: readonly number[] = [7, 30, 90, 365];

/** The first of `sizes` that holds `asked` (the largest when none does); undefined when nothing was asked. */
export function sizeFor(asked: number | undefined, sizes: readonly number[]): number | undefined {
  if (asked === undefined) return undefined;
  return sizes.find((size) => asked <= size) ?? sizes[sizes.length - 1];
}

/**
 * Elysium testnet pass-through. Every cache key includes the query params so a
 * filtered call never shares an entry with the unfiltered one.
 */
export class IndexerElysiumService {
  private static instance: IndexerElysiumService;
  private readonly client = HypeDexerElysiumIndexerClient.getInstance();
  /** 240 per-address upstream calls a minute across all users (weight 1 each). */
  private readonly userBudget = RateLimiterService.getInstance('elysium-user-lookups', {
    maxWeightPerMinute: 240,
    requestWeight: 1,
  });
  /**
   * One client's share of those 240: a quarter. The route limiter lets a
   * client make 300 address requests a minute, so without a share one client
   * with fresh addresses spent the whole budget and every other visitor's
   * lookups failed. An address page makes 3 of these calls and a token page 2:
   * 60 a minute is 20 pages a minute that nobody has opened yet.
   */
  private readonly clientShare = new ClientBudget(positiveIntEnv('ELYSIUM_USER_LOOKUPS_PER_CLIENT_MINUTE', 60), 60_000);

  public static getInstance(): IndexerElysiumService {
    if (!IndexerElysiumService.instance) {
      IndexerElysiumService.instance = new IndexerElysiumService();
    }
    return IndexerElysiumService.instance;
  }

  private cached(
    method: string,
    params: object | undefined,
    ttl: number,
    fetcher: () => Promise<unknown>
  ): Promise<unknown> {
    // No `network` and `network=testnet` read the same upstream path: one
    // entry for both, so the explicit form is not a second billed call.
    const { network, ...rest } = (params ?? {}) as Record<string, unknown>;
    const key = buildHypedexerCacheKey(
      ELYSIUM_CACHE_DOMAIN,
      method,
      network === 'testnet' ? rest : { ...rest, network }
    );
    return cacheService.getOrSet<unknown>(key, fetcher, ttl);
  }

  /**
   * A list read at one of a few sizes and cut to the size asked (see LIST_SIZES). `field` is
   * the parameter that sizes it. A call with no size keeps the provider's default, as before.
   */
  private async sized<P extends object>(
    method: string,
    params: P | undefined,
    ttl: number,
    fetcher: (read: P | undefined) => Promise<unknown>,
    field: 'limit' | 'days' = 'limit',
    sizes: readonly number[] = LIST_SIZES
  ): Promise<unknown> {
    const asked = (params as Record<string, unknown> | undefined)?.[field] as number | undefined;
    const size = sizeFor(asked, sizes);
    const read = size === undefined || size === asked ? params : ({ ...params, [field]: size } as P);
    const data = await this.cached(method, read, ttl, () => fetcher(read));
    return asked !== undefined && Array.isArray(data) && data.length > asked ? data.slice(0, asked) : data;
  }

  public getStats(params?: ElysiumNetworkQuery): Promise<unknown> {
    return this.cached('stats', params, HYPEDEXER_TTL.elysiumStats, () => this.client.getStats(params));
  }

  public getStatsDaily(params?: ElysiumStatsDailyQuery): Promise<unknown> {
    return this.sized('stats:daily', params, HYPEDEXER_TTL.elysiumStatsDaily, (read) => this.client.getStatsDaily(read), 'days', DAILY_SIZES);
  }

  public getBlocks(params?: ElysiumBlocksQuery): Promise<unknown> {
    return this.sized('blocks', params, HYPEDEXER_TTL.elysiumBlocks, (read) => this.client.getBlocks(read));
  }

  public getTransactions(params?: ElysiumTransactionsQuery): Promise<unknown> {
    return this.sized('transactions', params, HYPEDEXER_TTL.elysiumTransactions, (read) => this.client.getTransactions(read));
  }

  public getBatches(params?: ElysiumBatchesQuery): Promise<unknown> {
    // The provider takes at most 50 batches a call.
    return this.sized('batches', params, HYPEDEXER_TTL.elysiumBatches, (read) => this.client.getBatches(read), 'limit', [10, 25, 50]);
  }

  public getBridgeTransfers(params?: ElysiumBridgeTransfersQuery): Promise<unknown> {
    return this.sized('bridge:transfers', params, HYPEDEXER_TTL.elysiumBridgeTransfers, (read) => this.client.getBridgeTransfers(read));
  }

  public getBridgeRetryables(params?: ElysiumBridgeRetryablesQuery): Promise<unknown> {
    return this.sized('bridge:retryables', params, HYPEDEXER_TTL.elysiumBridgeRetryables, (read) => this.client.getBridgeRetryables(read));
  }

  public getBridgeReserves(params: ElysiumBridgeReservesQuery): Promise<unknown> {
    return this.cached('bridge:reserves', params, HYPEDEXER_TTL.elysiumBridgeReserves, () =>
      this.client.getBridgeReserves(params)
    );
  }

  public getBridgeTokens(params?: ElysiumBridgeTokensQuery): Promise<unknown> {
    return this.sized('bridge:tokens', params, HYPEDEXER_TTL.elysiumBridgeTokens, (read) => this.client.getBridgeTokens(read));
  }

  public getTokens(params?: ElysiumTokensQuery): Promise<unknown> {
    return this.sized('tokens', params, HYPEDEXER_TTL.elysiumTokens, (read) => this.client.getTokens(read));
  }

  /** Addresses are lower-cased so checksum variants share one cache entry. */
  /**
   * Global budget for per-address upstream calls (cache misses only). Each
   * address is a fresh cache key, so a scan spread over many IPs would
   * otherwise spend the paid upstream quota and take the shared outbound
   * slots from every other route. Over budget, these lookups fail fast.
   *
   * The client the request is answered for first takes the call from its own
   * share: past it, it is refused as its own doing (429 + Retry-After, and no
   * failure is recorded against the address for the other visitors), and the
   * common budget is left to everyone else.
   */
  private userLookup<T>(fetch: () => Promise<T>): Promise<T> {
    const caller = currentUpstreamCaller();
    if (caller && !this.clientShare.take(caller.ipKey, 1)) {
      return Promise.reject(new UpstreamBudgetExceededError(this.clientShare.retryAfterS()));
    }
    if (!this.userBudget.checkRateLimit('global')) {
      return Promise.reject(new Error('Elysium per-address lookup budget exhausted'));
    }
    return fetch();
  }

  public getUserBalances(address: string, params?: ElysiumNetworkQuery): Promise<unknown> {
    const a = address.toLowerCase();
    return this.cached('user:balances', { address: a, ...params }, HYPEDEXER_TTL.elysiumUser, () =>
      this.userLookup(() => this.client.getUserBalances(a, params))
    );
  }

  /** One token's detail; same per-address budget, cached like the user lookups. */
  public getToken(address: string, params?: ElysiumNetworkQuery): Promise<unknown> {
    const a = address.toLowerCase();
    return this.cached('token:detail', { address: a, ...params }, HYPEDEXER_TTL.elysiumUser, () =>
      this.userLookup(() => this.client.getToken(a, params))
    );
  }

  /** Largest holders of a token; same per-address budget, cached like the user lookups. */
  public getTokenHolders(address: string, params?: ElysiumNetworkQuery & { limit?: number }): Promise<unknown> {
    const a = address.toLowerCase();
    return this.sized('token:holders', { address: a, ...params }, HYPEDEXER_TTL.elysiumUser, (read) =>
      this.userLookup(() => this.client.getTokenHolders(a, { network: read?.network, limit: read?.limit }))
    );
  }

  public getUserActivity(address: string, params?: ElysiumUserActivityQuery): Promise<unknown> {
    const a = address.toLowerCase();
    return this.sized('user:activity', { address: a, ...params }, HYPEDEXER_TTL.elysiumUser, (read) =>
      this.userLookup(() => this.client.getUserActivity(a, { ...params, limit: read?.limit }))
    );
  }

  public getUserBridge(address: string, params?: ElysiumUserBridgeQuery): Promise<unknown> {
    const a = address.toLowerCase();
    return this.sized('user:bridge', { address: a, ...params }, HYPEDEXER_TTL.elysiumUser, (read) =>
      this.userLookup(() => this.client.getUserBridge(a, { ...params, limit: read?.limit }))
    );
  }
}
