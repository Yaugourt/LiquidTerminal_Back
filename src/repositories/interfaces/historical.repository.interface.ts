import { BaseRepository } from './base.repository.interface';
import { RawLiquidationCreateInput, IngestionStateResponse } from '../../types/historical.types';

/**
 * Repository interface for historical liquidation data (write-only ingestion).
 * Read/analytics methods will be added in a future PR.
 */
export interface HistoricalLiquidationRepository extends BaseRepository {
  /**
   * Batch insert raw liquidations with skipDuplicates (dedup by tid unique constraint)
   * @returns The number of actually inserted records
   */
  createMany(data: RawLiquidationCreateInput[]): Promise<{ count: number }>;

  /**
   * Get total row count in raw_liquidations table
   */
  count(): Promise<number>;

  /**
   * Upsert the single-row ingestion state watermark
   */
  upsertIngestionState(lastTid: number, lastTimeMs: number, newCount: number): Promise<void>;

  /**
   * Get current ingestion state (for monitoring)
   */
  getIngestionState(): Promise<IngestionStateResponse | null>;
}
