import { BaseApiService } from '../../../core/base.api.service';
import { LeaderboardResponse } from '../../../types/leaderboard.types';
import { CircuitBreakerService } from '../../../core/circuit.breaker.service';
import { RateLimiterService } from '../../../core/hyperLiquid.ratelimiter.service';
import { logDeduplicator } from '../../../utils/logDeduplicator';

interface LeaderboardSnapshot {
  data: LeaderboardResponse;
  fetchedAt: number;
}

/**
 * Fetched on demand, never polled. The upstream payload is ~40 MB (~47k rows)
 * and only `/leaderboard` and the CSV export read it, yet it used to be
 * downloaded, parsed and written to Redis every minute — and parsed again from
 * Redis on every request. It now lives in memory while someone asks for it.
 */
export class HyperliquidLeaderboardClient extends BaseApiService {
  private static instance: HyperliquidLeaderboardClient;
  private static readonly API_URL = process.env.HYPERLIQUID_STATS_URL || 'https://stats-data.hyperliquid.xyz/Mainnet';
  private static readonly REQUEST_WEIGHT = 10;
  private static readonly MAX_WEIGHT_PER_MINUTE = 1200;

  /** Served as-is while younger than this (the former poll interval). */
  private static readonly FRESH_MS = 60_000;
  /**
   * Past FRESH_MS and up to this age the snapshot is still served while a
   * single refresh runs in the background; past it, callers wait for the
   * refresh and the snapshot is dropped (the former Redis TTL).
   */
  private static readonly MAX_STALE_MS = 5 * 60_000;

  /**
   * The file is ~40 MB (39,993,291 bytes on 2026-11-05, about the same since
   * September), over the 32 MB default ceiling, which refused it from
   * 2026-11-02: empty `/leaderboard`, no portfolio margin candidates. Room for
   * it to more than double.
   */
  protected override readonly maxResponseBytes: number = 96 * 1024 * 1024;

  private snapshot: LeaderboardSnapshot | null = null;
  private inflight: Promise<LeaderboardSnapshot | null> | null = null;
  private evictionTimer: NodeJS.Timeout | null = null;

  private circuitBreaker: CircuitBreakerService;
  private rateLimiter: RateLimiterService;

  private constructor() {
    super(HyperliquidLeaderboardClient.API_URL);
    this.circuitBreaker = CircuitBreakerService.getInstance('leaderboard');
    this.rateLimiter = RateLimiterService.getInstance('leaderboard', {
      maxWeightPerMinute: HyperliquidLeaderboardClient.MAX_WEIGHT_PER_MINUTE,
      requestWeight: HyperliquidLeaderboardClient.REQUEST_WEIGHT,
    });
  }

  public static getInstance(): HyperliquidLeaderboardClient {
    if (!HyperliquidLeaderboardClient.instance) {
      HyperliquidLeaderboardClient.instance = new HyperliquidLeaderboardClient();
    }
    return HyperliquidLeaderboardClient.instance;
  }

  public async getLeaderboardData(): Promise<LeaderboardResponse | null> {
    const snapshot = this.snapshot;
    const age = snapshot ? Date.now() - snapshot.fetchedAt : Infinity;

    if (snapshot && age < HyperliquidLeaderboardClient.FRESH_MS) {
      return snapshot.data;
    }
    if (snapshot && age < HyperliquidLeaderboardClient.MAX_STALE_MS) {
      void this.refresh();
      return snapshot.data;
    }

    const fresh = await this.refresh();
    return fresh ? fresh.data : null;
  }

  /** Fetch time of the snapshot currently served, 0 before the first fetch. */
  public getLastUpdate(): number {
    return this.snapshot?.fetchedAt ?? 0;
  }

  /** One upstream download at a time, whatever the number of callers. */
  private refresh(): Promise<LeaderboardSnapshot | null> {
    if (!this.inflight) {
      this.inflight = this.fetchSnapshot().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async fetchSnapshot(): Promise<LeaderboardSnapshot | null> {
    try {
      const data = await this.circuitBreaker.execute(() =>
        this.get<LeaderboardResponse>('/leaderboard')
      );

      const snapshot: LeaderboardSnapshot = { data, fetchedAt: Date.now() };
      this.snapshot = snapshot;
      this.scheduleEviction(snapshot);

      logDeduplicator.info('Leaderboard data fetched', {
        entries: data?.leaderboardRows?.length,
      });
      return snapshot;
    } catch (error) {
      logDeduplicator.error('Failed to update leaderboard data:', { error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }

  /** A snapshot past MAX_STALE_MS is never served again: free the parsed payload instead of holding it. */
  private scheduleEviction(snapshot: LeaderboardSnapshot): void {
    if (this.evictionTimer) clearTimeout(this.evictionTimer);
    this.evictionTimer = setTimeout(() => {
      this.evictionTimer = null;
      if (this.snapshot === snapshot) this.snapshot = null;
    }, HyperliquidLeaderboardClient.MAX_STALE_MS);
    this.evictionTimer.unref();
  }

  public static getRequestWeight(): number {
    return HyperliquidLeaderboardClient.REQUEST_WEIGHT;
  }

  public checkRateLimit(ip: string): boolean {
    return this.rateLimiter.checkRateLimit(ip);
  }
}
