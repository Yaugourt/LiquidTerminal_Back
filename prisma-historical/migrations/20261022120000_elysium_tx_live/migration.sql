-- Calls to the ecosystem project contracts read block by block from the public RPC while the
-- provider's indexer lags. Kept apart from elysium_tx: the RPC block view carries no gas used,
-- status or spam flag, and the provider's rows must stay the reference once it catches up.
CREATE TABLE "elysium_tx_live" (
    "tx_hash" VARCHAR(66) NOT NULL,
    "block_number" BIGINT NOT NULL,
    "block_time" TIMESTAMPTZ(3) NOT NULL,
    "from_addr" VARCHAR(42) NOT NULL,
    "to_addr" VARCHAR(42) NOT NULL,

    CONSTRAINT "elysium_tx_live_pkey" PRIMARY KEY ("tx_hash")
);

CREATE INDEX "elysium_tx_live_to_addr_block_time_idx" ON "elysium_tx_live"("to_addr", "block_time");
CREATE INDEX "elysium_tx_live_block_time_idx" ON "elysium_tx_live"("block_time");
