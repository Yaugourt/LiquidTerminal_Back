#!/usr/bin/env node
/**
 * Pre-deploy guard: unblock Prisma when a known migration is stuck in "failed"
 * state in `_prisma_migrations`, which causes `prisma migrate deploy` to abort
 * with P3009 ("migrate found failed migrations in the target database").
 *
 * Scoped to a hard-coded list of known-bad migration names so we never touch
 * anything else. If the row is missing, already finished, or already rolled
 * back, this script is a no-op. Any unexpected error is swallowed so it can
 * never block container startup — Prisma will then surface the real error.
 *
 * Triggered from `npm start` before `prisma migrate deploy`.
 */

const { Client } = require('pg');

const FAILED_MIGRATIONS_TO_RECOVER = ['20260421130551'];

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.warn('[recover-failed-migration] DATABASE_URL not set — skipping.');
    return;
  }

  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();

    const tableCheck = await client.query(
      `SELECT 1
       FROM information_schema.tables
       WHERE table_schema = current_schema()
         AND table_name = '_prisma_migrations'
       LIMIT 1`
    );
    if (tableCheck.rowCount === 0) {
      console.log('[recover-failed-migration] _prisma_migrations not found — first deploy, skipping.');
      return;
    }

    for (const migrationName of FAILED_MIGRATIONS_TO_RECOVER) {
      const result = await client.query(
        `UPDATE "_prisma_migrations"
         SET rolled_back_at = NOW()
         WHERE migration_name = $1
           AND finished_at IS NULL
           AND rolled_back_at IS NULL`,
        [migrationName]
      );
      if (result.rowCount > 0) {
        console.log(
          `[recover-failed-migration] Marked failed migration "${migrationName}" as rolled_back; deploy will retry it.`
        );
      } else {
        console.log(
          `[recover-failed-migration] Migration "${migrationName}" is not in failed state — nothing to do.`
        );
      }
    }
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    console.warn(`[recover-failed-migration] Skipped recovery due to error: ${message}`);
  } finally {
    try {
      await client.end();
    } catch (_) {
      // ignore
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    const message = error && error.message ? error.message : String(error);
    console.warn(`[recover-failed-migration] Unexpected error (non-fatal): ${message}`);
    process.exit(0);
  });
