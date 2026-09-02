-- DropForeignKey
ALTER TABLE "stock_aud" DROP CONSTRAINT "stock_aud_revisionId_fkey";

-- DropTable
DROP TABLE "stock_aud";

-- CreateTable
CREATE TABLE "stock_history" (
    "revisionId" BIGINT NOT NULL,
    "revType" "RevisionType" NOT NULL,
    "id" INTEGER NOT NULL,
    "productId" INTEGER,
    "quantity" INTEGER,

    CONSTRAINT "stock_history_pkey" PRIMARY KEY ("revisionId","id")
);

-- CreateIndex
CREATE INDEX "stock_history_id_revisionId_idx" ON "stock_history"("id", "revisionId");

-- CreateIndex
CREATE INDEX "stock_history_revisionId_idx" ON "stock_history"("revisionId");

-- AddForeignKey
ALTER TABLE "stock_history" ADD CONSTRAINT "stock_history_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "revision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

