-- What the Elysium ingestion read and did not store, counted per stream, reason and UTC day
-- (IngestRejects): a row the decoders or the database refused, a launch event from a contract
-- that is not on the list, a window cut at the page cap. The status route shows the counts;
-- `sample` keeps one example per day for whoever looks into it.
CREATE TABLE "elysium_ingest_reject" (
    "stream" VARCHAR(32) NOT NULL,
    "reason" VARCHAR(48) NOT NULL,
    "day" DATE NOT NULL,
    "count" BIGINT NOT NULL DEFAULT 0,
    "last_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sample" TEXT,

    CONSTRAINT "elysium_ingest_reject_pkey" PRIMARY KEY ("stream", "reason", "day")
);

-- The status route reads the last days of every stream.
CREATE INDEX "elysium_ingest_reject_day_idx" ON "elysium_ingest_reject"("day");
