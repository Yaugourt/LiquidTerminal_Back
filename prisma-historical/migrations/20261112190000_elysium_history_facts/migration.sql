-- Step 13 of the second Elysium audit (scaling), part 2: what the pages show "since the first
-- block" no longer needs every transaction ever stored.
--
-- Three figures were read from the whole of elysium_tx at each computation: the first and last
-- call of a contract, the methods an address uses most, and the transactions and wallets of an
-- ecosystem project. They cost more as the history grew, and they are what kept old
-- transactions from ever being dropped.
--
-- They are now added up once per UTC day, when the day is final (10 days after it ended: the
-- daily comparison with the provider can still change a day until then), by the ingestion's
-- upkeep (ElysiumFactsRepository). A page reads these tables, and from elysium_tx only the
-- days after the one they go up to. The tables and that day move in one transaction, and a
-- page reads both in one statement.
--
-- Empty until the upkeep has folded the history (a few passes a minute, one day at a time):
-- until then every page reads elysium_tx as before.

-- Where each set of facts stands. 'history': elysium_target_seen and elysium_address_method.
-- The row is also the lock that a fold and a late insert of old rows take in turn.
CREATE TABLE "elysium_fact_state" (
    "fact" VARCHAR(32) NOT NULL,
    -- The last UTC day folded; null until the first one.
    "through_day" DATE,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),

    CONSTRAINT "elysium_fact_state_pkey" PRIMARY KEY ("fact")
);

-- First and last transaction sent to an address, spam included, over the folded days.
CREATE TABLE "elysium_target_seen" (
    "to_addr" VARCHAR(42) NOT NULL,
    "first_at" TIMESTAMPTZ(3) NOT NULL,
    "last_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "elysium_target_seen_pkey" PRIMARY KEY ("to_addr")
);

-- Non-spam transactions sent by an address, per method, over the folded days.
-- method_key: the selector, '' for a transaction without calldata, 'create' for a contract creation.
CREATE TABLE "elysium_address_method" (
    "address" VARCHAR(42) NOT NULL,
    "method_key" VARCHAR(10) NOT NULL,
    "txs" BIGINT NOT NULL,

    CONSTRAINT "elysium_address_method_pkey" PRIMARY KEY ("address", "method_key")
);

-- The contracts of the ecosystem directory, each with the last UTC day its wallets were folded
-- up to (null: not yet). A contract added to the directory later starts from its own history.
CREATE TABLE "elysium_project_contract" (
    "to_addr" VARCHAR(42) NOT NULL,
    "through_day" DATE,

    CONSTRAINT "elysium_project_contract_pkey" PRIMARY KEY ("to_addr")
);

-- Per directory contract and sender: its non-spam transactions and the first of them, over the
-- days folded for that contract.
CREATE TABLE "elysium_project_wallet" (
    "to_addr" VARCHAR(42) NOT NULL,
    "from_addr" VARCHAR(42) NOT NULL,
    "txs" BIGINT NOT NULL,
    "first_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "elysium_project_wallet_pkey" PRIMARY KEY ("to_addr", "from_addr")
);
