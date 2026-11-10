-- The holder-stats stream picks its next launches by age of their stats: the oldest read first, and
-- the never-read ones before everything. Without an index each pick sorted all ~420k launches.
CREATE INDEX "elysium_launch_stats_at_idx" ON "elysium_launch"("stats_at");
-- The launches never read, newest first. Almost always empty or a handful: a partial index, which
-- Prisma's schema cannot declare (kept here only).
CREATE INDEX "elysium_launch_unread_stats_idx" ON "elysium_launch"("created_at") WHERE "stats_at" IS NULL;
