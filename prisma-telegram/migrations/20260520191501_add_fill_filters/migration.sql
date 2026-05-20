-- AlterTable
ALTER TABLE "telegram_fill_subscriptions" ADD COLUMN     "filter_direction" VARCHAR(10),
ADD COLUMN     "filter_side" VARCHAR(10),
ADD COLUMN     "filter_source" VARCHAR(10),
ADD COLUMN     "max_usd" DECIMAL(30,8);
