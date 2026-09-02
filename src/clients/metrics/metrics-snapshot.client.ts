import { prismaHistorical } from '../../core/prisma.historical.service';
import { withDistributedLock } from '../../utils/distributedLock';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { PerpGlobalStatsService } from '../../services/perp/perpStats.service';
import { HypeDexerOverviewIndexerClient } from '../hypedexer/rest/overview/overview-indexer.client';
import { METRIC, MetricHistoryPoint, MetricKey } from '../../types/metrics-history.types';

const LOCK_KEY = 'poll:metrics-snapshot';
const LOCK_TTL = 50;
// Slow-moving hourly series; polling every 5 min keeps the current hour bucket
// fresh while staying cheap (both upstream reads are Redis-cached).
const UPDATE_INTERVAL = 300000;

/** Floor a date to the start of its UTC hour. */
function floorToHour(d: Date): Date {
  const h = new Date(d);
  h.setUTCMinutes(0, 0, 0);
  return h;
}

/** Narrow the unwrapped active-traders payload to its numeric fields. */
function readActiveTraders(raw: unknown): { value: number; variationPct: number } | null {
  if (raw && typeof raw === 'object' && 'value' in raw) {
    const value = Number((raw as { value: unknown }).value);
    const variationPct = Number((raw as { variationPct?: unknown }).variationPct ?? 0);
    if (Number.isFinite(value)) return { value, variationPct: Number.isFinite(variationPct) ? variationPct : 0 };
  }
  return null;
}

/** Narrow the unwrapped total-fees payload to its numeric fields. */
function readTotalFees(
  raw: unknown
): { totalFees: number; feesSpot: number; feesPerpUsdc: number } | null {
  if (raw && typeof raw === 'object' && 'totalFees' in raw) {
    const r = raw as { totalFees: unknown; feesSpot?: unknown; feesPerpUsdc?: unknown };
    const totalFees = Number(r.totalFees);
    const feesSpot = Number(r.feesSpot ?? 0);
    const feesPerpUsdc = Number(r.feesPerpUsdc ?? 0);
    if (Number.isFinite(totalFees)) {
      return {
        totalFees,
        feesSpot: Number.isFinite(feesSpot) ? feesSpot : 0,
        feesPerpUsdc: Number.isFinite(feesPerpUsdc) ? feesPerpUsdc : 0,
      };
    }
  }
  return null;
}

/**
 * Metrics snapshot poller.
 *
 * Some headline numbers (total perp open interest, 24h active users) are only
 * ever available as a current value; no upstream endpoint returns their
 * history. This poller samples them and writes one hourly point each to the
 * historical DB, so they can be charted over time. Writes are best-effort: a
 * missing table (pre-migration) or a DB hiccup never breaks anything.
 */
export class MetricsSnapshotClient {
  private static instance: MetricsSnapshotClient;

  private perpStats: PerpGlobalStatsService;
  private overview: HypeDexerOverviewIndexerClient;
  private pollingTimeout: NodeJS.Timeout | null = null;
  private pollingStopped = true;
  private consecutiveFailures = 0;

  private constructor() {
    this.perpStats = PerpGlobalStatsService.getInstance();
    this.overview = HypeDexerOverviewIndexerClient.getInstance();
  }

  public static getInstance(): MetricsSnapshotClient {
    if (!MetricsSnapshotClient.instance) {
      MetricsSnapshotClient.instance = new MetricsSnapshotClient();
    }
    return MetricsSnapshotClient.instance;
  }

  public startPolling(): void {
    if (!this.pollingStopped) {
      logDeduplicator.warn('Metrics snapshot polling already started');
      return;
    }
    this.pollingStopped = false;
    void this.tick();
  }

  public stopPolling(): void {
    this.pollingStopped = true;
    if (this.pollingTimeout) {
      clearTimeout(this.pollingTimeout);
      this.pollingTimeout = null;
    }
  }

