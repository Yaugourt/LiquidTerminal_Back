import type { Prisma } from '../../prisma-historical/generated/client';

/**
 * Input for creating raw liquidation records in the historical database.
 * Maps from the WebSocket/REST Liquidation type to the Prisma model.
 */
export interface RawLiquidationCreateInput {
  tid: bigint;
  time: Date;
  timeMs: bigint;
  coin: string;
  hash: string;
  liquidatedUser: string;
  sizeTotal: number;
  notionalTotal: number;
  fillPxVwap: number;
  markPx: number;
  method: string;
  feeTotalLiquidated: number;
  liquidators: string[];
  liquidatorCount: number;
  liqDir: string;
  rawData: Prisma.InputJsonValue;
}

/**
 * Ingestion state watermark for monitoring and crash recovery.
 */
export interface IngestionStateResponse {
  id: number;
  lastTid: bigint;
  lastTimeMs: bigint;
  totalIngested: bigint;
  lastError: string | null;
  updatedAt: Date;
}

/**
 * Aggregated stats computed from historical liquidation data.
 */
export interface HistoricalStats {
  totalVolume_USD: number;
  liquidationsCount: number;
  longCount: number;
  shortCount: number;
  longVolume_USD: number;
  shortVolume_USD: number;
  topCoin: string;
  topCoinVolume_USD: number;
  avgSize_USD: number;
  maxLiq_USD: number;
}

/**
 * Raw row returned by $queryRaw for chart bucket queries.
 */
export interface RawChartBucket {
  bucket: Date;
  total_volume: number;
  total_count: number;
  long_volume: number;
  short_volume: number;
  long_count: number;
  short_count: number;
}

/**
 * Normalized chart bucket for API response.
 */
export interface ChartBucket {
  timestamp: string;
  totalVolume_USD: number;
  count: number;
  longVolume_USD: number;
  shortVolume_USD: number;
  longCount: number;
  shortCount: number;
}

export type HistoricalChartPeriod = '24h' | '7d' | '14d' | '30d' | '90d';

/**
 * Full chart result returned by the service.
 */
export interface HistoricalChartResult {
  buckets: ChartBucket[];
  filters: {
    period: HistoricalChartPeriod;
    coin: string | null;
    bucketSizeMinutes: number;
  };
  metadata: {
    computedAt: string;
    dataFrom: string;
    dataTo: string;
    totalBuckets: number;
    cacheTTL: number;
  };
}
