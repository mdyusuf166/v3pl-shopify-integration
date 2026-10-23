-- CreateEnum
CREATE TYPE "ShopifyStoreStatus" AS ENUM ('PENDING_INSTALL', 'CONNECTED', 'NEEDS_REAUTH', 'UNINSTALLED', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "ShopifyPublishRule" AS ENUM ('ALL_AVAILABLE');

-- CreateEnum
CREATE TYPE "ShopifyMappingStatus" AS ENUM ('MATCHED', 'UNMATCHED', 'CONFLICT', 'IGNORED');

-- CreateEnum
CREATE TYPE "ShopifyMatchedBy" AS ENUM ('SKU_EXACT', 'MANUAL');

-- CreateEnum
CREATE TYPE "ShopifyWebhookEventStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED', 'SKIPPED_DUPLICATE', 'SKIPPED_STALE', 'IGNORED');

-- CreateEnum
CREATE TYPE "ShopifySyncDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "ShopifySyncEntity" AS ENUM ('ORDER', 'FULFILLMENT', 'INVENTORY', 'PRODUCT', 'STORE', 'WEBHOOK');

-- CreateEnum
CREATE TYPE "ShopifySyncStatus" AS ENUM ('SUCCESS', 'FAILED', 'NEEDS_ATTENTION', 'SKIPPED');

-- CreateEnum
CREATE TYPE "ShopifyJobType" AS ENUM ('FULFILLMENT_CREATE', 'TRACKING_UPDATE', 'INVENTORY_PUBLISH');

-- CreateEnum
CREATE TYPE "ShopifyJobStatus" AS ENUM ('PENDING', 'RUNNING', 'DONE', 'FAILED', 'NEEDS_ATTENTION');

-- CreateTable
CREATE TABLE "ShopifyStore" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "shopGid" TEXT,
    "shopName" TEXT,
    "currencyCode" TEXT,
    "timezone" TEXT,
    "status" "ShopifyStoreStatus" NOT NULL DEFAULT 'PENDING_INSTALL',
    "apiVersion" TEXT NOT NULL,
    "grantedScopes" TEXT,
    "encAccessToken" TEXT,
    "encRefreshToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "installedAt" TIMESTAMP(3),
    "uninstalledAt" TIMESTAMP(3),
    "oauthState" TEXT,
    "oauthStateExpiresAt" TIMESTAMP(3),
    "clientIdOverride" TEXT,
    "encClientSecretOverride" TEXT,
    "ordersImportEnabled" BOOLEAN NOT NULL DEFAULT true,
    "publishEnabled" BOOLEAN NOT NULL DEFAULT false,
    "publishRule" "ShopifyPublishRule" NOT NULL DEFAULT 'ALL_AVAILABLE',
    "publishLocationId" TEXT,
    "publishLocationName" TEXT,
    "fulfilLocationId" TEXT,
    "fulfilLocationName" TEXT,
    "lastOrderCheckpointAt" TIMESTAMP(3),
    "lastPublishSweepAt" TIMESTAMP(3),
    "lastCatalogSyncAt" TIMESTAMP(3),
    "lastWebhookAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopifyStore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopifyStoreWarehouse" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ShopifyStoreWarehouse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopifyVariantMapping" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "shopifyVariantId" TEXT NOT NULL,
    "shopifyInventoryItemId" TEXT,
    "shopifySku" TEXT,
    "shopifyProductTitle" TEXT,
    "shopifyVariantTitle" TEXT,
    "variantId" TEXT,
    "status" "ShopifyMappingStatus" NOT NULL DEFAULT 'UNMATCHED',
    "matchedBy" "ShopifyMatchedBy",
    "lastPublishedAvailable" INTEGER,
    "lastPublishedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopifyVariantMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopifyWebhookEvent" (
    "id" TEXT NOT NULL,
    "storeId" TEXT,
    "shopDomain" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "eventId" TEXT,
    "topic" TEXT NOT NULL,
    "apiVersion" TEXT,
    "triggeredAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "ShopifyWebhookEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextRetryAt" TIMESTAMP(3),
    "lockedAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "error" TEXT,
    "payload" JSONB NOT NULL,

    CONSTRAINT "ShopifyWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopifySyncLog" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "direction" "ShopifySyncDirection" NOT NULL,
    "entityType" "ShopifySyncEntity" NOT NULL,
    "externalId" TEXT,
    "internalId" TEXT,
    "operation" TEXT NOT NULL,
    "status" "ShopifySyncStatus" NOT NULL,
    "previousValue" TEXT,
    "newValue" TEXT,
    "message" TEXT NOT NULL,
    "errorDetail" TEXT,
    "webhookEventId" TEXT,
    "orderId" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopifySyncLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopifyOutboundJob" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "type" "ShopifyJobType" NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "status" "ShopifyJobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextRetryAt" TIMESTAMP(3),
    "lockedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopifyOutboundJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyStore_shopDomain_key" ON "ShopifyStore"("shopDomain");

-- CreateIndex
CREATE INDEX "ShopifyStore_status_idx" ON "ShopifyStore"("status");

-- CreateIndex
CREATE INDEX "ShopifyStoreWarehouse_warehouseId_idx" ON "ShopifyStoreWarehouse"("warehouseId");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyStoreWarehouse_storeId_warehouseId_key" ON "ShopifyStoreWarehouse"("storeId", "warehouseId");

-- CreateIndex
CREATE INDEX "ShopifyVariantMapping_variantId_idx" ON "ShopifyVariantMapping"("variantId");

-- CreateIndex
CREATE INDEX "ShopifyVariantMapping_storeId_status_idx" ON "ShopifyVariantMapping"("storeId", "status");

-- CreateIndex
CREATE INDEX "ShopifyVariantMapping_storeId_shopifySku_idx" ON "ShopifyVariantMapping"("storeId", "shopifySku");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyVariantMapping_storeId_shopifyVariantId_key" ON "ShopifyVariantMapping"("storeId", "shopifyVariantId");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyWebhookEvent_webhookId_key" ON "ShopifyWebhookEvent"("webhookId");

-- CreateIndex
CREATE INDEX "ShopifyWebhookEvent_storeId_receivedAt_idx" ON "ShopifyWebhookEvent"("storeId", "receivedAt");

-- CreateIndex
CREATE INDEX "ShopifyWebhookEvent_status_nextRetryAt_idx" ON "ShopifyWebhookEvent"("status", "nextRetryAt");

-- CreateIndex
CREATE INDEX "ShopifyWebhookEvent_topic_receivedAt_idx" ON "ShopifyWebhookEvent"("topic", "receivedAt");

-- CreateIndex
CREATE INDEX "ShopifyWebhookEvent_eventId_idx" ON "ShopifyWebhookEvent"("eventId");

-- CreateIndex
CREATE INDEX "ShopifySyncLog_storeId_createdAt_idx" ON "ShopifySyncLog"("storeId", "createdAt");

-- CreateIndex
CREATE INDEX "ShopifySyncLog_status_createdAt_idx" ON "ShopifySyncLog"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ShopifySyncLog_orderId_idx" ON "ShopifySyncLog"("orderId");

-- CreateIndex
CREATE INDEX "ShopifySyncLog_entityType_externalId_idx" ON "ShopifySyncLog"("entityType", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyOutboundJob_dedupeKey_key" ON "ShopifyOutboundJob"("dedupeKey");

-- CreateIndex
CREATE INDEX "ShopifyOutboundJob_status_nextRetryAt_idx" ON "ShopifyOutboundJob"("status", "nextRetryAt");

-- CreateIndex
CREATE INDEX "ShopifyOutboundJob_storeId_type_status_idx" ON "ShopifyOutboundJob"("storeId", "type", "status");

-- AddForeignKey
ALTER TABLE "ShopifyStoreWarehouse" ADD CONSTRAINT "ShopifyStoreWarehouse_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "ShopifyStore"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifyStoreWarehouse" ADD CONSTRAINT "ShopifyStoreWarehouse_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifyVariantMapping" ADD CONSTRAINT "ShopifyVariantMapping_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "ShopifyStore"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifyVariantMapping" ADD CONSTRAINT "ShopifyVariantMapping_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifyWebhookEvent" ADD CONSTRAINT "ShopifyWebhookEvent_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "ShopifyStore"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifySyncLog" ADD CONSTRAINT "ShopifySyncLog_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "ShopifyStore"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifySyncLog" ADD CONSTRAINT "ShopifySyncLog_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifyOutboundJob" ADD CONSTRAINT "ShopifyOutboundJob_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "ShopifyStore"("id") ON DELETE CASCADE ON UPDATE CASCADE;

