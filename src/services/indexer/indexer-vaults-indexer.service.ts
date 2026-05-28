import { HypeDexerVaultsIndexerClient, UserVaultEquitiesQuery } from '../../clients/hypedexer/rest/vaults/vaults-indexer.client';
import { cacheService } from '../../core/cache.service';
import {
  HYPEDEXER_USER_CACHE_KEY,
  HYPEDEXER_TTL,
  HYPEDEXER_CACHE_KEYS,
} from '../../constants/hypedexer.cache';
import { logDeduplicator } from '../../utils/logDeduplicator';

/** Mirrors front IndexerVaultSummaryItem. Mirrored locally to keep this service self-contained. */
interface VaultSummaryItem {
  vaultAddress: string;
  name: string;
  leader: string;
  leaderCommission: number;
  isClosed: boolean;
  followerCount: number;
  snapshotTime: number;
  createTime: number;
}

/** Mirrors front VaultDailySnapshot — only fields we consume here. */
interface DailySnapshot {
  time: number;
  accountValue: number;
  followerCount: number;
}

/** Mirrors front VaultLedgerEntry — only fields we consume here. */
interface LedgerEntry {
  time: number;
  userFrom: string;
  userTo: string;
  amount: number;
}

export type LeaderboardWindow = '24h' | '7d';

export interface FollowersGainedItem {
  vaultAddress: string;
  name: string;
  leader: string;
  tvl: number;
  delta: number;
  total: number;
}

export interface OutflowItem {
  vaultAddress: string;
  name: string;
  leader: string;
  tvl: number;
  amountUsd: number;
  percentOfTvl: number;
}

export interface LeaderboardsPayload {
  followersGained: FollowersGainedItem[];
  outflows: OutflowItem[];
  meta: {
    window: LeaderboardWindow;
    computedAt: number;
    sampleSize: number;
  };
}

const WINDOW_MS: Record<LeaderboardWindow, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
};

const CANDIDATE_POOL_SIZE = 50;
const FAN_OUT_CONCURRENCY = 6;

async function batchedMap<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

export class IndexerVaultsIndexerService {
  private static instance: IndexerVaultsIndexerService;
  private readonly client = HypeDexerVaultsIndexerClient.getInstance();

  public static getInstance(): IndexerVaultsIndexerService {
    if (!IndexerVaultsIndexerService.instance) {
      IndexerVaultsIndexerService.instance = new IndexerVaultsIndexerService();
    }
    return IndexerVaultsIndexerService.instance;
  }

  public getVaultDetails(p: Parameters<HypeDexerVaultsIndexerClient['getVaultDetails']>[0]): Promise<unknown> {
    return this.client.getVaultDetails(p);
  }

  public getVaultSummaries(p: Parameters<HypeDexerVaultsIndexerClient['getVaultSummaries']>[0]): Promise<unknown> {
    return this.client.getVaultSummaries(p);
  }

  public getUserVaultEquities(p: UserVaultEquitiesQuery): Promise<unknown> {
    if (p.startTime || p.endTime) {
      return this.client.getUserVaultEquities(p);
    }
    return cacheService.getOrSet(
      HYPEDEXER_USER_CACHE_KEY.vaultEquities(p.user),
      () => this.client.getUserVaultEquities(p),
      HYPEDEXER_TTL.userAddress
    );
  }

  public getDailySnapshots(p: Parameters<HypeDexerVaultsIndexerClient['getDailySnapshots']>[0]): Promise<unknown> {
    return this.client.getDailySnapshots(p);
  }

  public getEquitySnapshots(p: Parameters<HypeDexerVaultsIndexerClient['getEquitySnapshots']>[0]): Promise<unknown> {
    return this.client.getEquitySnapshots(p);
  }

  public getVaultLedger(p: Parameters<HypeDexerVaultsIndexerClient['getVaultLedger']>[0]): Promise<unknown> {
    return this.client.getVaultLedger(p);
  }

  /**
   * Followers-gained leaderboard — reads from the shared precomputed payload.
   */
  public async getFollowersGained(
    window: LeaderboardWindow,
    limit: number
  ): Promise<{ data: FollowersGainedItem[]; meta: LeaderboardsPayload['meta'] }> {
    const payload = await this.getLeaderboardsPayload(window);
    return { data: payload.followersGained.slice(0, limit), meta: payload.meta };
  }

  /**
   * Largest-outflows leaderboard — reads from the shared precomputed payload.
   * Only returns vaults with a strictly negative net flow over the window;
   * does not pad with inflows.
   */
  public async getOutflows(
    window: LeaderboardWindow,
    limit: number
  ): Promise<{ data: OutflowItem[]; meta: LeaderboardsPayload['meta'] }> {
    const payload = await this.getLeaderboardsPayload(window);
    return { data: payload.outflows.slice(0, limit), meta: payload.meta };
  }

