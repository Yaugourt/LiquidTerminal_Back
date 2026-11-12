-- Step 11 of the second Elysium audit: the long analytics views in seconds.
--
-- 1. Hour rollups of elysium_tx, for the edges of a window (its first partial day, today): a
--    window then reads whole built days, whole built hours, and at most about two hours of
--    elysium_tx. Kept for a few days only (ElysiumRollupService decides which hours it wants).
-- 2. Window tables: for each window the pages show (1, 7 and 30 days), the sums per called
--    address over the whole days and hours the window holds, with the address's class, so that
--    "top 25 by fees" is an index read and the totals are one row. Always recomputed from the
--    rollups (never adjusted by adding and subtracting), and read only while their state row
--    says which days and hours they stand for.
-- 3. Indexes the analytics reads were missing.
--
-- Nothing reads these tables until the builder has filled them: until then every view computes
-- as before.

-- One row per UTC hour: whether its rollup can be trusted, and the hour's totals.
CREATE TABLE "elysium_hour_rollup" (
    "hour" TIMESTAMPTZ(3) NOT NULL,
    -- Null until the hour's rollup is complete.
    "built_at" TIMESTAMPTZ(3),
    -- Set by a write to elysium_tx that touches this (past) hour: the hour is rebuilt.
    "dirty" BOOLEAN NOT NULL DEFAULT false,
    -- The build that last started on this hour: only that one may declare it built.
    "build_token" VARCHAR(36),
    "txs" INTEGER NOT NULL DEFAULT 0,
    "failed_txs" INTEGER NOT NULL DEFAULT 0,
    "bridge_txs" INTEGER NOT NULL DEFAULT 0,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "transfers" INTEGER NOT NULL DEFAULT 0,
    "creations" INTEGER NOT NULL DEFAULT 0,
    "spam_txs" INTEGER NOT NULL DEFAULT 0,
    -- Fees of every transaction of the hour, spam included (wei).
    "fee_wei" DECIMAL(60,0) NOT NULL DEFAULT 0,

    CONSTRAINT "elysium_hour_rollup_pkey" PRIMARY KEY ("hour")
);

-- Non-spam transactions sent to an address, per hour, target and selector ('' = no calldata).
CREATE TABLE "elysium_call_hour" (
    "hour" TIMESTAMPTZ(3) NOT NULL,
    "to_addr" VARCHAR(42) NOT NULL,
    "method_id" VARCHAR(10) NOT NULL DEFAULT '',
    "txs" INTEGER NOT NULL,
    "failed" INTEGER NOT NULL,
    "fee_wei" DECIMAL(60,0) NOT NULL,
    "gas_used" BIGINT NOT NULL,

    CONSTRAINT "elysium_call_hour_pkey" PRIMARY KEY ("hour", "to_addr", "method_id")
);

-- An hour's rows are found through this small index (equal hours share one entry).
CREATE INDEX "elysium_call_hour_hour_idx" ON "elysium_call_hour"("hour");

-- Per window (span in days: 1, 7, 30) and called address: the non-spam transactions sent to it.
-- d_* = over the whole days the window's state lists as its base; txs / fee_wei / gas_used =
-- those plus the window's edges (hours, and the days added to or taken from the base since it
-- was built). kind: 0 = not a known contract, 1 = deployed contract or registry token,
-- 2 = precompile (0x00…00XX).
CREATE TABLE "elysium_target_window" (
    "span" SMALLINT NOT NULL,
    "to_addr" VARCHAR(42) NOT NULL,
    "d_txs" INTEGER NOT NULL DEFAULT 0,
    "d_fee_wei" DECIMAL(60,0) NOT NULL DEFAULT 0,
    "d_gas_used" BIGINT NOT NULL DEFAULT 0,
    "txs" INTEGER NOT NULL,
    "fee_wei" DECIMAL(60,0) NOT NULL,
    "gas_used" BIGINT NOT NULL,
    -- Whether the totals differ from the base (the row has a part in the edges).
    "edged" BOOLEAN NOT NULL DEFAULT false,
    "kind" SMALLINT NOT NULL,
    "deployer" VARCHAR(42),

    CONSTRAINT "elysium_target_window_pkey" PRIMARY KEY ("span", "to_addr")
) PARTITION BY LIST ("span");

-- One partition per window: a window's rows are read, summed and rewritten on their own.
CREATE TABLE "elysium_target_window_1" PARTITION OF "elysium_target_window" FOR VALUES IN (1);
CREATE TABLE "elysium_target_window_7" PARTITION OF "elysium_target_window" FOR VALUES IN (7);
CREATE TABLE "elysium_target_window_30" PARTITION OF "elysium_target_window" FOR VALUES IN (30);

