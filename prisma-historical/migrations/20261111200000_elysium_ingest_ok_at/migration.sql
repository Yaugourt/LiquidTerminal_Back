-- When each ingestion stream last completed a run. `updated_at` moves on a failure too, and
-- `cursor` is the time of the data for some streams and of the run for others: neither says
-- whether a stream's loop is alive. The status route and the alerts read this one.
ALTER TABLE "elysium_ingest_state" ADD COLUMN "ok_at" TIMESTAMPTZ(3);

-- A stream without an error completed its last run when its row was last written.
UPDATE "elysium_ingest_state" SET "ok_at" = "updated_at" WHERE "last_error" IS NULL;
