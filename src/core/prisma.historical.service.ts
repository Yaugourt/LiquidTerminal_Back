import { PrismaClient } from '../../prisma-historical/generated/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { logDeduplicator } from '../utils/logDeduplicator';

class PrismaHistoricalService {
  private static instance: PrismaClient;

  public static getInstance(): PrismaClient {
    if (!PrismaHistoricalService.instance) {
      if (!process.env.HISTORICAL_DATABASE_URL) {
        throw new Error('HISTORICAL_DATABASE_URL environment variable is required');
      }

      logDeduplicator.info('Initializing PrismaClient singleton for historical database');

      const pool = new Pool({
        connectionString: process.env.HISTORICAL_DATABASE_URL,
        // Prevent stale connections after DB restarts
        idleTimeoutMillis: 10000,       // recycle idle connections after 10s
        connectionTimeoutMillis: 5000,  // fail fast if DB unreachable
        keepAlive: true,                // detect dead TCP connections early
      });
      const adapter = new PrismaPg(pool);

      PrismaHistoricalService.instance = new PrismaClient({
        adapter,
        log: ['error', 'warn'],
      });

      PrismaHistoricalService.instance.$connect()
        .then(() => {
          logDeduplicator.info('Successfully connected to historical database');
        })
        .catch((error: unknown) => {
          logDeduplicator.error('Failed to connect to historical database', { error: error instanceof Error ? error.message : String(error) });
        });
    }

    return PrismaHistoricalService.instance;
  }

  public static async disconnect(): Promise<void> {
    if (PrismaHistoricalService.instance) {
      logDeduplicator.info('Disconnecting historical PrismaClient');
      await PrismaHistoricalService.instance.$disconnect();
    }
  }
}

export { PrismaHistoricalService };
export const prismaHistorical = PrismaHistoricalService.getInstance();
