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

  public getStats(params?: ElysiumNetworkQuery): Promise<unknown> {
    return this.cached('stats', params, HYPEDEXER_TTL.elysiumStats, () => this.client.getStats(params));
  }

  public getStatsDaily(params?: ElysiumStatsDailyQuery): Promise<unknown> {
    return this.cached('stats:daily', params, HYPEDEXER_TTL.elysiumStatsDaily, () =>
      this.client.getStatsDaily(params)
    );
  }

  public getBlocks(params?: ElysiumBlocksQuery): Promise<unknown> {
    return this.cached('blocks', params, HYPEDEXER_TTL.elysiumBlocks, () => this.client.getBlocks(params));
  }

  public getTransactions(params?: ElysiumTransactionsQuery): Promise<unknown> {
    return this.cached('transactions', params, HYPEDEXER_TTL.elysiumTransactions, () =>
      this.client.getTransactions(params)
    );
  }

  public getBatches(params?: ElysiumBatchesQuery): Promise<unknown> {
    return this.cached('batches', params, HYPEDEXER_TTL.elysiumBatches, () => this.client.getBatches(params));
  }

  public getBridgeTransfers(params?: ElysiumBridgeTransfersQuery): Promise<unknown> {
    return this.cached('bridge:transfers', params, HYPEDEXER_TTL.elysiumBridgeTransfers, () =>
      this.client.getBridgeTransfers(params)
    );
  }

  public getBridgeRetryables(params?: ElysiumBridgeRetryablesQuery): Promise<unknown> {
    return this.cached('bridge:retryables', params, HYPEDEXER_TTL.elysiumBridgeRetryables, () =>
      this.client.getBridgeRetryables(params)
    );
  }

  public getBridgeReserves(params: ElysiumBridgeReservesQuery): Promise<unknown> {
    return this.cached('bridge:reserves', params, HYPEDEXER_TTL.elysiumBridgeReserves, () =>
      this.client.getBridgeReserves(params)
    );
  }

  public getBridgeTokens(params?: ElysiumBridgeTokensQuery): Promise<unknown> {
    return this.cached('bridge:tokens', params, HYPEDEXER_TTL.elysiumBridgeTokens, () =>
      this.client.getBridgeTokens(params)
    );
  }

  public getTokens(params?: ElysiumTokensQuery): Promise<unknown> {
    return this.cached('tokens', params, HYPEDEXER_TTL.elysiumTokens, () => this.client.getTokens(params));
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
    return this.cached('token:holders', { address: a, ...params }, HYPEDEXER_TTL.elysiumUser, () =>
      this.userLookup(() => this.client.getTokenHolders(a, params))
    );
  }

  public getUserActivity(address: string, params?: ElysiumUserActivityQuery): Promise<unknown> {
    const a = address.toLowerCase();
    return this.cached('user:activity', { address: a, ...params }, HYPEDEXER_TTL.elysiumUser, () =>
      this.userLookup(() => this.client.getUserActivity(a, params))
    );
  }

  public getUserBridge(address: string, params?: ElysiumUserBridgeQuery): Promise<unknown> {
    const a = address.toLowerCase();
    return this.cached('user:bridge', { address: a, ...params }, HYPEDEXER_TTL.elysiumUser, () =>
      this.userLookup(() => this.client.getUserBridge(a, params))
    );
  }
}
