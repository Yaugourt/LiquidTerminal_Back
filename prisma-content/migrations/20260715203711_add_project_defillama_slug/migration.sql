-- Add DefiLlama protocol slug to Project for TVL/volume/fees/price enrichment on project pages.
ALTER TABLE "Project" ADD COLUMN "defillamaSlug" VARCHAR(120);
