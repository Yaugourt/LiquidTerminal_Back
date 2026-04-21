-- One-time HIP-4 onboarding message flag (Telegram bot)
ALTER TABLE "telegram_users" ADD COLUMN "hip4_intro_shown_at" TIMESTAMP(6);
