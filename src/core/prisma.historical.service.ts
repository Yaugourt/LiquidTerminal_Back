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

/** The longest a statement of the pages pool may run: its reads answer a visitor who is waiting. */
const PAGES_STATEMENT_TIMEOUT_MS = positiveIntEnv('HISTORICAL_PAGES_STATEMENT_TIMEOUT_MS', 30_000);

class PrismaHistoricalService {
  private static instance: PrismaClient;
  private static readInstance: PrismaClient;
  private static pagesInstance: PrismaClient;
  private static aggregateInstance: PrismaClient;

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
   * A second, smaller pool for the Elysium reads. They scan the transaction table for seconds
   * to minutes; on the writers' pool a few of them at once took its connections, and the
   * ingestion then failed to get one within 10 s. Here they can only wait for each other, and
   * each statement ends at READ_STATEMENT_TIMEOUT_MS. Since the scheduled aggregates and the
   * page reads have pools of their own (below), this one serves the address and contract
   * profiles, computed on request.
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

  /**
   * The reads a visitor waits for and that must stay quick whatever else runs: the launchpad
   * list (its snapshot, its pages, its searches) and the status of the ingestion. They shared
   * the 10 connections of the read pool with aggregates of several minutes: when those filled
   * it, the status route did not answer for 20 s (measured 2026-11-11), at the very moment it is
   * looked at. Here a read waits 8 s for a connection at most, and a statement ends after 30 s.
   */
  public static getPagesInstance(): PrismaClient {
    if (!PrismaHistoricalService.pagesInstance) {
      const pool = new Pool({
        connectionString: PrismaHistoricalService.requireUrl(),
        max: positiveIntEnv('HISTORICAL_DB_PAGES_POOL_MAX', 8),
        min: 0,
        idleTimeoutMillis: 10000,
        connectionTimeoutMillis: 8000,
        keepAlive: true,
        options: `-c statement_timeout=${PAGES_STATEMENT_TIMEOUT_MS}`,
      });
      PrismaHistoricalService.pagesInstance = PrismaHistoricalService.client('historical-pages', pool);
    }
    return PrismaHistoricalService.pagesInstance;
  }

  /**
   * The aggregates the view scheduler computes in the background (analytics, ecosystem). Nobody
   * waits for them, and the scheduler runs two views at a time: a view's statements wait here
   * for one of 5 connections for as long as it takes (longer than a statement may run, so a
   * queued statement is never the one that fails), instead of taking the connections of the
   * pages or of the address profiles.
   */
  public static getAggregateInstance(): PrismaClient {
    if (!PrismaHistoricalService.aggregateInstance) {
      const pool = new Pool({
        connectionString: PrismaHistoricalService.requireUrl(),
        max: positiveIntEnv('HISTORICAL_DB_AGGREGATE_POOL_MAX', 5),
        min: 0,
        idleTimeoutMillis: 10000,
        connectionTimeoutMillis: READ_STATEMENT_TIMEOUT_MS + 60_000,
        keepAlive: true,
        options: `-c statement_timeout=${READ_STATEMENT_TIMEOUT_MS}`,
      });
      PrismaHistoricalService.aggregateInstance = PrismaHistoricalService.client('historical-aggregate', pool);
    }
    return PrismaHistoricalService.aggregateInstance;
  }

  public static async disconnect(): Promise<void> {
    if (PrismaHistoricalService.instance) {
      logDeduplicator.info('Disconnecting historical PrismaClient');
      await PrismaHistoricalService.instance.$disconnect();
    }
    for (const client of [
      PrismaHistoricalService.readInstance,
      PrismaHistoricalService.pagesInstance,
      PrismaHistoricalService.aggregateInstance,
    ]) {
      if (client) await client.$disconnect();
    }
  }
}

export { PrismaHistoricalService };
export const prismaHistorical = PrismaHistoricalService.getInstance();
/** For the Elysium address and contract profiles (see getReadInstance). */
export const prismaHistoricalRead = PrismaHistoricalService.getReadInstance();
/** For the reads a visitor waits for: launchpad list, ingestion status (see getPagesInstance). */
export const prismaHistoricalPages = PrismaHistoricalService.getPagesInstance();
/** For the scheduled aggregates (see getAggregateInstance). */
export const prismaHistoricalAggregate = PrismaHistoricalService.getAggregateInstance();
