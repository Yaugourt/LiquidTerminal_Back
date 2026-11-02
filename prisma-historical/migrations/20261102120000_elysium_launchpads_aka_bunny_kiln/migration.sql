-- aka.fun, BunnyPad and Kiln join the launchpad decoders. The first of their launches on testnet
-- is Kiln's, block 10,440,880 at 2026-10-17 07:31 UTC: replay the launchpad stream from the start
-- of that day. Every write of this stream is an idempotent upsert, so the replay only adds what
-- was missed.
UPDATE "elysium_ingest_state" SET "cursor" = '2026-10-17T00:00:00Z', "backfill_done" = false WHERE "stream" = 'launchpad';