  /** Self-rescheduling poll loop with exponential backoff on repeated failure. */
  private async tick(): Promise<void> {
    if (this.pollingStopped) return;
    try {
      await this.collectAndPersist();
      this.consecutiveFailures = 0;
    } catch (err) {
      this.consecutiveFailures += 1;
      logDeduplicator.error('Error in metrics snapshot polling:', {
        error: err instanceof Error ? err.message : String(err),
        consecutiveFailures: this.consecutiveFailures,
      });
    }
    if (this.pollingStopped) return;
    const multiplier = Math.min(Math.pow(2, this.consecutiveFailures), 10);
    this.pollingTimeout = setTimeout(() => void this.tick(), UPDATE_INTERVAL * multiplier);
  }

  /** Read the current values and upsert one hourly point per metric. */
  private async collectAndPersist(): Promise<void> {
    const executed = await withDistributedLock(LOCK_KEY, LOCK_TTL, async () => {
      const hour = floorToHour(new Date());

      // Total open interest (USD), plus volume/TVL kept as side values.
      try {
        const stats = await this.perpStats.getPerpGlobalStats();
        if (Number.isFinite(stats.totalOpenInterest) && stats.totalOpenInterest > 0) {
          await this.upsert(METRIC.TOTAL_OI, hour, stats.totalOpenInterest, {
            volume24h: stats.totalVolume24h,
            hlpTvl: stats.hlpTvl,
            pairs: stats.totalPairs,
          });
        }
      } catch (err) {
        logDeduplicator.warn('Metrics: total OI sample skipped', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Active users over the last 24h (global count from the overview snapshot).
      try {
        const active = readActiveTraders(await this.overview.getActiveTraders24h());
        if (active && active.value > 0) {
          await this.upsert(METRIC.ACTIVE_USERS_24H, hour, active.value, {
            variationPct: active.variationPct,
          });
        }
      } catch (err) {
        logDeduplicator.warn('Metrics: active users sample skipped', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Total protocol fees over the last 24h, with the spot/perp split kept.
      try {
        const fees = readTotalFees(await this.overview.getTotalFees24h());
        if (fees && fees.totalFees > 0) {
          await this.upsert(METRIC.TOTAL_FEES_24H, hour, fees.totalFees, {
            feesSpot: fees.feesSpot,
            feesPerpUsdc: fees.feesPerpUsdc,
          });
        }
      } catch (err) {
        logDeduplicator.warn('Metrics: total fees sample skipped', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    if (!executed) {
      logDeduplicator.info('Metrics snapshot skipped - another instance holds the lock');
    }
  }

  /** Best-effort upsert of one hourly point; swallows a missing table / DB error. */
  private async upsert(
    metric: MetricKey,
    time: Date,
    value: number,
    meta: Record<string, number>
  ): Promise<void> {
    try {
      await prismaHistorical.metricSnapshot.upsert({
        where: { metric_time: { metric, time } },
        create: { metric, time, value, meta },
        update: { value, meta },
      });
    } catch (err) {
      logDeduplicator.warn('Metric snapshot persist skipped (best-effort)', {
        metric,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * History of `metric` over the last `hours`, oldest first. Returns [] if the
   * table does not exist yet (pre-migration) or on any read error.
   */
  public async getHistory(metric: MetricKey, hours: number): Promise<MetricHistoryPoint[]> {
    try {
      const since = new Date(Date.now() - hours * 3_600_000);
      const rows = await prismaHistorical.metricSnapshot.findMany({
        where: { metric, time: { gte: since } },
        orderBy: { time: 'asc' },
      });
      return rows.map((r) => ({
        time: r.time.getTime(),
        value: Number(r.value),
        meta: (r.meta as Record<string, number> | null) ?? null,
      }));
    } catch (err) {
      logDeduplicator.warn('Metric history unavailable (best-effort)', {
        metric,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }
}
