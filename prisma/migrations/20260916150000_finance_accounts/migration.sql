-- D-064: payable and receivable are separate accounts; vendor payables are manual allocations against received
-- inventory; 3PL product value is posted at shipment. Existing rows are converted, not deleted.

-- Entry types
ALTER TYPE "LedgerEntryType" RENAME VALUE 'WHOLESALE_VALUE' TO 'PRODUCT_VALUE';
ALTER TYPE "LedgerEntryType" ADD VALUE 'VENDOR_PAYABLE';

-- Accounts
CREATE TYPE "LedgerAccount" AS ENUM ('PAYABLE', 'RECEIVABLE');
CREATE TYPE "LedgerEffect" AS ENUM ('INCREASE', 'DECREASE');

ALTER TABLE "LedgerEntry" ADD COLUMN "account" "LedgerAccount";
ALTER TABLE "LedgerEntry" ADD COLUMN "effect" "LedgerEffect";
ALTER TABLE "LedgerEntry" ADD COLUMN "unitAmount" DECIMAL(12,2);
ALTER TABLE "LedgerEntry" ADD COLUMN "receivingItemId" TEXT;

-- Convert the previous direction semantics: a payment recorded on the "opposite" side settles the other account.
UPDATE "LedgerEntry" SET "account" = 'PAYABLE',    "effect" = 'DECREASE' WHERE "type" = 'PAYMENT' AND "direction" = 'RECEIVABLE_FROM_OWNER';
UPDATE "LedgerEntry" SET "account" = 'RECEIVABLE', "effect" = 'DECREASE' WHERE "type" = 'PAYMENT' AND "direction" = 'PAYABLE_TO_OWNER';
UPDATE "LedgerEntry" SET "account" = 'PAYABLE',    "effect" = 'INCREASE' WHERE "account" IS NULL AND "direction" = 'PAYABLE_TO_OWNER';
UPDATE "LedgerEntry" SET "account" = 'RECEIVABLE', "effect" = 'INCREASE' WHERE "account" IS NULL AND "direction" = 'RECEIVABLE_FROM_OWNER';

ALTER TABLE "LedgerEntry" ALTER COLUMN "account" SET NOT NULL;
ALTER TABLE "LedgerEntry" ALTER COLUMN "effect" SET NOT NULL;
ALTER TABLE "LedgerEntry" DROP COLUMN "direction";
DROP TYPE "LedgerDirection";

CREATE INDEX "LedgerEntry_receivingItemId_idx" ON "LedgerEntry"("receivingItemId");
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_receivingItemId_fkey" FOREIGN KEY ("receivingItemId") REFERENCES "ReceivingItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
