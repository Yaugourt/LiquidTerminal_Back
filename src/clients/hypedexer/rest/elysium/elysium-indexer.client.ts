import { HttpApiError } from '../../../../core/base.api.service';
import { CircuitBreakerService } from '../../../../core/circuit.breaker.service';
import { RateLimiterService } from '../../../../core/hyperLiquid.ratelimiter.service';
import { HYPEDEXER_API_URL, hypedexerJsonHeaders } from '../shared/hypedexer-api.config';
import { HypeDexerBaseClient } from '../shared/hypedexer-base.client';
import { unwrapHypeDexerApiPayload } from '../../../../utils/hypedexer-api-response.util';

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

/** What ingestLookup resolves to on the provider's 404. */
const NOT_FOUND = Symbol('not found');

/** Upstream path prefix for the Elysium testnet API (the ingestion only reads testnet). */
const ELYSIUM_PREFIX = '/elysium/testnet';

export type ElysiumNetwork = 'testnet' | 'mainnet';

/** Pass-through calls carry the chain to read; testnet when omitted. */
export interface ElysiumNetworkQuery {
  network?: ElysiumNetwork;
}

/** Paging + time-window params shared by the ingestion list calls. */
export interface ElysiumIngestPageQuery {
  limit: number;
  offset: number;
  /** ISO-8601 UTC without zone suffix, e.g. 2026-09-28T08:00:00 */
  start_time?: string;
  end_time?: string;
  [key: string]: QueryValue;
}

/**
 * A UTC day as the provider counts it, in the terms of elysium_tx: `txs` are its user and
 * bridge transactions (what we store as non-spam; system transactions are never stored), `spam`
 * and `bridge` the two parts of them the provider also gives. Equal to our own counts, to the
 * unit, on the 9 closed days compared on 2026-11-11.
 */
export interface ElysiumProviderDay {
  day: string;
  txs: number;
  spam: number;
  bridge: number;
}

/** One page of an upstream list, as the ingestion reads it. */
export interface ElysiumIngestPage {
  rows: unknown[];
  /** The provider's `has_more`; null when the answer has no such flag. */
  hasMore: boolean | null;
}

/** Upstream list paths the ingestion service pages through. */
export type ElysiumIngestPath = '/transactions' | '/bridge/transfers' | '/tokens' | '/logs';

export interface ElysiumStatsDailyQuery extends ElysiumNetworkQuery {
  days?: number;
}

export interface ElysiumBlocksQuery extends ElysiumNetworkQuery {
  limit?: number;
}

export interface ElysiumTransactionsQuery extends ElysiumNetworkQuery {
  limit?: number;
  include_spam?: boolean;
  include_system?: boolean;
}

export interface ElysiumBatchesQuery extends ElysiumNetworkQuery {
  limit?: number;
}

export interface ElysiumBridgeTransfersQuery extends ElysiumNetworkQuery {
  limit?: number;
  direction?: 'deposit' | 'withdrawal';
  status?: 'initiated' | 'ticket_created' | 'redeem_failed' | 'expired' | 'completed' | 'executed';
  route?: 'native' | 'canonical' | 'mirror';
  asset?: 'native' | 'token' | 'message';
}

export interface ElysiumBridgeRetryablesQuery extends ElysiumNetworkQuery {
  limit?: number;
  status?: 'pending' | 'failed' | 'expired' | 'redeemed';
}

export interface ElysiumBridgeReservesQuery extends ElysiumNetworkQuery {
  route: 'native' | 'canonical' | 'mirror';
  only_unbacked?: boolean;
}

export interface ElysiumBridgeTokensQuery extends ElysiumNetworkQuery {
  limit?: number;
  route?: 'canonical' | 'mirror';
}

export interface ElysiumTokensQuery extends ElysiumNetworkQuery {
  limit?: number;
  standard?: 'erc20' | 'erc721' | 'erc1155';
  origin?: 'native' | 'canonical';
}

