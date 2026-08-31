-- Hourly snapshots of the smart-money cohort's aggregate positioning, so the
-- net long/short bias can be charted over time. No upstream endpoint returns
-- historical open-position state, so it is sampled and stored here (1 row/hour).
CREATE TABLE "positioning_snapshots" (
    "id" BIGSERIAL NOT NULL,
    "time" TIMESTAMPTZ(3) NOT NULL,
    "long_notional" DECIMAL(30,2) NOT NULL,
    "short_notional" DECIMAL(30,2) NOT NULL,
    "net_notional" DECIMAL(30,2) NOT NULL,
    "long_share" DECIMAL(10,6) NOT NULL,
    "traders_scanned" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "positioning_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "positioning_snapshots_time_key" ON "positioning_snapshots"("time");

-- CreateIndex
CREATE INDEX "positioning_snapshots_time_idx" ON "positioning_snapshots"("time");
