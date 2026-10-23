import { prisma } from "@/lib/prisma";
import { productFormSchema, skuSchema, type ProductFormValues } from "@/lib/validation/products";
import { ProductServiceError, createProductWithInitialStock } from "@/server/services/products";
import { storeGraphql } from "./api";
import { normalizeSku } from "./catalog-match";
import { PRODUCT_WITH_VARIANTS_QUERY, type ProductWithVariants } from "./queries";
import { describeError, logSync } from "./sync-log";

/**
 * Explicit import of UNMATCHED Shopify products into V3PL (Step 2, approved flow):
 *   select unmatched variants → choose owner → Preview (grouped per Shopify product, owner
 *   editable per product, row-level errors) → Confirm → core createProductWithInitialStock().
 * Nothing is created outside this flow. Inventory (D-067): the import is data-only unless Admin enters an
 * initial quantity per SKU AND chooses the V3PL destination (warehouse + location); those quantities are
 * booked as ONE receipt per product through the core initial-stock contract (D-058), never by a direct
 * balance write. Shopify's own quantity is only shown as a reference — a Shopify location is never a V3PL
 * warehouse. Stateless: the preview is recomputed at confirm time.
 */

export const IMPORT_MAX_PRODUCTS = 50;

export type ImportVariantPreview = {
  mappingId: string;
  shopifyVariantId: string;
  shopifySku: string | null;
  sku: string;
  name: string | null;
  barcode: string | null;
  price: string | null;
  /** Shopify's total sellable quantity (reference only; the Admin decides what V3PL books). */
  shopifyQuantity: number | null;
  error: string | null;
};

export type ImportProductPreview = {
  shopifyProductId: string;
  title: string;
  ownerId: string;
  ownerLabel: string;
  variants: ImportVariantPreview[];
  errors: string[];
  ok: boolean;
};

export type ImportPreview = { products: ImportProductPreview[]; skipped: { mappingId: string; reason: string }[] };

export type ImportConfirmItem = { shopifyProductId: string; ownerId: string; mappingIds: string[]; quantities?: Record<string, number> };
/** V3PL warehouse + location that receives the initial stock (D-067). */
export type ImportDestination = { warehouseId: string; locationId: string };

async function ownerLabel(ownerId: string): Promise<{ label: string; ok: boolean }> {
  const o = await prisma.owner.findUnique({ where: { id: ownerId }, select: { businessName: true, code: true, status: true } });
  if (!o) return { label: "unknown owner", ok: false };
  return { label: `${o.businessName} (${o.code})`, ok: o.status === "ACTIVE" };
}

