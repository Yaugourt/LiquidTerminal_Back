-- CreateEnum (safe: only create if not exists)
DO $$ BEGIN
    CREATE TYPE "WalletEventType" AS ENUM ('TRADE', 'ORDER', 'TRANSFER', 'POSITION', 'STAKING');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "telegram_wallet_subscriptions" (
    "id" TEXT NOT NULL,
    "telegram_user_id" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "wallet_addresses" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "use_linked_wallets" BOOLEAN NOT NULL DEFAULT false,
    "event_types" "WalletEventType"[] DEFAULT ARRAY[]::"WalletEventType"[],
    "min_amount_usd" DECIMAL(20,2) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "telegram_wallet_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "telegram_wallet_sent_alerts" (
    "id" TEXT NOT NULL,
    "subscription_id" TEXT NOT NULL,
    "event_id" VARCHAR(255) NOT NULL,
    "sent_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "telegram_wallet_sent_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "telegram_wallet_subscriptions_telegram_user_id_idx" ON "telegram_wallet_subscriptions"("telegram_user_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "telegram_wallet_subscriptions_is_active_idx" ON "telegram_wallet_subscriptions"("is_active");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "telegram_wallet_sent_alerts_event_id_idx" ON "telegram_wallet_sent_alerts"("event_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "telegram_wallet_sent_alerts_sent_at_idx" ON "telegram_wallet_sent_alerts"("sent_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "telegram_wallet_sent_alerts_subscription_id_event_id_key" ON "telegram_wallet_sent_alerts"("subscription_id", "event_id");

-- AddForeignKey (safe: only add if constraint doesn't exist)
DO $$ BEGIN
    ALTER TABLE "telegram_wallet_subscriptions" ADD CONSTRAINT "telegram_wallet_subscriptions_telegram_user_id_fkey" FOREIGN KEY ("telegram_user_id") REFERENCES "telegram_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- AddForeignKey (safe: only add if constraint doesn't exist)
DO $$ BEGIN
    ALTER TABLE "telegram_wallet_sent_alerts" ADD CONSTRAINT "telegram_wallet_sent_alerts_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "telegram_wallet_subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- RenameIndex: skipped (index does not exist in production, was never created with that name)
