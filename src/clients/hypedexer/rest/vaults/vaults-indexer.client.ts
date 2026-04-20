import { CircuitBreakerService } from '../../../../core/circuit.breaker.service';
import { RateLimiterService } from '../../../../core/hyperLiquid.ratelimiter.service';
import { logDeduplicator } from '../../../../utils/logDeduplicator';
import { HYPEDEXER_API_URL, hypedexerJsonHeaders } from '../shared/hypedexer-api.config';
import { HypeDexerBaseClient } from '../shared/hypedexer-base.client';

function q(record: object): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(record)) {
    if (v === undefined || v === null || v === '') continue;
    sp.append(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export interface VaultDetailsQuery {
  vaultAddress: string;
  startTime?: string;
  endTime?: string;
  limit?: number;
}

export interface UserVaultEquitiesQuery {
  user: string;
  startTime?: string;
  endTime?: string;
  limit?: number;
}

export interface VaultSnapshotsQuery {
  vaultAddress: string;
  startTime?: string;
  endTime?: string;
  limit?: number;
}

export interface VaultLedgerQuery {
  vaultAddress: string;
  user?: string;
  startTime?: string;
  endTime?: string;
  limit?: number;
}

/**
 * HypeDexer REST — Vaults indexer (distinct from Hyperliquid /market/vaults when applicable).
 */
export class HypeDexerVaultsIndexerClient extends HypeDexerBaseClient {
  private static instance: HypeDexerVaultsIndexerClient;
  private static readonly REQUEST_WEIGHT = 10;
  private static readonly MAX_WEIGHT_PER_MINUTE = 1000;

  private circuitBreaker: CircuitBreakerService;
  private rateLimiter: RateLimiterService;

  private constructor() {
    super(HYPEDEXER_API_URL, hypedexerJsonHeaders);
    this.circuitBreaker = CircuitBreakerService.getInstance('hypedexer-vaults-indexer');
    this.rateLimiter = RateLimiterService.getInstance('hypedexer-vaults-indexer', {
      maxWeightPerMinute: HypeDexerVaultsIndexerClient.MAX_WEIGHT_PER_MINUTE,
      requestWeight: HypeDexerVaultsIndexerClient.REQUEST_WEIGHT,
    });
  }

  public static getInstance(): HypeDexerVaultsIndexerClient {
    if (!HypeDexerVaultsIndexerClient.instance) {
      HypeDexerVaultsIndexerClient.instance = new HypeDexerVaultsIndexerClient();
    }
    return HypeDexerVaultsIndexerClient.instance;
  }

  public checkRateLimit(ip: string): boolean {
    return this.rateLimiter.checkRateLimit(ip);
  }

  private getPath(path: string): Promise<unknown> {
    return this.circuitBreaker.execute(async () => {
      logDeduplicator.info('HypeDexerVaultsIndexerClient', { path });
      return this.getUnwrapped<unknown>(path);
    });
  }

  public getVaultDetails(params: VaultDetailsQuery): Promise<unknown> {
    return this.getPath(`/vaults/vaultDetails${q(params)}`);
  }

  public getVaultSummaries(params: { includeClosed?: boolean; limit?: number } = {}): Promise<unknown> {
    return this.getPath(`/vaults/vaultSummaries${q(params)}`);
  }

  public getUserVaultEquities(params: UserVaultEquitiesQuery): Promise<unknown> {
    return this.getPath(`/vaults/userVaultEquities${q(params)}`);
  }

  public getDailySnapshots(params: VaultSnapshotsQuery): Promise<unknown> {
    return this.getPath(`/vaults/dailySnapshots${q(params)}`);
  }

  public getEquitySnapshots(params: VaultSnapshotsQuery): Promise<unknown> {
    return this.getPath(`/vaults/equitySnapshots${q(params)}`);
  }

  public getVaultLedger(params: VaultLedgerQuery): Promise<unknown> {
    return this.getPath(`/vaults/vaultLedger${q(params)}`);
  }
}
