/**
 * Protocol revenue breakdown types.
 *
 * Served by `GET /market/revenue/history?window=…`. The frontend mirror lives in
 * `liquidterminal_front/src/services/market/revenue/types.ts` — keep both in sync.
 */

export type RevenueWindow = '7d' | '30d' | '90d' | '1y' | 'all';

export const REVENUE_WINDOWS: readonly RevenueWindow[] = ['7d', '30d', '90d', '1y', 'all'] as const;

/** One UTC day of revenue, split across the five tracked sources (USD). */
export interface RevenueDay {
  date: string; // YYYY-MM-DD (UTC)
  perp: number;
  spot: number;
  hip1: number;
  hip3: number;
  hip4: number;
  priority: number;
  total: number;
}

/** Cumulative all-time totals per source (USD). */
export interface RevenueLifetime {
  perp: number;
  spot: number;
  hip1: number;
  hip3: number;
  hip4: number;
  priority: number;
  total: number;
}

/** Per-source health so the UI can render honest "0" vs "error" vs "pending". */
export type RevenueSourceStatus = 'ok' | 'stale' | 'error' | 'not_yet_live';

export interface RevenueMeta {
  spotMultiplier: number;
  hypeUsd: number | null;
  lastUpdate: number; // ms epoch of the freshest upstream snapshot
  sourceStatus: {
    perpSpot: RevenueSourceStatus;
    hip1: RevenueSourceStatus;
    hip3: RevenueSourceStatus;
    hip4: RevenueSourceStatus;
    priority: RevenueSourceStatus;
  };
}

export interface RevenueBreakdown {
  window: RevenueWindow;
  days: RevenueDay[];
  lifetime: RevenueLifetime;
  meta: RevenueMeta;
}

export class RevenueError extends Error {
  constructor(
    message: string,
    public statusCode: number = 500,
    public code: string = 'REVENUE_ERROR'
  ) {
    super(message);
    this.name = 'RevenueError';
  }
}
