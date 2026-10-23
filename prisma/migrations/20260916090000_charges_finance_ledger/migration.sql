-- CreateEnum
CREATE TYPE "ChargeType" AS ENUM ('PICKING', 'PACKING', 'SHIPPING', 'STORAGE', 'FULFILLMENT', 'SERVICE', 'UTILITY', 'OTHER');

-- CreateEnum
CREATE TYPE "ChargeBasis" AS ENUM ('PER_ORDER', 'PER_SHIPMENT', 'PER_UNIT');

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('WHOLESALE_VALUE', 'CHARGE', 'PAYMENT', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "LedgerDirection" AS ENUM ('PAYABLE_TO_OWNER', 'RECEIVABLE_FROM_OWNER');

-- AlterTable
ALTER TABLE "Owner" ADD COLUMN     "chargesEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ChargeRule" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "chargeType" "ChargeType" NOT NULL,
    "basis" "ChargeBasis" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "ownerId" TEXT,
    "ownerType" "OwnerType",
    "minWeightGrams" INTEGER,
    "maxWeightGrams" INTEGER,
    "minLongestCm" DECIMAL(8,2),
    "maxLongestCm" DECIMAL(8,2),
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChargeRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Charge" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "ruleId" TEXT,
    "chargeType" "ChargeType" NOT NULL,
    "basis" "ChargeBasis" NOT NULL,
    "ruleName" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitAmount" DECIMAL(12,2) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "reason" TEXT NOT NULL,
    "orderId" TEXT,
    "shipmentId" TEXT,
    "orderItemId" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Charge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "type" "LedgerEntryType" NOT NULL,
    "direction" "LedgerDirection" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "quantity" INTEGER,
    "orderId" TEXT,
    "shipmentId" TEXT,
    "chargeId" TEXT,
    "reference" TEXT,
    "description" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChargeRule_active_chargeType_idx" ON "ChargeRule"("active", "chargeType");

-- CreateIndex
CREATE INDEX "ChargeRule_ownerId_idx" ON "ChargeRule"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "Charge_dedupeKey_key" ON "Charge"("dedupeKey");

-- CreateIndex
CREATE INDEX "Charge_ownerId_createdAt_idx" ON "Charge"("ownerId", "createdAt");

-- CreateIndex
CREATE INDEX "Charge_shipmentId_idx" ON "Charge"("shipmentId");

-- CreateIndex
CREATE INDEX "Charge_orderId_idx" ON "Charge"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntry_chargeId_key" ON "LedgerEntry"("chargeId");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntry_dedupeKey_key" ON "LedgerEntry"("dedupeKey");

-- CreateIndex
CREATE INDEX "LedgerEntry_ownerId_occurredAt_idx" ON "LedgerEntry"("ownerId", "occurredAt");

-- CreateIndex
CREATE INDEX "LedgerEntry_ownerId_type_idx" ON "LedgerEntry"("ownerId", "type");

-- AddForeignKey
ALTER TABLE "ChargeRule" ADD CONSTRAINT "ChargeRule_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Owner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Charge" ADD CONSTRAINT "Charge_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Owner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Charge" ADD CONSTRAINT "Charge_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "ChargeRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Charge" ADD CONSTRAINT "Charge_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Charge" ADD CONSTRAINT "Charge_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Owner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_chargeId_fkey" FOREIGN KEY ("chargeId") REFERENCES "Charge"("id") ON DELETE SET NULL ON UPDATE CASCADE;
