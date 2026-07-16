import { HypurrscanFeesHistoryClient } from '../../clients/hypurrscan/feesHistory.client';
import { cacheService } from '../../core/cache.service';
import { REVENUE_CACHE_KEYS, REVENUE_TTL } from '../../constants/revenue.cache';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { FeeData } from '../../types/fees.types';
import {
  RevenueBreakdown,
  RevenueDay,
  RevenueError,
  RevenueWindow,
} from '../../types/revenue.types';

const MICRO_USD_DIVISOR = 1_000_000;
const SECONDS_PER_DAY = 86_400;

/**
 * Spot fees are doubled to approximate gross-user revenue: on HIP-1 pairs the
 * token deployer keeps ~50% of the spot fee, so the protocol-visible figure is
 * roughly half of what users actually pay. Surfaced to the UI via
 * `meta.spotMultiplier` so the caveat can be shown next to the number.
 */
const SPOT_MULTIPLIER = 2;

/** Trailing-day counts per finite window; `all` is unbounded. */
const WINDOW_DAYS: Record<Exclude<RevenueWindow, 'all'>, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
  '1y': 365,
};

/** Raw (unmultiplied) per-day USD revenue for the perp + spot sources. */
interface DayRevenue {
  perp: number;
  spot: number;
}

/**
 * RevenueService — assembles the protocol revenue breakdown consumed by the
 * dashboard "Protocol Revenue" panel and the HYPE flywheel card.
 *
 * Perp and spot are derived from Hypurrscan's cumulative fee snapshots (the
 * dominant, effectively-all of protocol fee revenue). HIP-1/HIP-3 auction,
 * HIP-4 and priority-fee sources are not yet wired and reported as
 * `not_yet_live` (contributing 0) rather than fabricated.
 */
export class RevenueService {
  private static instance: RevenueService;
  private readonly feesHistoryClient = HypurrscanFeesHistoryClient.getInstance();

  public static getInstance(): RevenueService {
    if (!RevenueService.instance) {
      RevenueService.instance = new RevenueService();
    }
    return RevenueService.instance;
  }

  /** UTC day number (days since epoch) for a unix-seconds timestamp. */
  private static dayNumber(unixSeconds: number): number {
    return Math.floor(unixSeconds / SECONDS_PER_DAY);
  }

  /** UTC `YYYY-MM-DD` for a day number. */
  private static dayNumberToDate(dayNumber: number): string {
    return new Date(dayNumber * SECONDS_PER_DAY * 1000).toISOString().slice(0, 10);
  }

  /**
   * Collapse the raw cumulative snapshots into a per-UTC-day map of raw
   * (unmultiplied) perp/spot USD revenue.
   *
   * The snapshots are cumulative all-time totals, so a day's revenue is the
   * delta between successive end-of-day snapshots. Gaps wider than a day (the
   * upstream isn't strictly daily) are spread evenly across the missing days so
   * a 3-day gap reads as three average days rather than one spike. The first
   * snapshot only seeds the baseline — no delta can precede it.
   */
  private buildDailyMap(feesData: FeeData[]): Map<number, DayRevenue> {
    // Last cumulative snapshot within each UTC day (snapshots ascend, but sort
    // defensively in case the upstream ever returns them out of order).
    const sorted = [...feesData].sort((a, b) => a.time - b.time);
    const endOfDay = new Map<number, FeeData>();
    for (const snap of sorted) {
      endOfDay.set(RevenueService.dayNumber(snap.time), snap);
    }

    const dayKeys = [...endOfDay.keys()].sort((a, b) => a - b);
    const daily = new Map<number, DayRevenue>();

    for (let i = 1; i < dayKeys.length; i++) {
      const prevKey = dayKeys[i - 1];
      const curKey = dayKeys[i];
      const prev = endOfDay.get(prevKey)!;
      const cur = endOfDay.get(curKey)!;

      const span = curKey - prevKey; // >= 1
      // Clamp to 0: cumulative totals should only grow; guard upstream glitches.
      const totalDelta = Math.max(0, cur.total_fees - prev.total_fees);
      const spotDelta = Math.max(0, cur.total_spot_fees - prev.total_spot_fees);

      const spotPerDay = spotDelta / span / MICRO_USD_DIVISOR;
      // Perp = all fees minus spot fees.
      const perpPerDay = Math.max(0, totalDelta - spotDelta) / span / MICRO_USD_DIVISOR;

      for (let d = prevKey + 1; d <= curKey; d++) {
        daily.set(d, { perp: perpPerDay, spot: spotPerDay });
      }
    }

    return daily;
  }

