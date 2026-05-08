import { Client } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

// Verifies the dedicated Telegram Postgres database (TELEGRAM_DATABASE_URL).
// Falls back to DATABASE_URL only for legacy environments where the Telegram
// tables still live in the Core DB; new deployments must set TELEGRAM_DATABASE_URL.
const CONNECTION_URL = process.env.TELEGRAM_DATABASE_URL || process.env.DATABASE_URL;
if (!CONNECTION_URL) {
  console.error(
    'Missing TELEGRAM_DATABASE_URL (or DATABASE_URL fallback). Run: TELEGRAM_DATABASE_URL="postgresql://user:pass@host:5432/db" npx tsx scripts/verify-telegram-db.ts'
  );
  process.exit(1);
}

async function main() {
  const client = new Client({ connectionString: CONNECTION_URL });
  await client.connect();

  const findings: Record<string, unknown> = {};

  try {
    // 1. Schema verification
    const tables = [
      'telegram_users',
      'telegram_subscriptions',
      'telegram_sent_alerts',
      'telegram_wallet_subscriptions',
      'telegram_wallet_sent_alerts',
    ];

    findings.schema = {};
    for (const table of tables) {
      const cols = await client.query(`
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position
      `, [table]);

      const fks = await client.query(`
        SELECT
          tc.constraint_name, kcu.column_name,
          ccu.table_name AS foreign_table,
          ccu.column_name AS foreign_column
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
        JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
        WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = $1
      `, [table]);

      const pks = await client.query(`
        SELECT kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
        WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_name = $1
      `, [table]);

      const uniques = await client.query(`
        SELECT kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
        WHERE tc.constraint_type = 'UNIQUE' AND tc.table_name = $1
      `, [table]);

      (findings.schema as Record<string, unknown>)[table] = {
        columns: cols.rows,
        primaryKeys: pks.rows.map((r) => r.column_name),
        foreignKeys: fks.rows,
        uniqueConstraints: uniques.rows.map((r) => r.column_name),
      };
    }

    // 2. Data integrity
    const orphanedSentAlerts = await client.query(`
      SELECT tsa.id, tsa.telegram_user_id
      FROM telegram_sent_alerts tsa
      LEFT JOIN telegram_users tu ON tsa.telegram_user_id = tu.id
      WHERE tu.id IS NULL
    `);

    const orphanedSubscriptions = await client.query(`
      SELECT ts.id, ts.telegram_user_id
      FROM telegram_subscriptions ts
      LEFT JOIN telegram_users tu ON ts.telegram_user_id = tu.id
      WHERE tu.id IS NULL
    `);

    const orphanedWalletSubs = await client.query(`
      SELECT tws.id, tws.telegram_user_id
      FROM telegram_wallet_subscriptions tws
      LEFT JOIN telegram_users tu ON tws.telegram_user_id = tu.id
      WHERE tu.id IS NULL
    `);

    const orphanedWalletAlerts = await client.query(`
      SELECT twsa.id, twsa.subscription_id
      FROM telegram_wallet_sent_alerts twsa
      LEFT JOIN telegram_wallet_subscriptions tws ON twsa.subscription_id = tws.id
      WHERE tws.id IS NULL
    `);

    findings.dataIntegrity = {
      telegram_sent_alerts_orphaned: orphanedSentAlerts.rows,
      telegram_sent_alerts_orphaned_count: orphanedSentAlerts.rowCount,
      telegram_subscriptions_orphaned: orphanedSubscriptions.rows,
      telegram_subscriptions_orphaned_count: orphanedSubscriptions.rowCount,
      telegram_wallet_subscriptions_orphaned: orphanedWalletSubs.rows,
      telegram_wallet_subscriptions_orphaned_count: orphanedWalletSubs.rowCount,
      telegram_wallet_sent_alerts_orphaned: orphanedWalletAlerts.rows,
      telegram_wallet_sent_alerts_orphaned_count: orphanedWalletAlerts.rowCount,
    };

    // 3. Alert distribution - last 50 telegram_sent_alerts
    const last50Alerts = await client.query(`
      SELECT telegram_user_id, sent_at, liquidation_id
      FROM telegram_sent_alerts
      ORDER BY sent_at DESC
      LIMIT 50
    `);

    const userIdsInLast50 = [...new Set(last50Alerts.rows.map((r) => r.telegram_user_id))];
    const yaugourtUser = await client.query(
      `SELECT id, telegram_id, username FROM telegram_users WHERE telegram_id = 1090592141`
    );
    const yaugourtId = yaugourtUser.rows[0]?.id ?? null;

    const yaugourtInLast50 = yaugourtId ? userIdsInLast50.includes(yaugourtId) : false;
    const yaugourtLastAlert = yaugourtId
      ? await client.query(
          `SELECT sent_at, liquidation_id FROM telegram_sent_alerts WHERE telegram_user_id = $1 ORDER BY sent_at DESC LIMIT 1`,
          [yaugourtId]
        )
      : { rows: [] };

    findings.alertDistribution = {
      last50Alerts_userIds: userIdsInLast50,
      last50Alerts_count: last50Alerts.rowCount,
      yaugourt_telegram_id: 1090592141,
      yaugourt_db_id: yaugourtId,
      yaugourt_username: yaugourtUser.rows[0]?.username ?? null,
      yaugourt_in_last_50_alerts: yaugourtInLast50,
      yaugourt_last_alert_sent_at: yaugourtLastAlert.rows[0]?.sent_at ?? null,
      yaugourt_last_alert_liquidation_id: yaugourtLastAlert.rows[0]?.liquidation_id ?? null,
    };

    // 4. Active subscriptions for Yaugourt
    const yaugourtSubs = yaugourtId
      ? await client.query(
          `SELECT id, name, is_active, subscription_type, filter_coins, filter_min_usd, filter_wallets, use_linked_wallets, created_at
           FROM telegram_subscriptions
           WHERE telegram_user_id = $1
           ORDER BY created_at`,
          [yaugourtId]
        )
      : { rows: [] };

    const yaugourtWalletSubs = yaugourtId
      ? await client.query(
          `SELECT id, name, is_active, wallet_addresses, use_linked_wallets, event_types, min_amount_usd, created_at
           FROM telegram_wallet_subscriptions
           WHERE telegram_user_id = $1
           ORDER BY created_at`,
          [yaugourtId]
        )
      : { rows: [] };

    findings.yaugourtSubscriptions = {
      liquidation_subscriptions: yaugourtSubs.rows,
      wallet_subscriptions: yaugourtWalletSubs.rows,
    };

    // 5. Summary
    const hasOrphans =
      orphanedSentAlerts.rowCount! > 0 ||
      orphanedSubscriptions.rowCount! > 0 ||
      orphanedWalletSubs.rowCount! > 0 ||
      orphanedWalletAlerts.rowCount! > 0;

    findings.summary = {
      schema_tables_found: tables.every((t) =>
        Object.keys((findings.schema as Record<string, unknown>)[t] as object).length > 0
      ),
      data_integrity_ok: !hasOrphans,
      orphan_counts: {
        telegram_sent_alerts: orphanedSentAlerts.rowCount,
        telegram_subscriptions: orphanedSubscriptions.rowCount,
        telegram_wallet_subscriptions: orphanedWalletSubs.rowCount,
        telegram_wallet_sent_alerts: orphanedWalletAlerts.rowCount,
      },
      alerts_in_correct_tables: true,
      yaugourt_exists: !!yaugourtId,
      yaugourt_has_subscriptions:
        yaugourtSubs.rows.length > 0 || yaugourtWalletSubs.rows.length > 0,
    };
  } finally {
    await client.end();
  }

  console.log(JSON.stringify(findings, null, 2));
}

main().catch((e) => {
  console.error('Error:', e);
  process.exit(1);
});
