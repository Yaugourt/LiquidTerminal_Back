-- Generic hourly time-series of scalar metrics we sample ourselves because no
-- upstream endpoint returns their history (total open interest, active users).
-- One row per (metric, hour); a repeated poll in the same hour overwrites via
-- the unique (metric, time) key.
CREATE TABLE "metric_snapshots" (
    "id" BIGSERIAL NOT NULL,
    "metric" VARCHAR(64) NOT NULL,
    "time" TIMESTAMPTZ(3) NOT NULL,
    "value" DECIMAL(30,4) NOT NULL,
    "meta" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "metric_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "metric_snapshots_metric_time_key" ON "metric_snapshots"("metric", "time");

-- CreateIndex
CREATE INDEX "metric_snapshots_metric_time_idx" ON "metric_snapshots"("metric", "time");