  /** Zero-filled `RevenueDay` for a UTC day, applying the spot multiplier. */
  private toRevenueDay(dayNumber: number, raw: DayRevenue | undefined): RevenueDay {
    const perp = raw?.perp ?? 0;
    const spot = (raw?.spot ?? 0) * SPOT_MULTIPLIER;
    return {
      date: RevenueService.dayNumberToDate(dayNumber),
      perp,
      spot,
      hip1: 0,
      hip3: 0,
      hip4: 0,
      priority: 0,
      total: perp + spot,
    };
  }

  private assembleBreakdown(feesData: FeeData[], window: RevenueWindow): RevenueBreakdown {
    if (!feesData.length) {
      throw new RevenueError('No fees data available', 502, 'REVENUE_NO_DATA');
    }

    const daily = this.buildDailyMap(feesData);
    const dayKeys = [...daily.keys()].sort((a, b) => a - b);

    if (!dayKeys.length) {
      throw new RevenueError('Not enough history to build a revenue series', 502, 'REVENUE_NO_SERIES');
    }

    const firstDay = dayKeys[0];
    const lastDay = dayKeys[dayKeys.length - 1];

    // Window start: trailing N days ending on the last available day, or the
    // whole series for `all`. Never start before the first real day.
    const startDay =
      window === 'all' ? firstDay : Math.max(firstDay, lastDay - (WINDOW_DAYS[window] - 1));

    const days: RevenueDay[] = [];
    for (let d = startDay; d <= lastDay; d++) {
      days.push(this.toRevenueDay(d, daily.get(d)));
    }

    // Lifetime = last cumulative snapshot (all-time, window-independent).
    const sorted = [...feesData].sort((a, b) => a.time - b.time);
    const last = sorted[sorted.length - 1];
    const lifetimePerp = Math.max(0, last.total_fees - last.total_spot_fees) / MICRO_USD_DIVISOR;
    const lifetimeSpot = (last.total_spot_fees / MICRO_USD_DIVISOR) * SPOT_MULTIPLIER;

    return {
      window,
      days,
      lifetime: {
        perp: lifetimePerp,
        spot: lifetimeSpot,
        hip1: 0,
        hip3: 0,
        hip4: 0,
        priority: 0,
        total: lifetimePerp + lifetimeSpot,
      },
      meta: {
        spotMultiplier: SPOT_MULTIPLIER,
        hypeUsd: null,
        lastUpdate: last.time * 1000,
        sourceStatus: {
          perpSpot: 'ok',
          // Live sources, but not yet wired into the aggregate — reported as
          // pending so the UI renders an honest 0 instead of an error.
          hip1: 'not_yet_live',
          hip3: 'not_yet_live',
          hip4: 'not_yet_live',
          priority: 'not_yet_live',
        },
      },
    };
  }

  /** Cached raw cumulative-fee history from Hypurrscan. */
  private getFeesHistory(): Promise<FeeData[]> {
    return cacheService.getOrSet(
      REVENUE_CACHE_KEYS.feesHistory,
      () => this.feesHistoryClient.getFeesHistory(),
      REVENUE_TTL.feesHistory
    );
  }

  /** Assembled revenue breakdown for a window (cached per window). */
  public async getBreakdown(window: RevenueWindow): Promise<RevenueBreakdown> {
    try {
      return await cacheService.getOrSet(
        REVENUE_CACHE_KEYS.breakdown(window),
        async () => {
          const feesData = await this.getFeesHistory();
          return this.assembleBreakdown(feesData, window);
        },
        REVENUE_TTL.breakdown
      );
    } catch (error) {
      if (error instanceof RevenueError) throw error;
      logDeduplicator.error('Failed to build revenue breakdown:', {
        window,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new RevenueError(
        error instanceof Error ? error.message : 'Failed to build revenue breakdown',
        502,
        'REVENUE_UPSTREAM_ERROR'
      );
    }
  }
}
