-- Rename composite index on telegram_sent_alerts to match Prisma default slug (snake_case).
-- Original index name comes from migration 20260201200001_add_composite_indexes (camelCase segment).
--
-- Idempotent: no-op if legacy index is missing (migration skipped / DB drift) or new name already exists.
-- Prevents P3018 / 42P01 when ALTER INDEX targets a non-existent relation on prod.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'i'
      AND n.nspname = current_schema()
      AND c.relname = 'telegram_sent_alerts_telegramUserId_sentAt_idx'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'i'
      AND n.nspname = current_schema()
      AND c.relname = 'telegram_sent_alerts_telegram_user_id_sent_at_idx'
  ) THEN
    EXECUTE 'ALTER INDEX "telegram_sent_alerts_telegramUserId_sentAt_idx" RENAME TO "telegram_sent_alerts_telegram_user_id_sent_at_idx"';
  END IF;
END $$;
