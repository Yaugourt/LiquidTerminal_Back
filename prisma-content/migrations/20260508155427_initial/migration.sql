-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ResourceStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "DevelopmentStatus" AS ENUM ('IDEA', 'DEVELOPMENT', 'BETA', 'PRODUCTION');

-- CreateEnum
CREATE TYPE "TeamSize" AS ENUM ('SOLO', 'SMALL', 'LARGE');

-- CreateEnum
CREATE TYPE "ExperienceLevel" AS ENUM ('BEGINNER', 'INTERMEDIATE', 'EXPERT');

-- CreateEnum
CREATE TYPE "SupportType" AS ENUM ('PROMOTION', 'SERVICES', 'FUNDING', 'CONTRIBUTOR');

-- CreateEnum
CREATE TYPE "ContributorType" AS ENUM ('DEVELOPERS', 'DESIGNERS', 'MARKETING_COMMUNITY', 'TECHNICAL_WRITERS', 'QA_TESTERS');

-- CreateEnum
CREATE TYPE "BudgetRange" AS ENUM ('RANGE_0_5K', 'RANGE_5_15K', 'RANGE_15_30K', 'RANGE_30_50K', 'RANGE_50K_PLUS');

-- CreateTable
CREATE TABLE "Category" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" VARCHAR(255),
    "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" SERIAL NOT NULL,
    "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "desc" VARCHAR(255) NOT NULL,
    "logo" VARCHAR(255) NOT NULL,
    "banner" VARCHAR(255),
    "token" VARCHAR(255),
    "twitter" VARCHAR(255),
    "discord" VARCHAR(255),
    "telegram" VARCHAR(255),
    "website" VARCHAR(255),

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectCategory" (
    "id" SERIAL NOT NULL,
    "projectId" INTEGER NOT NULL,
    "categoryId" INTEGER NOT NULL,
    "assignedAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EducationalCategory" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" VARCHAR(255),
    "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" INTEGER NOT NULL,

    CONSTRAINT "EducationalCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EducationalResource" (
    "id" SERIAL NOT NULL,
    "url" VARCHAR(500) NOT NULL,
    "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "addedBy" INTEGER NOT NULL,
    "linkPreviewId" TEXT,
    "status" "ResourceStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedAt" TIMESTAMP(6),
    "reviewedBy" INTEGER,
    "reviewNotes" VARCHAR(500),

    CONSTRAINT "EducationalResource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EducationalResourceCategory" (
    "id" SERIAL NOT NULL,
    "resourceId" INTEGER NOT NULL,
    "categoryId" INTEGER NOT NULL,
    "assignedAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedBy" INTEGER,

    CONSTRAINT "EducationalResourceCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "link_previews" (
    "id" TEXT NOT NULL,
    "url" VARCHAR(500) NOT NULL,
    "title" VARCHAR(255),
    "description" VARCHAR(500),
    "image" VARCHAR(500),
    "siteName" VARCHAR(100),
    "favicon" VARCHAR(500),
    "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "link_previews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resource_reports" (
    "id" SERIAL NOT NULL,
    "resourceId" INTEGER NOT NULL,
    "reportedBy" INTEGER NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "resource_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public_goods" (
    "id" SERIAL NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "githubUrl" TEXT NOT NULL,
    "demoUrl" TEXT,
    "websiteUrl" TEXT,
    "category" TEXT NOT NULL,
    "discordContact" TEXT,
    "telegramContact" TEXT,
    "logo" TEXT,
    "banner" TEXT,
    "screenshots" TEXT[],
    "problemSolved" TEXT NOT NULL,
    "targetUsers" TEXT[],
    "hlIntegration" TEXT NOT NULL,
    "developmentStatus" "DevelopmentStatus" NOT NULL,
    "leadDeveloperName" TEXT NOT NULL,
    "leadDeveloperContact" TEXT NOT NULL,
    "teamSize" "TeamSize" NOT NULL,
    "experienceLevel" "ExperienceLevel" NOT NULL,
    "technologies" TEXT[],
    "supportTypes" "SupportType"[],
    "contributorTypes" "ContributorType"[],
    "budgetRange" "BudgetRange",
    "status" "ProjectStatus" NOT NULL DEFAULT 'PENDING',
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "reviewerId" INTEGER,
    "reviewNotes" TEXT,
    "submitterId" INTEGER NOT NULL,

    CONSTRAINT "public_goods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hyperliquid_doc_pages" (
    "id" TEXT NOT NULL,
    "pageUrl" VARCHAR(500) NOT NULL,
    "relPath" VARCHAR(300) NOT NULL,
    "contentHash" VARCHAR(64) NOT NULL,
    "content" TEXT,
    "last_broadcast_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hyperliquid_doc_pages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Category_name_key" ON "Category"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Project_title_key" ON "Project"("title");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectCategory_projectId_categoryId_key" ON "ProjectCategory"("projectId", "categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "EducationalCategory_name_key" ON "EducationalCategory"("name");

-- CreateIndex
CREATE INDEX "EducationalResource_status_idx" ON "EducationalResource"("status");

-- CreateIndex
CREATE INDEX "EducationalResource_addedBy_idx" ON "EducationalResource"("addedBy");

-- CreateIndex
CREATE INDEX "EducationalResource_status_createdAt_idx" ON "EducationalResource"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "EducationalResourceCategory_resourceId_categoryId_key" ON "EducationalResourceCategory"("resourceId", "categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "link_previews_url_key" ON "link_previews"("url");

-- CreateIndex
CREATE INDEX "resource_reports_resourceId_idx" ON "resource_reports"("resourceId");

-- CreateIndex
CREATE INDEX "resource_reports_reportedBy_idx" ON "resource_reports"("reportedBy");

-- CreateIndex
CREATE UNIQUE INDEX "resource_reports_resourceId_reportedBy_key" ON "resource_reports"("resourceId", "reportedBy");

-- CreateIndex
CREATE INDEX "public_goods_status_idx" ON "public_goods"("status");

-- CreateIndex
CREATE INDEX "public_goods_category_idx" ON "public_goods"("category");

-- CreateIndex
CREATE INDEX "public_goods_submitterId_idx" ON "public_goods"("submitterId");

-- CreateIndex
CREATE INDEX "public_goods_developmentStatus_idx" ON "public_goods"("developmentStatus");

-- CreateIndex
CREATE INDEX "public_goods_status_submittedAt_idx" ON "public_goods"("status", "submittedAt");

-- CreateIndex
CREATE INDEX "public_goods_category_status_idx" ON "public_goods"("category", "status");

-- CreateIndex
CREATE UNIQUE INDEX "hyperliquid_doc_pages_pageUrl_key" ON "hyperliquid_doc_pages"("pageUrl");

-- CreateIndex
CREATE INDEX "hyperliquid_doc_pages_contentHash_idx" ON "hyperliquid_doc_pages"("contentHash");

-- AddForeignKey
ALTER TABLE "ProjectCategory" ADD CONSTRAINT "ProjectCategory_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectCategory" ADD CONSTRAINT "ProjectCategory_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EducationalResource" ADD CONSTRAINT "EducationalResource_linkPreviewId_fkey" FOREIGN KEY ("linkPreviewId") REFERENCES "link_previews"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EducationalResourceCategory" ADD CONSTRAINT "EducationalResourceCategory_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "EducationalResource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EducationalResourceCategory" ADD CONSTRAINT "EducationalResourceCategory_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "EducationalCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_reports" ADD CONSTRAINT "resource_reports_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "EducationalResource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
