-- ReadListItem.resourceId now points at an EducationalResource that lives in the Content DB (no cross-database FK possible); drop the FK to Core's frozen clone table and index the column for delete-by-resource.

-- DropForeignKey
ALTER TABLE "ReadListItem" DROP CONSTRAINT IF EXISTS "ReadListItem_resourceId_fkey";

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ReadListItem_resourceId_idx" ON "ReadListItem"("resourceId");
