/**
 * Normalized, source-agnostic metrics for an ecosystem project.
 *
 * Each provider (HL spot token, DeFiLlama, builder, vault, manual…) returns a
 * Partial<NormalizedMetrics>; the aggregation service merges them by source
 * priority into a single payload the frontend consumes without knowing the
 * underlying sources.
 */

/** Supported data-source types. Adding a source = add a value here + a provider. */
export const DATA_SOURCE_TYPES = [
  'HL_SPOT_TOKEN',
  'DEFILLAMA',
  'HL_BUILDER',
  'HL_VAULT',
  'MANUAL',
] as const;

export type DataSourceType = (typeof DATA_SOURCE_TYPES)[number];

/** A single metric value tagged with where it came from and when. */
export interface MetricValue {
  value: number;
  source: string; // e.g. "HL_SPOT_TOKEN", "DEFILLAMA"
  unit?: string; // e.g. "USD", "%"
  asOf: number; // epoch ms
}

/** A point in a time series. */
export interface SeriesPoint {
  t: number; // epoch ms
  v: number;
}

/** Source-agnostic metric bundle returned to the frontend. */
export interface NormalizedMetrics {
  tvl?: MetricValue;
  volume24h?: MetricValue;
  fees24h?: MetricValue;
  revenue24h?: MetricValue;
  price?: MetricValue;
  marketCap?: MetricValue;
  fdv?: MetricValue;
  change24h?: MetricValue;
  holders?: MetricValue;
  /** Optional historical series, when a source exposes them for free. */
  series?: {
    tvl?: SeriesPoint[];
    fees?: SeriesPoint[];
    volume?: SeriesPoint[];
  };
}

/** A data source attached to a project (mirrors the Prisma model). */
export interface ProjectDataSourceRecord {
  id: number;
  projectId: number;
  type: string;
  identifier: string;
  config: unknown | null;
  priority: number;
  enabled: boolean;
}

/**
 * Common contract every metric provider implements. The aggregation service
 * resolves a provider by `type` and calls `fetch` with the source identifier.
 */
export interface MetricProvider {
  readonly type: DataSourceType;
  fetch(identifier: string, config?: unknown): Promise<Partial<NormalizedMetrics>>;
}

/** Aggregated response for GET /project/:id/metrics. */
export interface ProjectMetricsResponse {
  projectId: number;
  metrics: NormalizedMetrics;
  /** Source types that contributed at least one metric. */
  sources: DataSourceType[];
  updatedAt: number;
}
