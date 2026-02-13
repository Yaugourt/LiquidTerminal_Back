import type { Prisma } from '../../prisma-historical/generated/client';

/**
 * Input for creating raw liquidation records in the historical database.
 * Maps from the WebSocket/REST Liquidation type to the Prisma model.
 */
export interface RawLiquidationCreateInput {
  tid: number;
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
  lastTid: number;
  lastTimeMs: bigint;
  totalIngested: bigint;
  lastError: string | null;
  updatedAt: Date;
}
