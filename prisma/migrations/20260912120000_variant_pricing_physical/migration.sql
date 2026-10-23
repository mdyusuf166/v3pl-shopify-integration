-- AlterTable
ALTER TABLE "ProductVariant" ADD COLUMN     "heightCm" DECIMAL(8,2),
ADD COLUMN     "lengthCm" DECIMAL(8,2),
ADD COLUMN     "weightGrams" INTEGER,
ADD COLUMN     "wholesalePrice" DECIMAL(12,2),
ADD COLUMN     "widthCm" DECIMAL(8,2);
