import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { ProductForm } from "@/components/products/product-form";
import { requireRole } from "@/server/auth/guards";
import { stockForVariants } from "@/server/services/inventory";
import { listOwnerOptions } from "@/server/services/owners";
import { getProduct } from "@/server/services/products";

export default async function EditProductPage({ params }: { params: Promise<{ id: string }> }) {
  await requireRole("ADMIN");
  const { id } = await params;
  const [product, vendors, clients] = await Promise.all([getProduct(id), listOwnerOptions("VENDOR"), listOwnerOptions("THREEPL_CLIENT")]);
  if (!product) notFound();
  const stock = await stockForVariants(product.variants.map((v) => v.id));
  const owners = [...vendors.map((o) => ({ ...o, type: "VENDOR" as const })), ...clients.map((o) => ({ ...o, type: "THREEPL_CLIENT" as const }))];
  if (!owners.some((o) => o.id === product.ownerId)) owners.push({ ...product.owner });
  const lockedVariantIds = product.variants.filter((v) => v._count.transactions > 0).map((v) => v.id);
  const inventory = Object.fromEntries(
    product.variants.map((v) => {
      const rows = stock.get(v.id) ?? [];
      return [v.id, { onHand: rows.reduce((s, r) => s + r.onHand, 0), available: rows.reduce((s, r) => s + r.available, 0) }];
    }),
  );

  return (
    <>
      <div>
        <Link href={`/admin/products/${product.id}`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ChevronLeft className="size-4" /> {product.name}
        </Link>
      </div>
      <PageHeader title="Edit product" description={product.name} />
      <div className="max-w-5xl">
        <ProductForm
          owners={owners}
          ownerLocked={lockedVariantIds.length > 0}
          lockedVariantIds={lockedVariantIds}
          inventory={inventory}
          product={{
            id: product.id,
            ownerId: product.ownerId,
            name: product.name,
            category: product.category ?? "",
            description: product.description ?? "",
            notes: product.notes ?? "",
            status: product.status,
            options: product.options,
            variants: product.variants.map((v) => ({
              id: v.id,
              sku: v.sku,
              optionValues: v.optionValues,
              name: v.name ?? "",
              barcode: v.barcode ?? "",
              price: v.price?.toString() ?? "",
              wholesalePrice: v.wholesalePrice?.toString() ?? "",
              cost: v.cost?.toString() ?? "",
              weightGrams: v.weightGrams?.toString() ?? "",
              lengthCm: v.lengthCm?.toString() ?? "",
              widthCm: v.widthCm?.toString() ?? "",
              heightCm: v.heightCm?.toString() ?? "",
              status: v.status,
            })),
          }}
        />
      </div>
    </>
  );
}
