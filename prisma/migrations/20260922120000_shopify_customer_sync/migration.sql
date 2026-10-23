-- Shopify customer sync (D-065): additive only.

-- AlterEnum
ALTER TYPE "ShopifySyncEntity" ADD VALUE 'CUSTOMER';

-- AlterTable
ALTER TABLE "ShopifyStore" ADD COLUMN     "lastCustomerSyncAt" TIMESTAMP(3);
