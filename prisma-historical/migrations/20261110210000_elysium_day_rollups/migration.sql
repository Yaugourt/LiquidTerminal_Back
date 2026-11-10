-- Day rollups of elysium_tx, built once a UTC day is over (ElysiumRollupService), so the wide
-- analytics windows (7, 30, 60 days) read a few rows per called contract and day instead of
-- every transaction. Readers use a day only when its elysium_day_rollup row says it is built
-- and not dirty; any other day is read from elysium_tx as before.

-- One row per UTC day: whether its rollups can be trusted, and the day's totals.
CREATE TABLE "elysium_day_rollup" (
    "day" DATE NOT NULL,
    -- Null until the day's rollups are complete.
    "built_at" TIMESTAMPTZ(3),
    -- Set by the tx insert when a transaction of this (past) day arrives: the day is rebuilt.
    "dirty" BOOLEAN NOT NULL DEFAULT false,
    -- The build that last started on this day: only that one may declare it built.
    "build_token" VARCHAR(36),
    -- Whether elysium_caller_day / elysium_method_sender_day hold this day (they are kept less long).
    "callers_built" BOOLEAN NOT NULL DEFAULT false,
    "senders_built" BOOLEAN NOT NULL DEFAULT false,
    -- Non-spam transactions, and the parts of them the pages show.
    "txs" INTEGER NOT NULL DEFAULT 0,
    "failed_txs" INTEGER NOT NULL DEFAULT 0,
    "bridge_txs" INTEGER NOT NULL DEFAULT 0,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "transfers" INTEGER NOT NULL DEFAULT 0,
    "creations" INTEGER NOT NULL DEFAULT 0,
    "spam_txs" INTEGER NOT NULL DEFAULT 0,
    -- Fees of every transaction of the day, spam included (wei).
    "fee_wei" DECIMAL(60,0) NOT NULL DEFAULT 0,

    CONSTRAINT "elysium_day_rollup_pkey" PRIMARY KEY ("day")
);

-- Non-spam transactions sent to an address, per day, target and selector ('' = no calldata).
-- The key starts with the day: a day is written at the end of the index, and read as one range.
CREATE TABLE "elysium_call_day" (
    "day" DATE NOT NULL,
    "to_addr" VARCHAR(42) NOT NULL,
    "method_id" VARCHAR(10) NOT NULL DEFAULT '',
    "txs" INTEGER NOT NULL,
    "failed" INTEGER NOT NULL,
    "fee_wei" DECIMAL(60,0) NOT NULL,
    "gas_used" BIGINT NOT NULL,

    CONSTRAINT "elysium_call_day_pkey" PRIMARY KEY ("day", "to_addr", "method_id")
);

-- A window's days are found through this small index (a few bytes a row: equal days share
-- one entry) rather than through the primary key, whose entries carry the address.
CREATE INDEX "elysium_call_day_day_idx" ON "elysium_call_day"("day");

-- The targets whose callers of the day are listed in elysium_caller_day (the busy ones), with
-- how many they are. A target absent from here has its callers read from elysium_tx.
CREATE TABLE "elysium_caller_set" (
    "day" DATE NOT NULL,
    "to_addr" VARCHAR(42) NOT NULL,
    "callers" INTEGER NOT NULL,

    CONSTRAINT "elysium_caller_set_pkey" PRIMARY KEY ("day", "to_addr")
);

-- Distinct senders of the day's non-spam transactions to a busy target.
CREATE TABLE "elysium_caller_day" (
    "day" DATE NOT NULL,
    "to_addr" VARCHAR(42) NOT NULL,
    "from_addr" VARCHAR(42) NOT NULL,

    CONSTRAINT "elysium_caller_day_pkey" PRIMARY KEY ("day", "to_addr", "from_addr")
);

-- Distinct senders of the day's non-spam calls, per selector.
CREATE TABLE "elysium_method_sender_day" (
    "day" DATE NOT NULL,
    "method_id" VARCHAR(10) NOT NULL,
    "from_addr" VARCHAR(42) NOT NULL,

    CONSTRAINT "elysium_method_sender_day_pkey" PRIMARY KEY ("day", "method_id", "from_addr")
);
