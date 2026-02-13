-- CreateTable
CREATE TABLE "raw_liquidations" (
    "id" BIGSERIAL NOT NULL,
    "tid" INTEGER NOT NULL,
    "time" TIMESTAMPTZ(3) NOT NULL,
    "time_ms" BIGINT NOT NULL,
    "coin" VARCHAR(20) NOT NULL,
    "hash" VARCHAR(255) NOT NULL,
    "liquidated_user" VARCHAR(255) NOT NULL,
    "size_total" DOUBLE PRECISION NOT NULL,
    "notional_total" DOUBLE PRECISION NOT NULL,
    "fill_px_vwap" DOUBLE PRECISION NOT NULL,
    "mark_px" DOUBLE PRECISION NOT NULL,
    "method" VARCHAR(50) NOT NULL,
    "fee_total_liquidated" DOUBLE PRECISION NOT NULL,
    "liquidators" TEXT[],
    "liquidator_count" INTEGER NOT NULL,
    "liq_dir" VARCHAR(10) NOT NULL,
    "raw_data" JSONB NOT NULL,
    "ingested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "raw_liquidations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingestion_state" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "last_tid" INTEGER NOT NULL,
    "last_time_ms" BIGINT NOT NULL,
    "total_ingested" BIGINT NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ingestion_state_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "raw_liquidations_tid_key" ON "raw_liquidations"("tid");

-- CreateIndex
CREATE INDEX "raw_liquidations_time_idx" ON "raw_liquidations"("time");

-- CreateIndex
CREATE INDEX "raw_liquidations_coin_idx" ON "raw_liquidations"("coin");

-- CreateIndex
CREATE INDEX "raw_liquidations_liquidated_user_idx" ON "raw_liquidations"("liquidated_user");

-- CreateIndex
CREATE INDEX "raw_liquidations_coin_time_idx" ON "raw_liquidations"("coin", "time");

-- CreateIndex
CREATE INDEX "raw_liquidations_coin_liq_dir_time_idx" ON "raw_liquidations"("coin", "liq_dir", "time");

-- CreateIndex
CREATE INDEX "raw_liquidations_notional_total_idx" ON "raw_liquidations"("notional_total");
