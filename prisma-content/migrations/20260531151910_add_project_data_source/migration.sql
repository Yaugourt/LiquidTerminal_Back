-- CreateTable
CREATE TABLE "ProjectDataSource" (
    "id" SERIAL NOT NULL,
    "projectId" INTEGER NOT NULL,
    "type" VARCHAR(50) NOT NULL,
    "identifier" VARCHAR(255) NOT NULL,
    "config" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectDataSource_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProjectDataSource_projectId_idx" ON "ProjectDataSource"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectDataSource_projectId_type_identifier_key" ON "ProjectDataSource"("projectId", "type", "identifier");

-- AddForeignKey
ALTER TABLE "ProjectDataSource" ADD CONSTRAINT "ProjectDataSource_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
