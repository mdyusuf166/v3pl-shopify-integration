-- DropIndex
DROP INDEX "ProductVariant_barcode_idx";

-- CreateIndex
CREATE UNIQUE INDEX "ProductVariant_barcode_key" ON "ProductVariant"("barcode");
