-- Elysium launchpads (Chainzy, CorePad, Signal): every launched token and every trade on it.

CREATE TABLE "elysium_launch" (
    "token" VARCHAR(42) NOT NULL,
    "launchpad" VARCHAR(16) NOT NULL,
    "kind" VARCHAR(8) NOT NULL,
    "creator" VARCHAR(42),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "block_number" BIGINT NOT NULL,
    "tx_hash" VARCHAR(66) NOT NULL,
    "curve" VARCHAR(42),
    "pool" VARCHAR(66),
    "quote" VARCHAR(42) NOT NULL,
    "name" VARCHAR(256),
    "symbol" VARCHAR(128),
    "graduated_at" TIMESTAMPTZ(3),
    "holders" INTEGER,
    "top10_pct" DOUBLE PRECISION,
    "dev_pct" DOUBLE PRECISION,
    "stats_at" TIMESTAMPTZ(3),

    CONSTRAINT "elysium_launch_pkey" PRIMARY KEY ("token")
);

CREATE TABLE "elysium_launch_trade" (
    "tx_hash" VARCHAR(66) NOT NULL,
    "log_index" INTEGER NOT NULL,
    "token" VARCHAR(42) NOT NULL,
    "venue" VARCHAR(8) NOT NULL,
    "block_time" TIMESTAMPTZ(3) NOT NULL,
    "block_number" BIGINT NOT NULL,
    "trader" VARCHAR(42),
    "is_buy" BOOLEAN NOT NULL,
    "quote_amount" DECIMAL(80,0) NOT NULL,
    "token_amount" DECIMAL(80,0) NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "elysium_launch_trade_pkey" PRIMARY KEY ("tx_hash","log_index")
);

CREATE INDEX "elysium_launch_created_at_idx" ON "elysium_launch"("created_at");
CREATE INDEX "elysium_launch_curve_idx" ON "elysium_launch"("curve");
CREATE INDEX "elysium_launch_trade_token_block_time_idx" ON "elysium_launch_trade"("token", "block_time");
CREATE INDEX "elysium_launch_trade_block_time_idx" ON "elysium_launch_trade"("block_time");