export async function previewImport(storeId: string, mappingIds: string[], ownerId: string, ownerOverrides: Record<string, string> = {}): Promise<ImportPreview> {
  const ids = [...new Set(mappingIds)];
  const rows = await prisma.shopifyVariantMapping.findMany({ where: { storeId, id: { in: ids } }, select: { id: true, shopifyProductId: true, shopifyVariantId: true, shopifySku: true, shopifyProductTitle: true, status: true } });
  const skipped: ImportPreview["skipped"] = [];
  const found = new Set(rows.map((r) => r.id));
  for (const id of ids) if (!found.has(id)) skipped.push({ mappingId: id, reason: "Not found in this store" });
  const eligible = rows.filter((r) => {
    if (r.status === "UNMATCHED") return true;
    skipped.push({ mappingId: r.id, reason: r.status === "MATCHED" ? "Already mapped to a V3PL SKU" : r.status === "CONFLICT" ? "SKU conflict — resolve in Shopify first" : "Ignored" });
    return false;
  });

  const byProduct = new Map<string, typeof eligible>();
  for (const r of eligible) {
    const g = byProduct.get(r.shopifyProductId);
    if (g) g.push(r);
    else byProduct.set(r.shopifyProductId, [r]);
  }
  const productIds = [...byProduct.keys()].slice(0, IMPORT_MAX_PRODUCTS);
  for (const pid of [...byProduct.keys()].slice(IMPORT_MAX_PRODUCTS)) for (const r of byProduct.get(pid)!) skipped.push({ mappingId: r.id, reason: `More than ${IMPORT_MAX_PRODUCTS} products selected — import in batches` });

  const allSkus = new Map<string, number>();
  const products: ImportProductPreview[] = [];
  const ownerCache = new Map<string, { label: string; ok: boolean }>();
  for (const pid of productIds) {
    const selected = byProduct.get(pid)!;
    const oid = ownerOverrides[pid] ?? ownerId;
    if (!ownerCache.has(oid)) ownerCache.set(oid, await ownerLabel(oid));
    const owner = ownerCache.get(oid)!;
    const errors: string[] = [];
    if (!owner.ok) errors.push(`Owner ${owner.label} is not an active vendor / 3PL client`);

    let live: ProductWithVariants["product"] = null;
    try {
      live = (await storeGraphql<ProductWithVariants>(storeId, PRODUCT_WITH_VARIANTS_QUERY, { id: pid })).product;
    } catch (err) {
      errors.push(`Could not read the product from Shopify: ${describeError(err)}`);
    }
    if (!live && errors.length === 0) errors.push("Product no longer exists in Shopify");
    const liveById = new Map((live?.variants.nodes ?? []).map((n) => [n.id, n]));

    const variants: ImportVariantPreview[] = selected.map((r) => {
      const n = liveById.get(r.shopifyVariantId);
      const sku = normalizeSku(n?.sku ?? r.shopifySku);
      let error: string | null = null;
      if (!n && live) error = "Variant no longer exists in Shopify";
      else if (!sku) error = "Shopify variant has no SKU";
      else {
        const parsed = skuSchema.safeParse(sku);
        if (!parsed.success) error = parsed.error.issues[0]?.message ?? "Invalid SKU";
        else {
          const count = (allSkus.get(sku) ?? 0) + 1;
          allSkus.set(sku, count);
          if (count > 1) error = `SKU ${sku} selected more than once`;
        }
      }
      return { mappingId: r.id, shopifyVariantId: r.shopifyVariantId, shopifySku: n?.sku ?? r.shopifySku, sku, name: n?.title && n.title !== "Default Title" ? n.title : null, barcode: n?.barcode ?? null, price: n?.price ?? null, shopifyQuantity: typeof n?.inventoryQuantity === "number" ? n.inventoryQuantity : null, error };
    });
    products.push({ shopifyProductId: pid, title: live?.title ?? selected[0].shopifyProductTitle ?? "Untitled product", ownerId: oid, ownerLabel: owner.label, variants, errors, ok: false });
  }

  // SKUs already in V3PL (any owner): the SKU is the identity, so an existing SKU cannot be imported.
  const candidateSkus = products.flatMap((p) => p.variants.filter((v) => !v.error).map((v) => v.sku));
  if (candidateSkus.length) {
    const taken = await prisma.productVariant.findMany({ where: { sku: { in: candidateSkus } }, select: { sku: true, product: { select: { name: true, owner: { select: { businessName: true } } } } } });
    const takenBySku = new Map(taken.map((t) => [t.sku, t]));
    for (const p of products) for (const v of p.variants) {
      const t = !v.error ? takenBySku.get(v.sku) : undefined;
      if (t) v.error = `SKU ${v.sku} already belongs to “${t.product.name}” (${t.product.owner.businessName}) — map it instead of importing`;
    }
  }
  for (const p of products) p.ok = p.errors.length === 0 && p.variants.length > 0 && p.variants.every((v) => !v.error);
  return { products, skipped };
}

