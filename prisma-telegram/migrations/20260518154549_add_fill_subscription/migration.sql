-- CreateTable
CREATE TABLE "telegram_fill_subscriptions" (
    "id" TEXT NOT NULL,
    "telegram_user_id" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "filter_coins" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "filter_wallets" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "min_usd" DECIMAL(20,2) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "telegram_fill_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telegram_fill_sent_alerts" (
    "id" TEXT NOT NULL,
    "subscription_id" TEXT NOT NULL,
    "event_id" VARCHAR(255) NOT NULL,
    "sent_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "telegram_fill_sent_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "telegram_fill_subscriptions_telegram_user_id_idx" ON "telegram_fill_subscriptions"("telegram_user_id");

-- CreateIndex
CREATE INDEX "telegram_fill_subscriptions_is_active_idx" ON "telegram_fill_subscriptions"("is_active");

-- CreateIndex
CREATE INDEX "telegram_fill_sent_alerts_event_id_idx" ON "telegram_fill_sent_alerts"("event_id");

-- CreateIndex
CREATE INDEX "telegram_fill_sent_alerts_sent_at_idx" ON "telegram_fill_sent_alerts"("sent_at");

-- CreateIndex
CREATE UNIQUE INDEX "telegram_fill_sent_alerts_subscription_id_event_id_key" ON "telegram_fill_sent_alerts"("subscription_id", "event_id");

-- AddForeignKey
ALTER TABLE "telegram_fill_subscriptions" ADD CONSTRAINT "telegram_fill_subscriptions_telegram_user_id_fkey" FOREIGN KEY ("telegram_user_id") REFERENCES "telegram_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telegram_fill_sent_alerts" ADD CONSTRAINT "telegram_fill_sent_alerts_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "telegram_fill_subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
