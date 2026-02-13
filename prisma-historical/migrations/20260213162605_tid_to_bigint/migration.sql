-- AlterTable
ALTER TABLE "ingestion_state" ALTER COLUMN "last_tid" SET DATA TYPE BIGINT;

-- AlterTable
ALTER TABLE "raw_liquidations" ALTER COLUMN "tid" SET DATA TYPE BIGINT;
