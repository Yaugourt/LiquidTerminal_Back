import { PrismaClient } from '../../prisma-content/generated/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { logDeduplicator } from '../utils/logDeduplicator';

class PrismaContentService {
  private static instance: PrismaClient;

  public static getInstance(): PrismaClient {
    if (!PrismaContentService.instance) {
      if (!process.env.CONTENT_DATABASE_URL) {
        throw new Error('CONTENT_DATABASE_URL environment variable is required');
      }

      logDeduplicator.info('Initializing PrismaClient singleton for content database');

      const pool = new Pool({
        connectionString: process.env.CONTENT_DATABASE_URL,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
        max: 20,
        min: 2,
        keepAlive: true,
      });

      // A pg.Pool emits 'error' on idle clients when the server closes a
      // connection (idle timeout, failover, restart). Without a listener Node
      // throws an unhandled exception and the process crashes. Invisible locally
      // (local PG never closes idle connections), fatal on managed PG in prod.
      pool.on('error', (err) => {
        logDeduplicator.error('Content PostgreSQL pool error', {
          error: err instanceof Error ? err.message : String(err),
        });
      });

      const adapter = new PrismaPg(pool);

      PrismaContentService.instance = new PrismaClient({
        adapter,
        log: ['error', 'warn'],
      });

      PrismaContentService.instance.$connect()
        .then(() => {
          logDeduplicator.info('Successfully connected to content database');
        })
        .catch((error: unknown) => {
          logDeduplicator.error('Failed to connect to content database', { error: error instanceof Error ? error.message : String(error) });
        });
    }

    return PrismaContentService.instance;
  }

  public static async disconnect(): Promise<void> {
    if (PrismaContentService.instance) {
      logDeduplicator.info('Disconnecting content PrismaClient');
      await PrismaContentService.instance.$disconnect();
    }
  }
}

export { PrismaContentService };
export const prismaContent = PrismaContentService.getInstance();
