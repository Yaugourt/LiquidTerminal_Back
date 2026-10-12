import { CircuitBreakerService } from '../../../../core/circuit.breaker.service';
import { RateLimiterService } from '../../../../core/hyperLiquid.ratelimiter.service';
import { HYPEDEXER_API_URL, hypedexerJsonHeaders } from '../shared/hypedexer-api.config';
import { HypeDexerBaseClient } from '../shared/hypedexer-base.client';

type QueryValue = string | number | boolean | undefined | null;

function buildQuery(record: Record<string, QueryValue>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(record)) {
    if (v === undefined || v === null || v === '') continue;
    sp.append(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

/** Upstream path prefix for the Elysium testnet API. */
const ELYSIUM_PREFIX = '/elysium/testnet';

/** Paging + time-window params shared by the ingestion list calls. */
export interface ElysiumIngestPageQuery {
  limit: number;
  offset: number;
  /** ISO-8601 UTC without zone suffix, e.g. 2026-09-28T08:00:00 */
  start_time?: string;
  end_time?: string;
  [key: string]: QueryValue;
}

/** Upstream list paths the ingestion service pages through. */
export type ElysiumIngestPath = '/transactions' | '/bridge/transfers' | '/tokens' | '/logs';

export interface ElysiumStatsDailyQuery {
  days?: number;
}

export interface ElysiumBlocksQuery {
  limit?: number;
}

export interface ElysiumTransactionsQuery {
  limit?: number;
  include_spam?: boolean;
  include_system?: boolean;
}

export interface ElysiumBatchesQuery {
  limit?: number;
}

export interface ElysiumBridgeTransfersQuery {
  limit?: number;
  direction?: 'deposit' | 'withdrawal';
  status?: 'initiated' | 'ticket_created' | 'redeem_failed' | 'expired' | 'completed' | 'executed';
  route?: 'native' | 'canonical' | 'mirror';
  asset?: 'native' | 'token' | 'message';
}

export interface ElysiumBridgeRetryablesQuery {
  limit?: number;
  status?: 'pending' | 'failed' | 'expired' | 'redeemed';
}

export interface ElysiumBridgeReservesQuery {
  route: 'native' | 'canonical' | 'mirror';
  only_unbacked?: boolean;
}

export interface ElysiumBridgeTokensQuery {
  limit?: number;
  route?: 'canonical' | 'mirror';
}

export interface ElysiumTokensQuery {
  limit?: number;
  standard?: 'erc20' | 'erc721' | 'erc1155';
  origin?: 'native' | 'canonical';
}

export interface ElysiumUserActivityQuery {
  limit?: number;
  offset?: number;
}

export interface ElysiumUserBridgeQuery {
  limit?: number;
  direction?: 'deposit' | 'withdrawal';
}

/**
 * HypeDexer REST — Elysium testnet endpoints (GET-only, under /elysium/testnet/*).
 * No per-request logging here: paths carry query params and would create
 * high-cardinality log dedup keys.
 */
export class HypeDexerElysiumIndexerClient extends HypeDexerBaseClient {
  private static instance: HypeDexerElysiumIndexerClient;
  private static readonly REQUEST_WEIGHT = 8;
  private static readonly MAX_WEIGHT_PER_MINUTE = 600;

  private circuitBreaker: CircuitBreakerService;
  /**
   * Separate breaker for background ingestion, so a burst of ingestion
   * failures never opens the circuit for user-facing pass-through calls.
   */
  private ingestCircuitBreaker: CircuitBreakerService;
  private rateLimiter: RateLimiterService;

  private constructor() {
    super(HYPEDEXER_API_URL, hypedexerJsonHeaders);
    this.circuitBreaker = CircuitBreakerService.getInstance('hypedexer-elysium');
    this.ingestCircuitBreaker = CircuitBreakerService.getInstance('hypedexer-elysium-ingest');
    this.rateLimiter = RateLimiterService.getInstance('hypedexer-elysium', {
      maxWeightPerMinute: HypeDexerElysiumIndexerClient.MAX_WEIGHT_PER_MINUTE,
      requestWeight: HypeDexerElysiumIndexerClient.REQUEST_WEIGHT,
    });
  }

  public static getInstance(): HypeDexerElysiumIndexerClient {
    if (!HypeDexerElysiumIndexerClient.instance) {
      HypeDexerElysiumIndexerClient.instance = new HypeDexerElysiumIndexerClient();
    }
    return HypeDexerElysiumIndexerClient.instance;
  }

  public checkRateLimit(ip: string): boolean {
    return this.rateLimiter.checkRateLimit(ip);
  }

  private fetchElysium(path: string, params?: object): Promise<unknown> {
    return this.circuitBreaker.execute(async () => {
      const qs = params ? buildQuery(params as Record<string, QueryValue>) : '';
      return this.getUnwrapped<unknown>(`${ELYSIUM_PREFIX}${path}${qs}`);
    });
  }

  public getStats(): Promise<unknown> {
    return this.fetchElysium('/stats');
  }

  public getStatsDaily(params?: ElysiumStatsDailyQuery): Promise<unknown> {
    return this.fetchElysium('/stats/daily', params);
  }

  public getBlocks(params?: ElysiumBlocksQuery): Promise<unknown> {
    return this.fetchElysium('/blocks', params);
  }

  public getTransactions(params?: ElysiumTransactionsQuery): Promise<unknown> {
    return this.fetchElysium('/transactions', params);
  }

  public getBatches(params?: ElysiumBatchesQuery): Promise<unknown> {
    return this.fetchElysium('/batches', params);
  }

  public getBridgeTransfers(params?: ElysiumBridgeTransfersQuery): Promise<unknown> {
    return this.fetchElysium('/bridge/transfers', params);
  }

  public getBridgeRetryables(params?: ElysiumBridgeRetryablesQuery): Promise<unknown> {
    return this.fetchElysium('/bridge/retryables', params);
  }

  public getBridgeReserves(params: ElysiumBridgeReservesQuery): Promise<unknown> {
    return this.fetchElysium('/bridge/reserves', params);
  }

  public getBridgeTokens(params?: ElysiumBridgeTokensQuery): Promise<unknown> {
    return this.fetchElysium('/bridge/tokens', params);
  }

  public getTokens(params?: ElysiumTokensQuery): Promise<unknown> {
    return this.fetchElysium('/tokens', params);
  }

  public getUserBalances(address: string): Promise<unknown> {
    return this.fetchElysium(`/user/${address}/balances`);
  }

  public getUserActivity(address: string, params?: ElysiumUserActivityQuery): Promise<unknown> {
    return this.fetchElysium(`/user/${address}/activity`, params);
  }

  public getUserBridge(address: string, params?: ElysiumUserBridgeQuery): Promise<unknown> {
    return this.fetchElysium(`/user/${address}/bridge`, params);
  }

  /** Single token detail (holders, supply) for the ingestion service. */
  public async fetchIngestToken(address: string): Promise<Record<string, unknown>> {
    if (!/^0x[0-9a-f]{40}$/.test(address)) throw new Error('Elysium ingest: invalid token address');
    const data = await this.ingestCircuitBreaker.execute(() =>
      this.getUnwrapped<unknown>(`${ELYSIUM_PREFIX}/tokens/${address}`)
    );
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('Elysium ingest: expected a token object');
    }
    return data as Record<string, unknown>;
  }

  /** Largest holders of a token, by balance (share is 0..1 of supply), for the ingestion service. */
  public async fetchIngestTokenHolders(address: string, limit: number): Promise<unknown[]> {
    if (!/^0x[0-9a-f]{40}$/.test(address)) throw new Error('Elysium ingest: invalid token address');
    const data = await this.ingestCircuitBreaker.execute(() =>
      this.getUnwrapped<unknown>(`${ELYSIUM_PREFIX}/tokens/${address}/holders${buildQuery({ limit, offset: 0 })}`)
    );
    if (!Array.isArray(data)) throw new Error('Elysium ingest: expected a holder array');
    return data;
  }

  /**
   * One page of an upstream list for the ingestion service. Returns the bare
   * row array (the envelope is peeled); callers page until a short page.
   */
  public async fetchIngestPage(path: ElysiumIngestPath, params: ElysiumIngestPageQuery): Promise<unknown[]> {
    const data = await this.ingestCircuitBreaker.execute(() =>
      this.getUnwrapped<unknown>(`${ELYSIUM_PREFIX}${path}${buildQuery(params)}`)
    );
    if (!Array.isArray(data)) {
      throw new Error('Elysium ingest: expected a row array');
    }
    return data;
  }
}
