-- CreateEnum
CREATE TYPE "MarketTradeMode" AS ENUM ('SINGLE', 'SPIKE');

-- CreateEnum
CREATE TYPE "PriceAlertDirection" AS ENUM ('ABOVE', 'BELOW');

-- CreateTable
CREATE TABLE "telegram_whale_trade_subscriptions" (
    "id" TEXT NOT NULL,
    "telegram_user_id" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "filter_coins" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "min_volume_usd" DECIMAL(20,2) NOT NULL DEFAULT 0,
    "min_pnl_usd" DECIMAL(20,2) NOT NULL DEFAULT 0,
    "direction" VARCHAR(10),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "telegram_whale_trade_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telegram_whale_trade_sent_alerts" (
    "id" TEXT NOT NULL,
    "subscription_id" TEXT NOT NULL,
    "event_id" VARCHAR(255) NOT NULL,
    "sent_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "telegram_whale_trade_sent_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telegram_spot_fill_subscriptions" (
    "id" TEXT NOT NULL,
    "telegram_user_id" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "filter_coins" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "min_usd" DECIMAL(20,2) NOT NULL DEFAULT 0,
    "side" VARCHAR(10),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "telegram_spot_fill_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telegram_spot_fill_sent_alerts" (
    "id" TEXT NOT NULL,
    "subscription_id" TEXT NOT NULL,
    "event_id" VARCHAR(255) NOT NULL,
    "sent_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "telegram_spot_fill_sent_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telegram_market_trade_subscriptions" (
    "id" TEXT NOT NULL,
    "telegram_user_id" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "mode" "MarketTradeMode" NOT NULL DEFAULT 'SINGLE',
    "filter_coins" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "side" VARCHAR(10),
    "min_notional_usd" DECIMAL(20,2) NOT NULL DEFAULT 0,
    "window_seconds" INTEGER NOT NULL DEFAULT 60,
    "spike_volume_usd" DECIMAL(20,2) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "telegram_market_trade_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telegram_market_trade_sent_alerts" (
    "id" TEXT NOT NULL,
    "subscription_id" TEXT NOT NULL,
    "event_id" VARCHAR(255) NOT NULL,
    "sent_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "telegram_market_trade_sent_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telegram_price_alerts" (
    "id" TEXT NOT NULL,
    "telegram_user_id" TEXT NOT NULL,
    "coin" VARCHAR(40) NOT NULL,
    "target_price" DECIMAL(30,10) NOT NULL,
    "direction" "PriceAlertDirection" NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "one_shot" BOOLEAN NOT NULL DEFAULT true,
    "triggered_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "telegram_price_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "telegram_whale_trade_subscriptions_telegram_user_id_idx" ON "telegram_whale_trade_subscriptions"("telegram_user_id");

-- CreateIndex
CREATE INDEX "telegram_whale_trade_subscriptions_is_active_idx" ON "telegram_whale_trade_subscriptions"("is_active");

-- CreateIndex
CREATE INDEX "telegram_whale_trade_sent_alerts_event_id_idx" ON "telegram_whale_trade_sent_alerts"("event_id");

-- CreateIndex
CREATE INDEX "telegram_whale_trade_sent_alerts_sent_at_idx" ON "telegram_whale_trade_sent_alerts"("sent_at");

-- CreateIndex
CREATE UNIQUE INDEX "telegram_whale_trade_sent_alerts_subscription_id_event_id_key" ON "telegram_whale_trade_sent_alerts"("subscription_id", "event_id");

-- CreateIndex
CREATE INDEX "telegram_spot_fill_subscriptions_telegram_user_id_idx" ON "telegram_spot_fill_subscriptions"("telegram_user_id");

-- CreateIndex
CREATE INDEX "telegram_spot_fill_subscriptions_is_active_idx" ON "telegram_spot_fill_subscriptions"("is_active");

-- CreateIndex
CREATE INDEX "telegram_spot_fill_sent_alerts_event_id_idx" ON "telegram_spot_fill_sent_alerts"("event_id");

-- CreateIndex
CREATE INDEX "telegram_spot_fill_sent_alerts_sent_at_idx" ON "telegram_spot_fill_sent_alerts"("sent_at");

-- CreateIndex
CREATE UNIQUE INDEX "telegram_spot_fill_sent_alerts_subscription_id_event_id_key" ON "telegram_spot_fill_sent_alerts"("subscription_id", "event_id");

-- CreateIndex
CREATE INDEX "telegram_market_trade_subscriptions_telegram_user_id_idx" ON "telegram_market_trade_subscriptions"("telegram_user_id");

-- CreateIndex
CREATE INDEX "telegram_market_trade_subscriptions_is_active_idx" ON "telegram_market_trade_subscriptions"("is_active");

-- CreateIndex
CREATE INDEX "telegram_market_trade_sent_alerts_event_id_idx" ON "telegram_market_trade_sent_alerts"("event_id");

-- CreateIndex
CREATE INDEX "telegram_market_trade_sent_alerts_sent_at_idx" ON "telegram_market_trade_sent_alerts"("sent_at");

-- CreateIndex
CREATE UNIQUE INDEX "telegram_market_trade_sent_alerts_subscription_id_event_id_key" ON "telegram_market_trade_sent_alerts"("subscription_id", "event_id");

-- CreateIndex
CREATE INDEX "telegram_price_alerts_telegram_user_id_idx" ON "telegram_price_alerts"("telegram_user_id");

-- CreateIndex
CREATE INDEX "telegram_price_alerts_is_active_idx" ON "telegram_price_alerts"("is_active");

-- CreateIndex
CREATE INDEX "telegram_price_alerts_coin_idx" ON "telegram_price_alerts"("coin");

-- AddForeignKey
ALTER TABLE "telegram_whale_trade_subscriptions" ADD CONSTRAINT "telegram_whale_trade_subscriptions_telegram_user_id_fkey" FOREIGN KEY ("telegram_user_id") REFERENCES "telegram_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telegram_whale_trade_sent_alerts" ADD CONSTRAINT "telegram_whale_trade_sent_alerts_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "telegram_whale_trade_subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telegram_spot_fill_subscriptions" ADD CONSTRAINT "telegram_spot_fill_subscriptions_telegram_user_id_fkey" FOREIGN KEY ("telegram_user_id") REFERENCES "telegram_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telegram_spot_fill_sent_alerts" ADD CONSTRAINT "telegram_spot_fill_sent_alerts_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "telegram_spot_fill_subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telegram_market_trade_subscriptions" ADD CONSTRAINT "telegram_market_trade_subscriptions_telegram_user_id_fkey" FOREIGN KEY ("telegram_user_id") REFERENCES "telegram_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telegram_market_trade_sent_alerts" ADD CONSTRAINT "telegram_market_trade_sent_alerts_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "telegram_market_trade_subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telegram_price_alerts" ADD CONSTRAINT "telegram_price_alerts_telegram_user_id_fkey" FOREIGN KEY ("telegram_user_id") REFERENCES "telegram_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
