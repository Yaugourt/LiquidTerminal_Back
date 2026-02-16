-- Float to Decimal migration for financial precision
-- This is safe: PostgreSQL ALTER COLUMN TYPE from real/float4 to numeric preserves all data

ALTER TABLE "telegram_subscriptions" ALTER COLUMN "filter_min_usd" TYPE DECIMAL(20,2) USING "filter_min_usd"::DECIMAL(20,2);
