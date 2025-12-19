-- CreateEnum
CREATE TYPE "ResourceStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "EducationalResource" ADD COLUMN     "reviewNotes" VARCHAR(500),
ADD COLUMN     "reviewedAt" TIMESTAMP(6),
ADD COLUMN     "reviewedBy" INTEGER,
ADD COLUMN     "status" "ResourceStatus" NOT NULL DEFAULT 'PENDING';

-- CreateTable
CREATE TABLE "resource_reports" (
    "id" SERIAL NOT NULL,
    "resourceId" INTEGER NOT NULL,
    "reportedBy" INTEGER NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "resource_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "resource_reports_resourceId_idx" ON "resource_reports"("resourceId");

-- CreateIndex
CREATE INDEX "resource_reports_reportedBy_idx" ON "resource_reports"("reportedBy");

-- CreateIndex
CREATE UNIQUE INDEX "resource_reports_resourceId_reportedBy_key" ON "resource_reports"("resourceId", "reportedBy");

-- CreateIndex
CREATE INDEX "EducationalResource_status_idx" ON "EducationalResource"("status");

-- CreateIndex
CREATE INDEX "EducationalResource_addedBy_idx" ON "EducationalResource"("addedBy");

-- AddForeignKey
ALTER TABLE "EducationalResource" ADD CONSTRAINT "EducationalResource_reviewedBy_fkey" FOREIGN KEY ("reviewedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_reports" ADD CONSTRAINT "resource_reports_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "EducationalResource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_reports" ADD CONSTRAINT "resource_reports_reportedBy_fkey" FOREIGN KEY ("reportedBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
