-- HypeDexer now emits liquidations with no resolved direction (liq_dir = null).
-- A non-nullable column made the ingestion batch insert (createMany) reject the
-- whole batch, stalling ingestion. Allow null; totals still count these rows,
-- long/short splits simply exclude them.
ALTER TABLE "raw_liquidations" ALTER COLUMN "liq_dir" DROP NOT NULL;