-- Top known targets of a window by fees (every window) and by transactions (the contracts page: 1 and 7 days).
CREATE INDEX "elysium_target_window_fee_idx" ON "elysium_target_window"("fee_wei" DESC, "to_addr") WHERE "kind" > 0;
CREATE INDEX "elysium_target_window_1_txs_idx" ON "elysium_target_window_1"("txs" DESC, "to_addr") WHERE "kind" > 0;
CREATE INDEX "elysium_target_window_7_txs_idx" ON "elysium_target_window_7"("txs" DESC, "to_addr") WHERE "kind" > 0;
-- The rows whose class may still change: looked at again on every pass of the builder.
CREATE INDEX "elysium_target_window_unclassed_idx" ON "elysium_target_window"("to_addr") WHERE "kind" = 0 OR ("kind" = 1 AND "deployer" IS NULL);
-- The rows the edges touch: the ones a refresh of the edges has to look at.
CREATE INDEX "elysium_target_window_edged_idx" ON "elysium_target_window"("to_addr") WHERE "edged";

-- Per window and deployer: the sums of its contracts in elysium_target_window.
CREATE TABLE "elysium_deployer_window" (
    "span" SMALLINT NOT NULL,
    "deployer" VARCHAR(42) NOT NULL,
    "txs" BIGINT NOT NULL,
    "fee_wei" DECIMAL(60,0) NOT NULL,
    "gas_used" DECIMAL(40,0) NOT NULL,
    -- Its contracts with at least one transaction in the window.
    "contracts" INTEGER NOT NULL,

    CONSTRAINT "elysium_deployer_window_pkey" PRIMARY KEY ("span", "deployer")
);

CREATE INDEX "elysium_deployer_window_fee_idx" ON "elysium_deployer_window"("span", "fee_wei" DESC, "deployer");

-- One row per window: what its rows stand for, and their totals per class.
CREATE TABLE "elysium_window_state" (
    "span" SMALLINT NOT NULL,
    -- Moves on every change of the window's rows: a reader that planned with one version and
    -- finds another in its statement starts again.
    "version" BIGINT NOT NULL DEFAULT 0,
    -- False until the rows are complete for what the lists below say, and after anything that
    -- makes them unsure: readers then compute without the window.
    "ready" BOOLEAN NOT NULL DEFAULT false,
    -- The class of every row was last worked out from nothing under this value of the row
    -- span = 0's version. That row holds no window: its version moves when a contract is
    -- removed (a chain reorganisation), which the cheap pass over the unclassed rows cannot
    -- see; a window whose epoch is behind it is not read, and is rebuilt whole.
    "epoch" BIGINT NOT NULL DEFAULT 0,
    -- [{"day":"YYYY-MM-DD","at":<built_at, epoch ms>}]: the days summed in d_*.
    "base_days" JSONB NOT NULL DEFAULT '[]',
    -- The days and hours the totals stand for, each with the built_at of the rollup it was read from.
    "cover_days" JSONB NOT NULL DEFAULT '[]',
    -- [{"hour":<epoch ms>,"at":<built_at, epoch ms>}]
    "cover_hours" JSONB NOT NULL DEFAULT '[]',
    -- Sums of txs / fee_wei / gas_used and number of addresses with a transaction, per kind.
    "other_txs" BIGINT NOT NULL DEFAULT 0,
    "other_fee_wei" DECIMAL(60,0) NOT NULL DEFAULT 0,
    "other_gas_used" DECIMAL(40,0) NOT NULL DEFAULT 0,
    "other_n" INTEGER NOT NULL DEFAULT 0,
    "app_txs" BIGINT NOT NULL DEFAULT 0,
    "app_fee_wei" DECIMAL(60,0) NOT NULL DEFAULT 0,
    "app_gas_used" DECIMAL(40,0) NOT NULL DEFAULT 0,
    "app_n" INTEGER NOT NULL DEFAULT 0,
    "system_txs" BIGINT NOT NULL DEFAULT 0,
    "system_fee_wei" DECIMAL(60,0) NOT NULL DEFAULT 0,
    "system_gas_used" DECIMAL(40,0) NOT NULL DEFAULT 0,
    "system_n" INTEGER NOT NULL DEFAULT 0,
    "based_at" TIMESTAMPTZ(3),
    "refreshed_at" TIMESTAMPTZ(3),
    "classified_at" TIMESTAMPTZ(3),

    CONSTRAINT "elysium_window_state_pkey" PRIMARY KEY ("span")
);

-- Token lists of the tokens page: the most transferred named tokens, and the day series by first_seen.
CREATE INDEX "elysium_token_top_idx" ON "elysium_token"("transfer_count" DESC, "address") WHERE "standard" = 'erc20' AND "symbol" IS NOT NULL;
CREATE INDEX "elysium_token_first_seen_idx" ON "elysium_token"("first_seen") WHERE "standard" = 'erc20';
-- The pools a token is paired in (contract page).
CREATE INDEX "elysium_dex_pool_token0_idx" ON "elysium_dex_pool"("token0");
CREATE INDEX "elysium_dex_pool_token1_idx" ON "elysium_dex_pool"("token1");
-- The transfers an address received (address profile): the lookup was "from_addr = a OR to_addr = a" with an index on the first only.
CREATE INDEX "elysium_bridge_transfer_to_addr_initiated_at_idx" ON "elysium_bridge_transfer"("to_addr", "initiated_at");
