-- CreateTable
CREATE TABLE "order_aud" (
    "revisionId" BIGINT NOT NULL,
    "revType" "RevisionType" NOT NULL,
    "id" INTEGER NOT NULL,
    "status" TEXT,

    CONSTRAINT "order_aud_pkey" PRIMARY KEY ("revisionId","id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" SERIAL NOT NULL,
    "status" TEXT NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "order_aud_id_revisionId_idx" ON "order_aud"("id", "revisionId");

-- CreateIndex
CREATE INDEX "order_aud_revisionId_idx" ON "order_aud"("revisionId");

-- AddForeignKey
ALTER TABLE "order_aud" ADD CONSTRAINT "order_aud_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "revision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