function toProductValues(p: ImportProductPreview, quantities: Record<string, number> = {}): ProductFormValues | { error: string } {
  const parsed = productFormSchema.safeParse({
    ownerId: p.ownerId,
    name: p.title,
    category: null,
    description: null,
    notes: `Imported from Shopify (${p.shopifyProductId})`,
    status: "ACTIVE",
    variants: p.variants.map((v) => ({ sku: v.sku, name: v.name, barcode: v.barcode, price: v.price, cost: null, status: "ACTIVE", initialQuantity: quantities[v.mappingId] ?? null })),
  });
  if (!parsed.success) return { error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  return parsed.data;
}

export type ImportResult = {
  created: { shopifyProductId: string; title: string; productId: string; skus: string[]; stock: { units: number; lines: number } | null }[];
  failed: { shopifyProductId: string; title: string; error: string }[];
  /** Where the initial stock went (null = data-only import). */
  destination: { warehouseId: string; warehouseLabel: string; locationId: string; locationLabel: string } | null;
};

/**
 * The destination must be an ACTIVE warehouse and an active location of THAT warehouse — checked once here so a
 * wrong choice is reported per product instead of creating products whose receipt is then refused.
 */
async function resolveDestination(dest: ImportDestination | null): Promise<{ ok: ImportResult["destination"]; error: string | null }> {
  if (!dest) return { ok: null, error: null };
  const wh = await prisma.warehouse.findUnique({ where: { id: dest.warehouseId }, select: { id: true, code: true, name: true, status: true } });
  if (!wh || wh.status !== "ACTIVE") return { ok: null, error: "Choose an active V3PL warehouse for the initial stock." };
  const loc = await prisma.location.findUnique({ where: { id: dest.locationId }, select: { id: true, label: true, isActive: true, warehouseId: true } });
  if (!loc || !loc.isActive || loc.warehouseId !== wh.id) return { ok: null, error: `Choose an active location inside warehouse ${wh.code}.` };
  return { ok: { warehouseId: wh.id, warehouseLabel: `${wh.code} — ${wh.name}`, locationId: loc.id, locationLabel: loc.label }, error: null };
}

/**
 * Re-validates each selected product and creates it through the core product service. Quantities > 0 are booked
 * into `destination` by the core initial-stock contract (one receipt per product, RECEIVE ledger rows); without
 * quantities the import stays data-only whatever the destination. A product with quantities but no valid
 * destination is refused (nothing created) — stock is never put somewhere the Admin did not choose.
 */
export async function confirmImport(storeId: string, items: ImportConfirmItem[], actorId: string, destination: ImportDestination | null = null): Promise<ImportResult> {
  const dest = await resolveDestination(destination);
  const result: ImportResult = { created: [], failed: [], destination: dest.ok };
  for (const item of items.slice(0, IMPORT_MAX_PRODUCTS)) {
    const quantities = Object.fromEntries(Object.entries(item.quantities ?? {}).filter(([, q]) => Number.isInteger(q) && q > 0));
    const wantsStock = Object.keys(quantities).length > 0;
    const preview = await previewImport(storeId, item.mappingIds, item.ownerId);
    const p = preview.products.find((x) => x.shopifyProductId === item.shopifyProductId);
    if (!p) {
      result.failed.push({ shopifyProductId: item.shopifyProductId, title: item.shopifyProductId, error: "Nothing importable selected for this product" });
      continue;
    }
    if (!p.ok) {
      const error = [...p.errors, ...p.variants.filter((v) => v.error).map((v) => `${v.sku || v.shopifySku || "?"}: ${v.error}`)].join("; ");
      result.failed.push({ shopifyProductId: p.shopifyProductId, title: p.title, error });
      continue;
    }
    if (wantsStock && !dest.ok) {
      result.failed.push({ shopifyProductId: p.shopifyProductId, title: p.title, error: dest.error ?? "Choose the V3PL warehouse and location that receive the initial stock." });
      continue;
    }
    const values = toProductValues(p, quantities);
    if ("error" in values) {
      result.failed.push({ shopifyProductId: p.shopifyProductId, title: p.title, error: values.error });
      continue;
    }
    try {
      const { product, stock } = await createProductWithInitialStock(values, wantsStock && dest.ok ? { warehouseId: dest.ok.warehouseId, locationId: dest.ok.locationId } : null, actorId);
      const bySku = new Map(product.variants.map((v) => [v.sku, v.id]));
      for (const v of p.variants) {
        const variantId = bySku.get(v.sku);
        if (!variantId) continue;
        try {
          await prisma.shopifyVariantMapping.update({ where: { id: v.mappingId }, data: { status: "MATCHED", matchedBy: "SKU_EXACT", variantId } });
        } catch (err) {
          if ((err as { code?: string }).code !== "P2002") throw err;
          await prisma.shopifyVariantMapping.update({ where: { id: v.mappingId }, data: { status: "CONFLICT", matchedBy: null, variantId: null } });
        }
      }
      const stockNote = stock && dest.ok ? `; ${stock.units} unit${stock.units === 1 ? "" : "s"} received into ${dest.ok.warehouseLabel} / ${dest.ok.locationLabel} (initial stock)` : "";
      await logSync({ storeId, direction: "INBOUND", entityType: "PRODUCT", operation: "import", status: "SUCCESS", message: `Imported “${p.title}” (${p.variants.length} SKU${p.variants.length === 1 ? "" : "s"}) into V3PL for ${p.ownerLabel}${stockNote}`, externalId: p.shopifyProductId, internalId: product.id });
      result.created.push({ shopifyProductId: p.shopifyProductId, title: p.title, productId: product.id, skus: p.variants.map((v) => v.sku), stock: stock ? { units: stock.units, lines: stock.lines } : null });
    } catch (err) {
      const error = err instanceof ProductServiceError ? err.message : describeError(err);
      await logSync({ storeId, direction: "INBOUND", entityType: "PRODUCT", operation: "import", status: "FAILED", message: `Import of “${p.title}” failed`, errorDetail: error, externalId: p.shopifyProductId });
      result.failed.push({ shopifyProductId: p.shopifyProductId, title: p.title, error });
    }
  }
  return result;
}
