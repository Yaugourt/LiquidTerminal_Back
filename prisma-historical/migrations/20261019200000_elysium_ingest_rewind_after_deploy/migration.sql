-- The instance replaced by the 20261019120000 deploy kept running for about a minute after that
-- migration and advanced the bridge (to 06:00) and dex (to the next day) cursors over the provider's
-- empty pages. Rewind both again; the running code now caps them at the provider's head and reads
-- the dex gap from the RPC. Writes are idempotent upserts.
UPDATE "elysium_ingest_state" SET "cursor" = '2026-10-17T00:00:00Z' WHERE "stream" = 'dex';
UPDATE "elysium_ingest_state" SET "cursor" = '2026-10-17T00:00:00Z', "backfill_done" = false WHERE "stream" = 'bridge';
