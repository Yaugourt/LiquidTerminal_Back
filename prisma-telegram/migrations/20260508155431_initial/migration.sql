-- CreateEnum
CREATE TYPE "WalletEventType" AS ENUM ('TRADE', 'ORDER', 'TRANSFER', 'POSITION', 'STAKING');

-- CreateTable
CREATE TABLE "telegram_users" (
    "id" TEXT NOT NULL,
    "telegram_id" BIGINT NOT NULL,
    "username" VARCHAR(255),
    "first_name" VARCHAR(255),
    "linked_user_id" INTEGER,
    "hip4_intro_shown_at" TIMESTAMP(6),
    "doc_watcher_intro_shown_at" TIMESTAMP(6),
    "last_seen_bot_version" VARCHAR(20),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "telegram_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telegram_subscriptions" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "telegram_user_id" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "subscription_type" VARCHAR(20) NOT NULL,
    "filter_coins" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "filter_min_usd" DECIMAL(20,2) NOT NULL DEFAULT 0,
    "filter_wallets" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "use_linked_wallets" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "telegram_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telegram_sent_alerts" (
    "id" TEXT NOT NULL,
    "telegram_user_id" TEXT NOT NULL,
    "liquidation_id" VARCHAR(255) NOT NULL,
    "sent_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "telegram_sent_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telegram_wallet_subscriptions" (
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
CREATE TABLE "telegram_wallet_sent_alerts" (
    "id" TEXT NOT NULL,
    "subscription_id" TEXT NOT NULL,
    "event_id" VARCHAR(255) NOT NULL,
    "sent_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "telegram_wallet_sent_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telegram_hip4_sent_alerts" (
    "id" TEXT NOT NULL,
    "telegram_user_id" TEXT NOT NULL,
    "event_dedupe_key" VARCHAR(64) NOT NULL,
    "sent_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "telegram_hip4_sent_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "telegram_users_telegram_id_key" ON "telegram_users"("telegram_id");

-- CreateIndex
CREATE UNIQUE INDEX "telegram_users_linked_user_id_key" ON "telegram_users"("linked_user_id");

-- CreateIndex
CREATE INDEX "telegram_subscriptions_telegram_user_id_idx" ON "telegram_subscriptions"("telegram_user_id");

-- CreateIndex
CREATE INDEX "telegram_subscriptions_is_active_idx" ON "telegram_subscriptions"("is_active");

-- CreateIndex
CREATE INDEX "telegram_sent_alerts_liquidation_id_idx" ON "telegram_sent_alerts"("liquidation_id");

-- CreateIndex
CREATE INDEX "telegram_sent_alerts_sent_at_idx" ON "telegram_sent_alerts"("sent_at");

-- CreateIndex
CREATE INDEX "telegram_sent_alerts_telegram_user_id_sent_at_idx" ON "telegram_sent_alerts"("telegram_user_id", "sent_at");

-- CreateIndex
CREATE UNIQUE INDEX "telegram_sent_alerts_telegram_user_id_liquidation_id_key" ON "telegram_sent_alerts"("telegram_user_id", "liquidation_id");

-- CreateIndex
CREATE INDEX "telegram_wallet_subscriptions_telegram_user_id_idx" ON "telegram_wallet_subscriptions"("telegram_user_id");

-- CreateIndex
CREATE INDEX "telegram_wallet_subscriptions_is_active_idx" ON "telegram_wallet_subscriptions"("is_active");

-- CreateIndex
CREATE INDEX "telegram_wallet_sent_alerts_event_id_idx" ON "telegram_wallet_sent_alerts"("event_id");

-- CreateIndex
CREATE INDEX "telegram_wallet_sent_alerts_sent_at_idx" ON "telegram_wallet_sent_alerts"("sent_at");

-- CreateIndex
CREATE UNIQUE INDEX "telegram_wallet_sent_alerts_subscription_id_event_id_key" ON "telegram_wallet_sent_alerts"("subscription_id", "event_id");

-- CreateIndex
CREATE INDEX "telegram_hip4_sent_alerts_event_dedupe_key_idx" ON "telegram_hip4_sent_alerts"("event_dedupe_key");

-- CreateIndex
CREATE INDEX "telegram_hip4_sent_alerts_sent_at_idx" ON "telegram_hip4_sent_alerts"("sent_at");

-- CreateIndex
CREATE INDEX "telegram_hip4_sent_alerts_telegram_user_id_sent_at_idx" ON "telegram_hip4_sent_alerts"("telegram_user_id", "sent_at");

-- CreateIndex
CREATE UNIQUE INDEX "telegram_hip4_sent_alerts_telegram_user_id_event_dedupe_key_key" ON "telegram_hip4_sent_alerts"("telegram_user_id", "event_dedupe_key");

-- AddForeignKey
ALTER TABLE "telegram_subscriptions" ADD CONSTRAINT "telegram_subscriptions_telegram_user_id_fkey" FOREIGN KEY ("telegram_user_id") REFERENCES "telegram_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telegram_sent_alerts" ADD CONSTRAINT "telegram_sent_alerts_telegram_user_id_fkey" FOREIGN KEY ("telegram_user_id") REFERENCES "telegram_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telegram_wallet_subscriptions" ADD CONSTRAINT "telegram_wallet_subscriptions_telegram_user_id_fkey" FOREIGN KEY ("telegram_user_id") REFERENCES "telegram_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telegram_wallet_sent_alerts" ADD CONSTRAINT "telegram_wallet_sent_alerts_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "telegram_wallet_subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telegram_hip4_sent_alerts" ADD CONSTRAINT "telegram_hip4_sent_alerts_telegram_user_id_fkey" FOREIGN KEY ("telegram_user_id") REFERENCES "telegram_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
