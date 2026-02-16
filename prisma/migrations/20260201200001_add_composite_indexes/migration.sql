-- Add composite indexes for query performance

-- User: role + verified queries (admin panel, moderation)
CREATE INDEX IF NOT EXISTS "User_role_verified_idx" ON "User"("role", "verified");

-- User: referral queries by creation date
CREATE INDEX IF NOT EXISTS "User_referredBy_createdAt_idx" ON "User"("referredBy", "createdAt");

-- XpTransaction: user history with action type filtering
CREATE INDEX IF NOT EXISTS "xp_transactions_userId_actionType_createdAt_idx" ON "xp_transactions"("userId", "actionType", "createdAt");

-- EducationalResource: status filtered by date (moderation queue)
CREATE INDEX IF NOT EXISTS "EducationalResource_status_createdAt_idx" ON "EducationalResource"("status", "createdAt");

-- PublicGood: status filtered by submission date
CREATE INDEX IF NOT EXISTS "public_goods_status_submittedAt_idx" ON "public_goods"("status", "submittedAt");

-- PublicGood: category filtered by status
CREATE INDEX IF NOT EXISTS "public_goods_category_status_idx" ON "public_goods"("category", "status");

-- TelegramSentAlert: user's alerts by date
CREATE INDEX IF NOT EXISTS "telegram_sent_alerts_telegramUserId_sentAt_idx" ON "telegram_sent_alerts"("telegram_user_id", "sent_at");
