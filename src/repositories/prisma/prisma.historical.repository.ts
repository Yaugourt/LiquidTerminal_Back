import { prismaHistorical } from '../../core/prisma.historical.service';
import { BasePrismaRepository } from './base-prisma.repository';
import { HistoricalLiquidationRepository } from '../interfaces/historical.repository.interface';
import { RawLiquidationCreateInput, IngestionStateResponse } from '../../types/historical.types';

/**
 * Prisma implementation of the HistoricalLiquidationRepository.
 * Uses prismaHistorical (separate DB) instead of the default prisma client.
 */
export class PrismaHistoricalLiquidationRepository
  extends BasePrismaRepository
  implements HistoricalLiquidationRepository
{
  // Override: default client is the historical database, not the main one
  protected prismaClient: any = prismaHistorical;

  /**
   * Override: resetPrismaClient resets to historical DB, not main DB
   */
  resetPrismaClient(): void {
    this.prismaClient = prismaHistorical;
  }

  async createMany(data: RawLiquidationCreateInput[]): Promise<{ count: number }> {
    return this.executeWithErrorHandling(
      async () => {
        return this.prismaClient.rawLiquidation.createMany({
          data,
          skipDuplicates: true,
        });
      },
      'batch insert raw liquidations',
      { count: data.length }
    );
  }

  async count(): Promise<number> {
    return this.executeWithErrorHandling(
      async () => {
        return this.prismaClient.rawLiquidation.count();
      },
      'counting raw liquidations'
    );
  }

  async upsertIngestionState(lastTid: bigint, lastTimeMs: bigint, newCount: number): Promise<void> {
    return this.executeWithErrorHandling(
      async () => {
        await this.prismaClient.ingestionState.upsert({
          where: { id: 1 },
          update: {
            lastTid,
            lastTimeMs,
            totalIngested: { increment: BigInt(newCount) },
            lastError: null,
          },
          create: {
            id: 1,
            lastTid,
            lastTimeMs,
            totalIngested: BigInt(newCount),
          },
        });
      },
      'upserting ingestion state',
      { lastTid: Number(lastTid), newCount }
    );
  }

  async getIngestionState(): Promise<IngestionStateResponse | null> {
    return this.executeWithErrorHandling(
      async () => {
        return this.prismaClient.ingestionState.findUnique({
          where: { id: 1 },
        });
      },
      'reading ingestion state'
    );
  }
}
