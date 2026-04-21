-- CreateTable
CREATE TABLE "telegram_hip4_sent_alerts" (
    "id" TEXT NOT NULL,
    "telegram_user_id" TEXT NOT NULL,
    "event_dedupe_key" VARCHAR(64) NOT NULL,
    "sent_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "telegram_hip4_sent_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "telegram_hip4_sent_alerts_event_dedupe_key_idx" ON "telegram_hip4_sent_alerts"("event_dedupe_key");

-- CreateIndex
CREATE INDEX "telegram_hip4_sent_alerts_sent_at_idx" ON "telegram_hip4_sent_alerts"("sent_at");

-- CreateIndex
CREATE INDEX "telegram_hip4_sent_alerts_telegram_user_id_sent_at_idx" ON "telegram_hip4_sent_alerts"("telegram_user_id", "sent_at");

-- CreateIndex
CREATE UNIQUE INDEX "telegram_hip4_sent_alerts_telegram_user_id_event_dedupe_key_key" ON "telegram_hip4_sent_alerts"("telegram_user_id", "event_dedupe_key");

-- AddForeignKey
ALTER TABLE "telegram_hip4_sent_alerts" ADD CONSTRAINT "telegram_hip4_sent_alerts_telegram_user_id_fkey" FOREIGN KEY ("telegram_user_id") REFERENCES "telegram_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
