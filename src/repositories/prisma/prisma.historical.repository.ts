import { prismaHistorical } from '../../core/prisma.historical.service';
import { BasePrismaRepository } from './base-prisma.repository';
import { HistoricalLiquidationRepository } from '../interfaces/historical.repository.interface';
import { RawLiquidationCreateInput, IngestionStateResponse, HistoricalStats } from '../../types/historical.types';

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

  async getStats(since: Date): Promise<HistoricalStats> {
    return this.executeWithErrorHandling(
      async () => {
        const timeFilter = { time: { gte: since } };

        const [aggregates, dirGroups, topCoinGroup] = await Promise.all([
          // 1. Global aggregates: totalVolume, maxLiq, count
          this.prismaClient.rawLiquidation.aggregate({
            where: timeFilter,
            _sum: { notionalTotal: true },
            _max: { notionalTotal: true },
            _count: true,
          }),
          // 2. Group by liqDir for long/short counts + volumes
          this.prismaClient.rawLiquidation.groupBy({
            by: ['liqDir'],
            where: timeFilter,
            _sum: { notionalTotal: true },
            _count: true,
          }),
          // 3. Group by coin, ordered by volume DESC, take top 1
          this.prismaClient.rawLiquidation.groupBy({
            by: ['coin'],
            where: timeFilter,
            _sum: { notionalTotal: true },
            orderBy: { _sum: { notionalTotal: 'desc' } },
            take: 1,
          }),
        ]);

        const totalVolume = aggregates._sum.notionalTotal ?? 0;
        const liquidationsCount = aggregates._count ?? 0;
        const maxLiq = aggregates._max.notionalTotal ?? 0;

        // Extract long/short from direction groups
        let longCount = 0;
        let shortCount = 0;
        let longVolume = 0;
        let shortVolume = 0;

        for (const group of dirGroups) {
          if (group.liqDir === 'Long') {
            longCount = group._count;
            longVolume = group._sum.notionalTotal ?? 0;
          } else if (group.liqDir === 'Short') {
            shortCount = group._count;
            shortVolume = group._sum.notionalTotal ?? 0;
          }
        }

        // Top coin
        const topCoin = topCoinGroup.length > 0 ? topCoinGroup[0].coin : 'N/A';
        const topCoinVolume = topCoinGroup.length > 0 ? (topCoinGroup[0]._sum.notionalTotal ?? 0) : 0;

        // Average size
        const avgSize = liquidationsCount > 0
          ? Math.round((totalVolume / liquidationsCount) * 100) / 100
          : 0;

        return {
          totalVolume: Math.round(totalVolume * 100) / 100,
          liquidationsCount,
          longCount,
          shortCount,
          longVolume: Math.round(longVolume * 100) / 100,
          shortVolume: Math.round(shortVolume * 100) / 100,
          topCoin,
          topCoinVolume: Math.round(topCoinVolume * 100) / 100,
          avgSize,
          maxLiq: Math.round(maxLiq * 100) / 100,
        };
      },
      'computing historical stats',
      { since: since.toISOString() }
    );
  }
}
