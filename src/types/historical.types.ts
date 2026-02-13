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
  totalVolume: number;
  liquidationsCount: number;
  longCount: number;
  shortCount: number;
  longVolume: number;
  shortVolume: number;
  topCoin: string;
  topCoinVolume: number;
  avgSize: number;
  maxLiq: number;
}
