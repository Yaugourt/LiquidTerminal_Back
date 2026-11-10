import { PrismaClient } from '../../prisma-historical/generated/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { logDeduplicator } from '../utils/logDeduplicator';
import { positiveIntEnv } from '../utils/env';
import { registerPool } from './poolRegistry';

/**
 * The longest a statement of the read pool may run. A ceiling, not a target: the widest analytics
 * windows take minutes on a cold cache (fees over 30 days: between 2 and 6 minutes, measured
 * 2026-11-10) and are served from their last value meanwhile, so the limit sits above them. What
 * it ends is the statement nobody waits for any more, which otherwise holds its connection and
 * its snapshot for as long as Postgres lets it.
 */
const READ_STATEMENT_TIMEOUT_MS = positiveIntEnv('HISTORICAL_READ_STATEMENT_TIMEOUT_MS', 600_000);

class PrismaHistoricalService {
  private static instance: PrismaClient;
  private static readInstance: PrismaClient;

  private static requireUrl(): string {
    if (!process.env.HISTORICAL_DATABASE_URL) {
      throw new Error('HISTORICAL_DATABASE_URL environment variable is required');
    }
    return process.env.HISTORICAL_DATABASE_URL;
  }

  private static client(name: string, pool: Pool): PrismaClient {
    // Without this listener, an idle-client error (e.g. Postgres dropping the
    // connection) bubbles up as an uncaught 'error' event and crashes the process.
    pool.on('error', (err) => {
      logDeduplicator.error(`PostgreSQL ${name} pool error`, {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    registerPool(name, pool);
    const client = new PrismaClient({ adapter: new PrismaPg(pool), log: ['error', 'warn'] });
    client
      .$connect()
      .then(() => {
        logDeduplicator.info(`Successfully connected to historical database (${name})`);
      })
      .catch((error: unknown) => {
        logDeduplicator.error(`Failed to connect to historical database (${name})`, {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return client;
  }

  /** The pool of the writers: the ingestion streams and everything that is not an analytics read. */
  public static getInstance(): PrismaClient {
    if (!PrismaHistoricalService.instance) {
      logDeduplicator.info('Initializing PrismaClient singleton for historical database');
      const pool = new Pool({
        connectionString: PrismaHistoricalService.requireUrl(),
        // This pool absorbs the liquidations ingestion writes — without an
        // explicit max it fell back to pg defaults (10) and was the first
        // pool to time out under load
        max: parseInt(process.env.HISTORICAL_DB_POOL_MAX || '20', 10),
        min: parseInt(process.env.HISTORICAL_DB_POOL_MIN || '2', 10),
        // Prevent stale connections after DB restarts
        idleTimeoutMillis: 10000,       // recycle idle connections after 10s
        connectionTimeoutMillis: 10000, // aligned with the main DB pool
        keepAlive: true,                // detect dead TCP connections early
      });
      PrismaHistoricalService.instance = PrismaHistoricalService.client('historical', pool);
    }
    return PrismaHistoricalService.instance;
  }

  /**
   * A second, smaller pool for the Elysium analytics reads. They scan the transaction table for
   * seconds to minutes; on the writers' pool a few of them at once took its connections, and the
   * ingestion then failed to get one within 10 s. Here they can only wait for each other, and
   * each statement ends at READ_STATEMENT_TIMEOUT_MS.
   */
  public static getReadInstance(): PrismaClient {
    if (!PrismaHistoricalService.readInstance) {
      const pool = new Pool({
        connectionString: PrismaHistoricalService.requireUrl(),
        max: positiveIntEnv('HISTORICAL_DB_READ_POOL_MAX', 10),
        min: 0,
        idleTimeoutMillis: 10000,
        // A read waits for a free connection for as long as a visitor would wait for a page.
        connectionTimeoutMillis: 20000,
        keepAlive: true,
        // A session setting given at connection time: every connection of this pool has it from
        // its first statement on.
        options: `-c statement_timeout=${READ_STATEMENT_TIMEOUT_MS}`,
      });
      PrismaHistoricalService.readInstance = PrismaHistoricalService.client('historical-read', pool);
    }
    return PrismaHistoricalService.readInstance;
  }

  public static async disconnect(): Promise<void> {
    if (PrismaHistoricalService.instance) {
      logDeduplicator.info('Disconnecting historical PrismaClient');
      await PrismaHistoricalService.instance.$disconnect();
    }
    if (PrismaHistoricalService.readInstance) {
      await PrismaHistoricalService.readInstance.$disconnect();
    }
  }
}

export { PrismaHistoricalService };
export const prismaHistorical = PrismaHistoricalService.getInstance();
/** For the Elysium analytics reads only (see getReadInstance). */
export const prismaHistoricalRead = PrismaHistoricalService.getReadInstance();
