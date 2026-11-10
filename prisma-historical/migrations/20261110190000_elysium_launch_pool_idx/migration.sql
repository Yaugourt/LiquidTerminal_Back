-- The trade decoders look a launch up by the market its log names: its token (primary key), its
-- curve (indexed) or its pool (a V2 pair, a V3 pool or a V4 pool id), which had no index.
CREATE INDEX "elysium_launch_pool_idx" ON "elysium_launch"("pool");
