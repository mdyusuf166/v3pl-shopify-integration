-- AlterTable
ALTER TABLE "ShopifyStore" ADD COLUMN     "importTestOrders" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "ordersImportSince" TIMESTAMP(3);

