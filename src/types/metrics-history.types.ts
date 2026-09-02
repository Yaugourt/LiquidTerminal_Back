/**
 * Self-sampled scalar time-series (total open interest, active users, ...).
 * No upstream endpoint returns the history of these values, so the backend
 * stores one hourly point per metric and serves them back for charting.
 */

/** Metric keys stored in `metric_snapshots.metric`. */
export const METRIC = {
  TOTAL_OI: 'total_oi',
  ACTIVE_USERS_24H: 'active_users_24h',
  TOTAL_FEES_24H: 'total_fees_24h',
} as const;

export type MetricKey = (typeof METRIC)[keyof typeof METRIC];

/** True if `m` is a metric we know how to serve. */
export function isMetricKey(m: string): m is MetricKey {
  return (Object.values(METRIC) as string[]).includes(m);
}

/** One stored hourly point of a metric. */
export interface MetricHistoryPoint {
  /** Epoch ms of the hour bucket. */
  time: number;
  value: number;
  /** Optional side values captured alongside the main value. */
  meta?: Record<string, number> | null;
}

export class MetricsHistoryError extends Error {
  constructor(
    message: string,
    public statusCode = 500,
    public code = 'METRICS_HISTORY_ERROR'
  ) {
    super(message);
    this.name = 'MetricsHistoryError';
  }
}
