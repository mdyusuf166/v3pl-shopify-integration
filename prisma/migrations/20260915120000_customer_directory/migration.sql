-- CreateEnum
CREATE TYPE "CustomerSource" AS ENUM ('MANUAL', 'ORDER', 'THREEPL_PORTAL', 'SHOPIFY', 'CSV_IMPORT');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "customerId" TEXT;

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "phoneNormalized" TEXT,
    "shipName" TEXT,
    "shipCompany" TEXT,
    "shipAddress1" TEXT,
    "shipAddress2" TEXT,
    "shipCity" TEXT,
    "shipProvince" TEXT,
    "shipZip" TEXT,
    "shipCountry" TEXT,
    "shipPhone" TEXT,
    "billName" TEXT,
    "billCompany" TEXT,
    "billAddress1" TEXT,
    "billAddress2" TEXT,
    "billCity" TEXT,
    "billProvince" TEXT,
    "billZip" TEXT,
    "billCountry" TEXT,
    "notes" TEXT,
    "source" "CustomerSource" NOT NULL DEFAULT 'MANUAL',
    "shopifyStoreId" TEXT,
    "shopifyCustomerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Customer_ownerId_name_idx" ON "Customer"("ownerId", "name");

-- CreateIndex
CREATE INDEX "Customer_email_idx" ON "Customer"("email");

-- CreateIndex
CREATE INDEX "Customer_phoneNormalized_idx" ON "Customer"("phoneNormalized");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_shopifyStoreId_shopifyCustomerId_key" ON "Customer"("shopifyStoreId", "shopifyCustomerId");

-- CreateIndex
CREATE INDEX "Order_customerId_idx" ON "Order"("customerId");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Owner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
