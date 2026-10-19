-- The provider's Elysium indexer stalled on 2026-10-17 at 01:39 UTC while the tx, dex and bridge
-- cursors kept advancing over empty pages. Rewind them to before the stall: the streams now wait
-- for the provider's head (and the log streams read the gap from the RPC), so the hole fills in.
UPDATE "elysium_ingest_state" SET "cursor" = '2026-10-17T00:00:00Z' WHERE "stream" IN ('tx', 'dex');
UPDATE "elysium_ingest_state" SET "cursor" = '2026-10-17T00:00:00Z', "backfill_done" = false WHERE "stream" = 'bridge';

-- Neuriio joins the launchpad decoders: replay the launchpad stream from genesis.
-- Every write of these streams is an idempotent upsert, so a replay only adds what was missed.
UPDATE "elysium_ingest_state" SET "cursor" = NULL, "backfill_done" = false WHERE "stream" = 'launchpad';
