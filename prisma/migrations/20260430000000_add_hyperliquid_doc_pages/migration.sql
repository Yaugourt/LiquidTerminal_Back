-- CreateTable
CREATE TABLE "hyperliquid_doc_pages" (
    "id" TEXT NOT NULL,
    "pageUrl" VARCHAR(500) NOT NULL,
    "relPath" VARCHAR(300) NOT NULL,
    "contentHash" VARCHAR(64) NOT NULL,
    "last_broadcast_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hyperliquid_doc_pages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "hyperliquid_doc_pages_pageUrl_key" ON "hyperliquid_doc_pages"("pageUrl");

-- CreateIndex
CREATE INDEX "hyperliquid_doc_pages_contentHash_idx" ON "hyperliquid_doc_pages"("contentHash");
