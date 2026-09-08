-- CreateTable
CREATE TABLE "order_line_aud" (
    "revisionId" BIGINT NOT NULL,
    "revType" "RevisionType" NOT NULL,
    "orderId" INTEGER NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "quantity" INTEGER,
    "note" TEXT,

    CONSTRAINT "order_line_aud_pkey" PRIMARY KEY ("revisionId","orderId","lineNo")
);

-- CreateTable
CREATE TABLE "OrderLine" (
    "orderId" INTEGER NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "note" TEXT,

    CONSTRAINT "OrderLine_pkey" PRIMARY KEY ("orderId","lineNo")
);

-- CreateIndex
CREATE INDEX "order_line_aud_orderId_lineNo_revisionId_idx" ON "order_line_aud"("orderId", "lineNo", "revisionId");

-- CreateIndex
CREATE INDEX "order_line_aud_revisionId_idx" ON "order_line_aud"("revisionId");

-- AddForeignKey
ALTER TABLE "order_line_aud" ADD CONSTRAINT "order_line_aud_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "revision"("id") ON DELETE CASCADE ON UPDATE CASCADE;
