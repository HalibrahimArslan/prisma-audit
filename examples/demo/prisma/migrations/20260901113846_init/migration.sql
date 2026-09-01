-- CreateEnum
CREATE TYPE "RevisionType" AS ENUM ('INSERT', 'UPDATE', 'DELETE');

-- CreateEnum
CREATE TYPE "Currency" AS ENUM ('TRY', 'USD');

-- CreateTable
CREATE TABLE "revision" (
    "id" BIGSERIAL NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT,
    "username" TEXT,

    CONSTRAINT "revision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_aud" (
    "revisionId" BIGINT NOT NULL,
    "revType" "RevisionType" NOT NULL,
    "id" INTEGER NOT NULL,
    "name" TEXT,
    "price" DECIMAL(12,2),
    "currency" "Currency",
    "categoryId" INTEGER,
    "createdAt" TIMESTAMP(3),

    CONSTRAINT "product_aud_pkey" PRIMARY KEY ("revisionId","id")
);

-- CreateTable
CREATE TABLE "stock_aud" (
    "revisionId" BIGINT NOT NULL,
    "revType" "RevisionType" NOT NULL,
    "id" INTEGER NOT NULL,
    "productId" INTEGER,
    "quantity" INTEGER,

    CONSTRAINT "stock_aud_pkey" PRIMARY KEY ("revisionId","id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "currency" "Currency" NOT NULL DEFAULT 'TRY',
    "internalCode" TEXT,
    "categoryId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Stock" (
    "id" SERIAL NOT NULL,
    "productId" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "Stock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Category" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_aud_id_revisionId_idx" ON "product_aud"("id", "revisionId");

-- CreateIndex
CREATE INDEX "product_aud_revisionId_idx" ON "product_aud"("revisionId");

-- CreateIndex
CREATE INDEX "stock_aud_id_revisionId_idx" ON "stock_aud"("id", "revisionId");

-- CreateIndex
CREATE INDEX "stock_aud_revisionId_idx" ON "stock_aud"("revisionId");

-- CreateIndex
CREATE UNIQUE INDEX "Stock_productId_key" ON "Stock"("productId");

-- AddForeignKey
ALTER TABLE "product_aud" ADD CONSTRAINT "product_aud_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "revision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_aud" ADD CONSTRAINT "stock_aud_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "revision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;
