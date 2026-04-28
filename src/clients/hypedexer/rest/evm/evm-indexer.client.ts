import { CircuitBreakerService } from '../../../../core/circuit.breaker.service';
import { RateLimiterService } from '../../../../core/hyperLiquid.ratelimiter.service';
import { logDeduplicator } from '../../../../utils/logDeduplicator';
import { HYPEDEXER_API_URL, hypedexerJsonHeaders } from '../shared/hypedexer-api.config';
import { HypeDexerBaseClient } from '../shared/hypedexer-base.client';

function buildQuery(record: Record<string, string | number | boolean | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(record)) {
    if (v === undefined || v === null || v === '') continue;
    sp.append(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export interface EvmBlocksQuery {
  limit?: number;
  start_time?: number;
  end_time?: number;
}

export interface EvmTransactionsQuery {
  limit?: number;
  block_number?: number;
  to_addr?: string;
  start_time?: number;
  end_time?: number;
}

export interface EvmBridgeEventsQuery {
  limit?: number;
  start_time?: number;
  end_time?: number;
}

export interface EvmLedgerTransfersQuery {
  limit?: number;
  start_time?: number;
  end_time?: number;
}

/**
 * HypeDexer REST — EVM analytics endpoints (GET-only, under /evm/*).
 */
export class HypeDexerEvmIndexerClient extends HypeDexerBaseClient {
  private static instance: HypeDexerEvmIndexerClient;
  private static readonly REQUEST_WEIGHT = 8;
  private static readonly MAX_WEIGHT_PER_MINUTE = 600;

  private circuitBreaker: CircuitBreakerService;
  private rateLimiter: RateLimiterService;

  private constructor() {
    super(HYPEDEXER_API_URL, hypedexerJsonHeaders);
    this.circuitBreaker = CircuitBreakerService.getInstance('hypedexer-evm');
    this.rateLimiter = RateLimiterService.getInstance('hypedexer-evm', {
      maxWeightPerMinute: HypeDexerEvmIndexerClient.MAX_WEIGHT_PER_MINUTE,
      requestWeight: HypeDexerEvmIndexerClient.REQUEST_WEIGHT,
    });
  }

  public static getInstance(): HypeDexerEvmIndexerClient {
    if (!HypeDexerEvmIndexerClient.instance) {
      HypeDexerEvmIndexerClient.instance = new HypeDexerEvmIndexerClient();
    }
    return HypeDexerEvmIndexerClient.instance;
  }

  public checkRateLimit(ip: string): boolean {
    return this.rateLimiter.checkRateLimit(ip);
  }

  public getEvmStats(): Promise<unknown> {
    return this.circuitBreaker.execute(async () => {
      logDeduplicator.info('HypeDexerEvmIndexerClient.getEvmStats');
      return this.getUnwrapped<unknown>('/evm/stats');
    });
  }

  public getEvmStatsDaily(params?: { days?: number }): Promise<unknown> {
    return this.circuitBreaker.execute(async () => {
      const path = `/evm/stats/daily${params ? buildQuery(params) : ''}`;
      logDeduplicator.info('HypeDexerEvmIndexerClient.getEvmStatsDaily', { path });
      return this.getUnwrapped<unknown>(path);
    });
  }

  public getEvmBlocks(params?: EvmBlocksQuery): Promise<unknown> {
    return this.circuitBreaker.execute(async () => {
      const path = `/evm/blocks${params ? buildQuery(params as Record<string, string | number | boolean | undefined | null>) : ''}`;
      logDeduplicator.info('HypeDexerEvmIndexerClient.getEvmBlocks', { path });
      return this.getUnwrapped<unknown>(path);
    });
  }

  public getEvmTransactions(params?: EvmTransactionsQuery): Promise<unknown> {
    return this.circuitBreaker.execute(async () => {
      const path = `/evm/transactions${params ? buildQuery(params as Record<string, string | number | boolean | undefined | null>) : ''}`;
      logDeduplicator.info('HypeDexerEvmIndexerClient.getEvmTransactions', { path });
      return this.getUnwrapped<unknown>(path);
    });
  }

  public getEvmBridgeEvents(params?: EvmBridgeEventsQuery): Promise<unknown> {
    return this.circuitBreaker.execute(async () => {
      const path = `/evm/bridge/events${params ? buildQuery(params as Record<string, string | number | boolean | undefined | null>) : ''}`;
      logDeduplicator.info('HypeDexerEvmIndexerClient.getEvmBridgeEvents', { path });
      return this.getUnwrapped<unknown>(path);
    });
  }

  public getEvmLedgerTransfers(params?: EvmLedgerTransfersQuery): Promise<unknown> {
    return this.circuitBreaker.execute(async () => {
      const path = `/evm/ledger/transfers${params ? buildQuery(params as Record<string, string | number | boolean | undefined | null>) : ''}`;
      logDeduplicator.info('HypeDexerEvmIndexerClient.getEvmLedgerTransfers', { path });
      return this.getUnwrapped<unknown>(path);
    });
  }
}