  /**
   * Precomputes both leaderboards in a single fan-out and caches the whole
   * payload under one Redis key. Candidate pool = top {CANDIDATE_POOL_SIZE}
   * open vaults by current follower count — a deliberate bias, but the only
   * way to keep fan-out bounded without HypeDexer aggregate endpoints.
   */
  private getLeaderboardsPayload(window: LeaderboardWindow): Promise<LeaderboardsPayload> {
    return cacheService.getOrSet(
      HYPEDEXER_CACHE_KEYS.vaultLeaderboards(window),
      () => this.computeLeaderboards(window),
      HYPEDEXER_TTL.vaultLeaderboards
    );
  }

  private async computeLeaderboards(window: LeaderboardWindow): Promise<LeaderboardsPayload> {
    const now = Date.now();
    const cutoff = now - WINDOW_MS[window];

    const summariesRaw = (await this.client.getVaultSummaries({ includeClosed: false })) as
      | VaultSummaryItem[]
      | null;
    const summaries = Array.isArray(summariesRaw) ? summariesRaw : [];

    const candidates = summaries
      .filter((s) => !s.isClosed && typeof s.followerCount === 'number')
      .sort((a, b) => b.followerCount - a.followerCount)
      .slice(0, CANDIDATE_POOL_SIZE);

    const snapshotLimit = window === '24h' ? 3 : 10;
    const ledgerLimit = window === '24h' ? 500 : 2000;

    const enriched = await batchedMap(candidates, FAN_OUT_CONCURRENCY, async (s) => {
      const [snapsRaw, ledgerRaw] = await Promise.all([
        this.client
          .getDailySnapshots({ vaultAddress: s.vaultAddress, limit: snapshotLimit })
          .catch((e) => {
            logDeduplicator.warn('leaderboards: dailySnapshots failed', {
              vaultAddress: s.vaultAddress,
              error: e instanceof Error ? e.message : String(e),
            });
            return null;
          }),
        this.client
          .getVaultLedger({ vaultAddress: s.vaultAddress, limit: ledgerLimit })
          .catch((e) => {
            logDeduplicator.warn('leaderboards: vaultLedger failed', {
              vaultAddress: s.vaultAddress,
              error: e instanceof Error ? e.message : String(e),
            });
            return null;
          }),
      ]);

      const snaps = (Array.isArray(snapsRaw) ? snapsRaw : []) as DailySnapshot[];
      const ledger = (Array.isArray(ledgerRaw) ? ledgerRaw : []) as LedgerEntry[];

      const sortedSnaps = snaps.slice().sort((a, b) => b.time - a.time);
      const latest = sortedSnaps[0];
      const baseline = sortedSnaps.find((sn) => sn.time <= cutoff) ?? null;

      const tvl = latest?.accountValue ?? 0;
      const currentFollowers = latest?.followerCount ?? s.followerCount;
      const followersDelta = baseline ? currentFollowers - baseline.followerCount : null;

      const vaultLower = s.vaultAddress.toLowerCase();
      let netFlow = 0;
      for (const e of ledger) {
        if (e.time < cutoff) continue;
        if (e.userTo?.toLowerCase() === vaultLower) {
          netFlow += e.amount;
        } else if (e.userFrom?.toLowerCase() === vaultLower) {
          netFlow -= e.amount;
        }
      }

      return {
        summary: s,
        tvl,
        currentFollowers,
        followersDelta,
        netFlow,
      };
    });

    const followersGained: FollowersGainedItem[] = enriched
      .filter((e) => e.followersDelta !== null && e.followersDelta > 0)
      .sort((a, b) => {
        const da = a.followersDelta ?? 0;
        const db = b.followersDelta ?? 0;
        if (db !== da) return db - da;
        return a.summary.vaultAddress.localeCompare(b.summary.vaultAddress);
      })
      .map((e) => ({
        vaultAddress: e.summary.vaultAddress,
        name: e.summary.name,
        leader: e.summary.leader,
        tvl: e.tvl,
        delta: e.followersDelta ?? 0,
        total: e.currentFollowers,
      }));

    const outflows: OutflowItem[] = enriched
      .filter((e) => e.netFlow < 0)
      .sort((a, b) => {
        if (a.netFlow !== b.netFlow) return a.netFlow - b.netFlow;
        return a.summary.vaultAddress.localeCompare(b.summary.vaultAddress);
      })
      .map((e) => ({
        vaultAddress: e.summary.vaultAddress,
        name: e.summary.name,
        leader: e.summary.leader,
        tvl: e.tvl,
        amountUsd: e.netFlow,
        percentOfTvl: e.tvl > 0 ? e.netFlow / e.tvl : 0,
      }));

    return {
      followersGained,
      outflows,
      meta: {
        window,
        computedAt: now,
        sampleSize: candidates.length,
      },
    };
  }
}
