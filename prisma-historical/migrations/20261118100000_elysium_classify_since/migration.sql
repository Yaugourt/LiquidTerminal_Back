-- The pass over the window classes reads only the contracts and tokens that arrived since the
-- previous pass, instead of the whole contract and token tables every few minutes.
-- A contract row gets the time it was stored (existing rows: the time of this migration, so the
-- first pass after it looks at all of them once). Tokens already carry updated_at, set when a row
-- is stored or changed: it gets an index.
ALTER TABLE "elysium_contract" ADD COLUMN "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "elysium_contract_created_at_idx" ON "elysium_contract"("created_at");

CREATE INDEX "elysium_token_updated_at_idx" ON "elysium_token"("updated_at");
