-- Launchpad token market: what the page sorts and searches on is kept on the launch row, so the
-- route reads a page of tokens through indexes instead of rebuilding every token from every trade.
--
-- last_price / last_block / last_log: the token's last trade (the price and its position), kept by
--   the trade insert itself. curve_sold: tokens sold by the bonding curve so far (buys minus sells).
-- Both are filled for the existing rows by the ingestion on its first launchpad tick (a rebuild from
-- elysium_launch_trade, see ElysiumIngestRepository.rebuildLaunchState): nothing heavy runs here,
-- so this migration only adds nullable columns and builds indexes on a ~420k-row table.
ALTER TABLE "elysium_launch"
  ADD COLUMN "last_price" DOUBLE PRECISION,
  ADD COLUMN "last_block" BIGINT,
  ADD COLUMN "last_log" INTEGER,
  ADD COLUMN "curve_sold" DECIMAL(80, 0);

-- "New" within one launchpad, and the launchpad filter of every other sort.
CREATE INDEX "elysium_launch_launchpad_created_at_idx" ON "elysium_launch"("launchpad", "created_at");
-- Market cap order: price order within one quote token (the quotes are then merged at their USD value).
CREATE INDEX "elysium_launch_quote_last_price_idx" ON "elysium_launch"("quote", "last_price");

-- Search by symbol, name or address is a substring match (ILIKE '%q%'). With pg_trgm these three
-- indexes answer it; without the extension (not installable here) the same query still works as a
-- scan, bounded by the route's own limits. Not declared in schema.prisma for that reason.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE INDEX IF NOT EXISTS "elysium_launch_symbol_trgm_idx" ON "elysium_launch" USING gin ("symbol" gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS "elysium_launch_name_trgm_idx" ON "elysium_launch" USING gin ("name" gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS "elysium_launch_token_trgm_idx" ON "elysium_launch" USING gin ("token" gin_trgm_ops);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_trgm indexes skipped (%): launchpad search runs as a scan', SQLERRM;
END
$$;
