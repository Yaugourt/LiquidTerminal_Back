import { PrismaClient } from '../../prisma-telegram/generated/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { logDeduplicator } from '../utils/logDeduplicator';

class PrismaTelegramService {
  private static instance: PrismaClient;

  public static getInstance(): PrismaClient {
    if (!PrismaTelegramService.instance) {
      if (!process.env.TELEGRAM_DATABASE_URL) {
        throw new Error('TELEGRAM_DATABASE_URL environment variable is required');
      }

      logDeduplicator.info('Initializing PrismaClient singleton for telegram database');

      const pool = new Pool({
        connectionString: process.env.TELEGRAM_DATABASE_URL,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
        max: 20,
        min: 2,
        keepAlive: true,
      });
      const adapter = new PrismaPg(pool);

      PrismaTelegramService.instance = new PrismaClient({
        adapter,
        log: ['error', 'warn'],
      });

      PrismaTelegramService.instance.$connect()
        .then(() => {
          logDeduplicator.info('Successfully connected to telegram database');
        })
        .catch((error: unknown) => {
          logDeduplicator.error('Failed to connect to telegram database', { error: error instanceof Error ? error.message : String(error) });
        });
    }

    return PrismaTelegramService.instance;
  }

  public static async disconnect(): Promise<void> {
    if (PrismaTelegramService.instance) {
      logDeduplicator.info('Disconnecting telegram PrismaClient');
      await PrismaTelegramService.instance.$disconnect();
    }
  }
}

export { PrismaTelegramService };
export const prismaTelegram = PrismaTelegramService.getInstance();
