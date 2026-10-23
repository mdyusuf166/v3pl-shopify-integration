-- CreateEnum
CREATE TYPE "ShopifyOutboundStatus" AS ENUM ('PENDING', 'CREATED', 'FAILED');

-- AlterEnum
ALTER TYPE "ShopifyJobType" ADD VALUE 'ORDER_CREATE';

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "shopifyOutboundError" TEXT,
ADD COLUMN     "shopifyOutboundStatus" "ShopifyOutboundStatus";
