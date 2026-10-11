-- Builder code growth: daily revenue and users per builder, from the per-builder
-- daily fill files Hyperliquid publishes.

CREATE TABLE "builder_tracked" (
    "id" SERIAL NOT NULL,
    "address" VARCHAR(42) NOT NULL,
    "name" VARCHAR(64),
    "score" BIGINT NOT NULL DEFAULT 0,
    "cursor" DATE,
    "backfill_done" BOOLEAN NOT NULL DEFAULT false,
    "last_error" TEXT,
    "added_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "builder_tracked_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "builder_tracked_address_key" ON "builder_tracked"("address");

CREATE TABLE "builder_daily" (
    "builder_id" INTEGER NOT NULL,
    "day" DATE NOT NULL,
    "fees" DECIMAL(30,6) NOT NULL,
    "volume" DECIMAL(30,2) NOT NULL,
    "fills" INTEGER NOT NULL,
    "users" INTEGER NOT NULL,
    "new_users" INTEGER NOT NULL,

    CONSTRAINT "builder_daily_pkey" PRIMARY KEY ("builder_id","day")
);

CREATE INDEX "builder_daily_day_idx" ON "builder_daily"("day");

CREATE TABLE "builder_user" (
    "builder_id" INTEGER NOT NULL,
    "user_key" BIGINT NOT NULL,
    "first_day" DATE NOT NULL,

    CONSTRAINT "builder_user_pkey" PRIMARY KEY ("builder_id","user_key")
);

CREATE INDEX "builder_user_builder_id_first_day_idx" ON "builder_user"("builder_id", "first_day");
