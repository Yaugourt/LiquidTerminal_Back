-- One row per closed UTC day compared with the provider's own daily figures (ElysiumDayCheckService):
-- what the provider counts, what elysium_tx holds, and where the re-read of a day that differs stands.
CREATE TABLE "elysium_day_check" (
    "day" DATE NOT NULL,
    -- The provider's /stats/daily: user + bridge transactions (what we store as non-spam), spam, bridge.
    "provider_txs" INTEGER NOT NULL,
    "provider_spam" INTEGER NOT NULL,
    "provider_bridge" INTEGER NOT NULL,
    -- The same three counts over elysium_tx, at the last comparison.
    "our_txs" INTEGER NOT NULL,
    "our_spam" INTEGER NOT NULL,
    "our_bridge" INTEGER NOT NULL,
    -- ok | gap (differs, waiting to be read again) | repairing | unrepaired (read again whole, still differs).
    "status" VARCHAR(16) NOT NULL,
    "checked_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- When the difference was first seen; null while the day is equal.
    "gap_since" TIMESTAMPTZ(3),
    -- The 144 ten-minute slots of the day already read again ('1'), for a re-read that spans several runs.
    "progress" VARCHAR(144),
    -- Whole re-reads of the day completed, and what they did.
    "rereads" INTEGER NOT NULL DEFAULT 0,
    "rows_added" INTEGER NOT NULL DEFAULT 0,
    "rows_corrected" INTEGER NOT NULL DEFAULT 0,
    "rows_removed" INTEGER NOT NULL DEFAULT 0,
    "repaired_at" TIMESTAMPTZ(3),

    CONSTRAINT "elysium_day_check_pkey" PRIMARY KEY ("day")
);