export interface ElysiumUserActivityQuery extends ElysiumNetworkQuery {
  limit?: number;
  offset?: number;
}

export interface ElysiumUserBridgeQuery extends ElysiumNetworkQuery {
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

  /** `network` picks the upstream prefix and is never forwarded as a query param. */
  private fetchElysium(path: string, params?: object): Promise<unknown> {
    return this.circuitBreaker.execute(async () => {
      const { network, ...rest } = (params ?? {}) as Record<string, QueryValue>;
      const prefix = network === 'mainnet' ? '/elysium/mainnet' : ELYSIUM_PREFIX;
      return this.getUnwrapped<unknown>(`${prefix}${path}${buildQuery(rest)}`);
    });
  }

  public getStats(params?: ElysiumNetworkQuery): Promise<unknown> {
    return this.fetchElysium('/stats', params);
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

  public getUserBalances(address: string, params?: ElysiumNetworkQuery): Promise<unknown> {
    return this.fetchElysium(`/user/${address}/balances`, params);
  }

  /** One token: metadata, supply, holder and transfer counts (user-facing, either network). */
  public getToken(address: string, params?: ElysiumNetworkQuery): Promise<unknown> {
    return this.fetchElysium(`/tokens/${address}`, params);
  }

  /** Largest holders of a token with their share of supply (user-facing, either network). */
  public getTokenHolders(address: string, params?: ElysiumNetworkQuery & { limit?: number }): Promise<unknown> {
    return this.fetchElysium(`/tokens/${address}/holders`, params);
  }

  public getUserActivity(address: string, params?: ElysiumUserActivityQuery): Promise<unknown> {
    return this.fetchElysium(`/user/${address}/activity`, params);
  }

  public getUserBridge(address: string, params?: ElysiumUserBridgeQuery): Promise<unknown> {
    return this.fetchElysium(`/user/${address}/bridge`, params);
  }

  /** Time of the last block the provider has indexed (from /stats), for the ingestion service. */
  public async fetchIngestHead(): Promise<Date | null> {
    const data = await this.ingestCircuitBreaker.execute(() => this.getUnwrapped<unknown>(`${ELYSIUM_PREFIX}/stats`));
    const raw = data && typeof data === 'object' ? (data as Record<string, unknown>).last_block_time : null;
    if (typeof raw !== 'string' || raw.trim() === '') return null;
    const s = raw.trim();
    // Upstream times are UTC without a zone suffix.
    const d = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(s) ? s : `${s}Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  /**
   * A lookup of one thing by its key (a token, a transaction, a transfer), for the ingestion
   * service: the payload, or NOT_FOUND on the provider's 404. That 404 is an answer about the
   * thing, not a failure of the provider: it is read inside the breaker, so that asking about
   * tokens or transactions the provider does not have never opens it for every stream
   * (5 failures in a row open it for 30 s, and any thrown error counts as one).
   */
  private ingestLookup(endpoint: string): Promise<unknown> {
    return this.ingestCircuitBreaker.execute(async () => {
      try {
        return unwrapHypeDexerApiPayload(await this.get<unknown>(endpoint));
      } catch (error) {
        if (error instanceof HttpApiError && error.statusCode === 404) return NOT_FOUND;
        throw error;
      }
    });
  }

  /** Single token detail (holders, supply) for the ingestion service; null when the provider does not know the token. */
  public async fetchIngestToken(address: string): Promise<Record<string, unknown> | null> {
    if (!/^0x[0-9a-f]{40}$/.test(address)) throw new Error('Elysium ingest: invalid token address');
    const data = await this.ingestLookup(`${ELYSIUM_PREFIX}/tokens/${address}`);
    if (data === NOT_FOUND) return null;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('Elysium ingest: expected a token object');
    }
    return data as Record<string, unknown>;
  }

  /**
   * Largest holders of a token, by balance (share is 0..1 of supply), for the ingestion service;
   * null when the provider does not know the token.
   */
  public async fetchIngestTokenHolders(address: string, limit: number): Promise<unknown[] | null> {
    if (!/^0x[0-9a-f]{40}$/.test(address)) throw new Error('Elysium ingest: invalid token address');
    const data = await this.ingestLookup(`${ELYSIUM_PREFIX}/tokens/${address}/holders${buildQuery({ limit, offset: 0 })}`);
    if (data === NOT_FOUND) return null;
    if (!Array.isArray(data)) throw new Error('Elysium ingest: expected a holder array');
    return data;
  }

  /**
   * The provider's own count of each of the last `days` UTC days (its /stats/daily), for the
   * ingestion service: what a closed day of elysium_tx is compared with.
   */
  public async fetchIngestDaily(days: number): Promise<ElysiumProviderDay[]> {
    const data = await this.ingestCircuitBreaker.execute(() =>
      this.getUnwrapped<unknown>(`${ELYSIUM_PREFIX}/stats/daily${buildQuery({ days })}`)
    );
    if (!Array.isArray(data)) throw new Error('Elysium ingest: expected a daily array');
    const out: ElysiumProviderDay[] = [];
    for (const raw of data) {
      if (!raw || typeof raw !== 'object') continue;
      const r = raw as Record<string, unknown>;
      const count = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);
      const [user, spam, bridge] = [count(r.user_transactions), count(r.spam_transactions), count(r.bridge_transactions)];
      // A day without one of its three counts cannot be compared: left out, never guessed.
      if (typeof r.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.day) || user === null || spam === null || bridge === null) continue;
      out.push({ day: r.day, txs: user + bridge, spam, bridge });
    }
    return out;
  }

  /**
   * Whether the provider still lists a transaction (its /transactions/{hash}), for the
   * ingestion service: false only on its 404. The 404 is an answer, not a failure: it is read
   * inside the breaker so that asking about transactions that are gone never opens it.
   */
  public async fetchIngestTxListed(txHash: string): Promise<boolean> {
    if (!/^0x[0-9a-f]{64}$/.test(txHash)) throw new Error('Elysium ingest: invalid tx hash');
    return (await this.ingestLookup(`${ELYSIUM_PREFIX}/transactions/${txHash}`)) !== NOT_FOUND;
  }

  /**
   * The bridge transfers a transaction belongs to (HyperEVM or Elysium hash), for the ingestion
   * service: how it reads again one transfer whose status it is waiting on.
   */
  public async fetchIngestBridgeTransfers(txHash: string): Promise<unknown[]> {
    if (!/^0x[0-9a-f]{64}$/.test(txHash)) throw new Error('Elysium ingest: invalid tx hash');
    const data = await this.ingestLookup(`${ELYSIUM_PREFIX}/bridge/transfers/${txHash}`);
    // A hash the provider has no transfer for: nothing to store.
    if (data === NOT_FOUND) return [];
    if (Array.isArray(data)) return data;
    return data && typeof data === 'object' ? [data] : [];
  }

  /**
   * One page of an upstream list for the ingestion service: its rows, and what the provider says
   * of the rest (`has_more`, null when the answer does not carry it). The flag is read before the
   * envelope is peeled; it used to be thrown away with it.
   */
  public async fetchIngestPage(path: ElysiumIngestPath, params: ElysiumIngestPageQuery): Promise<ElysiumIngestPage> {
    const body = await this.ingestCircuitBreaker.execute(() =>
      this.get<unknown>(`${ELYSIUM_PREFIX}${path}${buildQuery(params)}`)
    );
    const flag = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>).has_more : null;
    const data = unwrapHypeDexerApiPayload(body);
    if (!Array.isArray(data)) {
      throw new Error('Elysium ingest: expected a row array');
    }
    return { rows: data, hasMore: typeof flag === 'boolean' ? flag : null };
  }
}
