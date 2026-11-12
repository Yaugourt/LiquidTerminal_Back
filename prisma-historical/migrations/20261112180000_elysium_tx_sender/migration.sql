-- Step 13 of the second Elysium audit (scaling), part 1: the sender of a transaction is kept
-- on the rows read from its logs.
--
-- A swap, a launchpad trade and a launch are read from event logs, which do not say who sent
-- the transaction. The pages need it (the trader of a swap routed through a contract, the
-- creator of a launch whose event names none) and looked it up in elysium_tx by the
-- transaction's hash alone, on every read: a random read in the largest table for each row,
-- and a lookup that cannot say which day the transaction is in, which is what keeps
-- elysium_tx from being split by day.
--
-- The sender is now copied once, by the ingestion (ElysiumUpkeepService), next to the row
-- that needs it. Null until copied, and for good when elysium_tx never held the transaction.
-- Adding a nullable column rewrites nothing.

ALTER TABLE "elysium_dex_swap" ADD COLUMN "tx_from" VARCHAR(42);
ALTER TABLE "elysium_launch_trade" ADD COLUMN "tx_from" VARCHAR(42);
ALTER TABLE "elysium_launch" ADD COLUMN "tx_from" VARCHAR(42);

-- The swaps an address sent, for its profile (it was a join of every swap with elysium_tx).
CREATE INDEX "elysium_dex_swap_tx_from_idx" ON "elysium_dex_swap" ("tx_from", "block_time") WHERE "tx_from" IS NOT NULL;
