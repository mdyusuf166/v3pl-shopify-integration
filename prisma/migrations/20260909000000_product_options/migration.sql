-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "options" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "ProductVariant" ADD COLUMN     "optionValues" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Backfill (D-053): variants that already carry a free-text label become a one-option product
-- ("Variant" → label) so existing catalogues keep their names and round-trip through Shopify CSV.
UPDATE "ProductVariant" SET "optionValues" = ARRAY["name"] WHERE "name" IS NOT NULL AND btrim("name") <> '';
UPDATE "Product" p SET "options" = ARRAY['Variant']
WHERE EXISTS (SELECT 1 FROM "ProductVariant" v WHERE v."productId" = p.id AND v."name" IS NOT NULL AND btrim(v."name") <> '');
