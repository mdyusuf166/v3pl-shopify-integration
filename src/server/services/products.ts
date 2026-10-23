import type { Prisma, ProductStatus } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { variantLabel, type InitialStockValues, type ProductFormValues, type ProductImageInput } from "@/lib/validation/products";
import { recordAudit } from "@/server/services/audit";
import { createReceiving } from "@/server/services/receiving";

/**
 * Products & variants (spec §12, D-003/D-004/D-005, D-053).
 * - Every product has exactly one owner (NOT NULL FK). Ownership can change only while
 *   the product has no stock history (spec §51 "product ownership changes" are audited).
 * - A product carries up to 3 Shopify-style option names; each variant carries one value per
 *   option and its label is derived ("Black / Small"). SKUs are globally unique.
 * - A variant with history can be archived but never deleted; a product can be hard-deleted
 *   only while nothing references its SKUs (D-054).
 */

export type ProductErrorCode = "SKU_TAKEN" | "BARCODE_TAKEN" | "NOT_FOUND" | "OWNER_INVALID" | "OWNER_LOCKED" | "VARIANT_HAS_HISTORY" | "LAST_VARIANT" | "HAS_HISTORY";

export class ProductServiceError extends Error {
  constructor(
    public readonly code: ProductErrorCode,
    message: string,
    public readonly field?: string,
  ) {
    super(message);
  }
}

export const PRODUCT_PAGE_SIZE = 25;

const listSelect = {
  id: true,
  name: true,
  category: true,
  status: true,
  options: true,
  updatedAt: true,
  owner: { select: { id: true, code: true, businessName: true, type: true } },
  variants: {
    select: { id: true, sku: true, name: true, optionValues: true, status: true, price: true, currency: true, balances: { select: { warehouseId: true, onHand: true, reserved: true } } },
    orderBy: { sku: "asc" },
  },
  images: { select: { url: true }, orderBy: { position: "asc" }, take: 1 },
} satisfies Prisma.ProductSelect;

export type ProductListParams = { q?: string; ownerId?: string; status?: ProductStatus | "ALL"; page?: number; pageSize?: number };

export function productWhere(params: ProductListParams): Prisma.ProductWhereInput {
  return {
    ...(params.ownerId ? { ownerId: params.ownerId } : {}),
    ...(params.status && params.status !== "ALL" ? { status: params.status } : {}),
    ...(params.q
      ? {
          OR: [
            { name: { contains: params.q, mode: "insensitive" } },
            { category: { contains: params.q, mode: "insensitive" } },
            { variants: { some: { OR: [{ sku: { contains: params.q, mode: "insensitive" } }, { barcode: { contains: params.q, mode: "insensitive" } }, { name: { contains: params.q, mode: "insensitive" } }] } } },
          ],
        }
      : {}),
  };
}

export async function listProducts(params: ProductListParams) {
  const page = Math.max(1, params.page ?? 1);
  const pageSize = params.pageSize ?? PRODUCT_PAGE_SIZE;
  const where = productWhere(params);
  const [total, items] = await prisma.$transaction([
    prisma.product.count({ where }),
    prisma.product.findMany({ where, orderBy: [{ status: "asc" }, { name: "asc" }], skip: (page - 1) * pageSize, take: pageSize, select: listSelect }),
  ]);
  return { items, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

/** Inventory summary for a list row: totals across warehouses plus how many warehouses hold stock. */
export function inventorySummary(variants: { balances: { warehouseId: string; onHand: number; reserved: number }[] }[]) {
  let onHand = 0;
  let reserved = 0;
  const warehouses = new Set<string>();
  for (const v of variants)
    for (const b of v.balances) {
      onHand += b.onHand;
      reserved += b.reserved;
      if (b.onHand > 0) warehouses.add(b.warehouseId);
    }
  return { onHand, reserved, available: onHand - reserved, warehouses: warehouses.size };
}

/** Full product for the detail/edit pages. `ownerId` lets portal callers enforce scope. */
export async function getProduct(id: string, ownerId?: string) {
  return prisma.product.findFirst({
    where: { id, ...(ownerId ? { ownerId } : {}) },
    include: {
      owner: { select: { id: true, code: true, businessName: true, type: true } },
      variants: { orderBy: [{ isDefault: "desc" }, { sku: "asc" }], include: { _count: { select: { transactions: true } } } },
      images: { orderBy: { position: "asc" } },
    },
  });
}

/** Variant picker: matches SKU / barcode / product name; active variants only. */
export async function searchVariants(q: string, opts: { ownerId?: string; limit?: number } = {}) {
  const term = q.trim();
  if (term.length < 1) return [];
  return prisma.productVariant.findMany({
    where: {
      status: "ACTIVE",
      product: { status: "ACTIVE", ...(opts.ownerId ? { ownerId: opts.ownerId } : {}) },
      OR: [{ sku: { contains: term, mode: "insensitive" } }, { barcode: { contains: term, mode: "insensitive" } }, { product: { name: { contains: term, mode: "insensitive" } } }],
    },
    take: opts.limit ?? 20,
    orderBy: { sku: "asc" },
    select: { id: true, sku: true, name: true, barcode: true, price: true, currency: true, product: { select: { id: true, name: true, ownerId: true, owner: { select: { code: true, businessName: true } } } } },
  });
}

/** Normalised option names / values for storage: trimmed, aligned to the option count. */
function normaliseOptions(values: ProductFormValues) {
  const options = (values.options ?? []).map((o) => o.trim()).filter(Boolean);
  const variantValues = (v: ProductFormValues["variants"][number]) => (options.length ? options.map((_, j) => (v.optionValues?.[j] ?? "").trim()) : []);
  return { options, variantValues };
}

function variantData(v: ProductFormValues["variants"][number], optionValues: string[]) {
  return {
    sku: v.sku,
    optionValues,
    name: variantLabel({ optionValues, name: v.name }),
    barcode: v.barcode ?? null,
    price: v.price ?? null,
    wholesalePrice: v.wholesalePrice ?? null,
    cost: v.cost ?? null,
    weightGrams: v.weightGrams ?? null,
    lengthCm: v.lengthCm ?? null,
    widthCm: v.widthCm ?? null,
    heightCm: v.heightCm ?? null,
    status: v.status,
  };
}

export async function createProduct(values: ProductFormValues, actorId: string) {
  const owner = await prisma.owner.findUnique({ where: { id: values.ownerId }, select: { id: true, status: true } });
  if (!owner) throw new ProductServiceError("OWNER_INVALID", "The selected vendor / 3PL client does not exist.", "ownerId");
  if (owner.status !== "ACTIVE") throw new ProductServiceError("OWNER_INVALID", "Cannot add products to an inactive vendor / 3PL client.", "ownerId");
  await assertSkusFree(values.variants.map((v) => v.sku));
  await assertBarcodesFree(values.variants.map((v) => v.barcode));
  const { options, variantValues } = normaliseOptions(values);

  return withUniqueErrors(() => prisma.$transaction(async (tx) => {
    const product = await tx.product.create({
      data: {
        ownerId: values.ownerId,
        name: values.name,
        category: values.category ?? null,
        description: values.description ?? null,
        notes: values.notes ?? null,
        status: values.status,
        options,
        variants: {
          create: values.variants.map((v, i) => ({ ...variantData(v, variantValues(v)), isDefault: i === 0 && values.variants.length === 1 })),
        },
      },
      include: { variants: { select: { id: true, sku: true, name: true, optionValues: true } } },
    });
    await recordAudit({ userId: actorId, action: "product.created", entityType: "Product", entityId: product.id, newValues: { ...values, options, variants: values.variants.map((v) => v.sku) } }, tx);
    return product;
  }));
}

export type InitialStockResult = { receivingId: string; units: number; lines: number } | null;

/**
 * Create a product and, optionally, receive its initial stock (D-058). Quantities come from the
 * variants' `initialQuantity`; lines with no quantity are skipped. Stock goes through the normal
 * receiving service (receipt + RECEIVE ledger rows + audit, with user, warehouse, location, time and
 * reference "Initial stock"), never through a direct balance write. If the receipt is refused (e.g.
 * inactive warehouse or location of another warehouse) the just-created product — which has no
 * history yet — is removed again so the operation is all-or-nothing from the user's point of view.
 */
export async function createProductWithInitialStock(values: ProductFormValues, stock: InitialStockValues | null, actorId: string) {
  const wanted = values.variants.filter((v) => (v.initialQuantity ?? 0) > 0);
  if (wanted.length > 0 && !stock) throw new ProductServiceError("OWNER_INVALID", "Choose the warehouse and location for the initial stock.", "initialStock.warehouseId");
  const product = await createProduct(values, actorId);
  if (wanted.length === 0 || !stock) return { product, stock: null as InitialStockResult };
  const idBySku = new Map(product.variants.map((v) => [v.sku, v.id]));
  const lines = wanted.map((v) => ({ variantId: idBySku.get(v.sku)!, locationId: stock.locationId, quantity: v.initialQuantity! }));
  try {
    const receipt = await createReceiving({ ownerId: values.ownerId, warehouseId: stock.warehouseId, reference: "Initial stock", notes: `Initial inventory entered when the product "${values.name}" was created`, lines }, actorId);
    return { product, stock: { receivingId: receipt.id, units: lines.reduce((s, l) => s + l.quantity, 0), lines: lines.length } as InitialStockResult };
  } catch (err) {
    await deleteProduct(product.id, actorId).catch(() => undefined); // compensate: nothing referenced the product yet
    throw err;
  }
}

export async function updateProduct(id: string, values: ProductFormValues, actorId: string) {
  const current = await prisma.product.findUnique({ where: { id }, include: { variants: { include: { _count: { select: { transactions: true, levels: true, orderItems: true } } } } } });
  if (!current) throw new ProductServiceError("NOT_FOUND", "Product not found.");

  if (values.ownerId !== current.ownerId) {
    const history = await prisma.inventoryTransaction.count({ where: { variant: { productId: id } } });
    if (history > 0) throw new ProductServiceError("OWNER_LOCKED", "This product already has inventory history; its owner cannot be changed.", "ownerId");
    const owner = await prisma.owner.findUnique({ where: { id: values.ownerId }, select: { id: true, status: true } });
    if (!owner || owner.status !== "ACTIVE") throw new ProductServiceError("OWNER_INVALID", "The selected vendor / 3PL client is not available.", "ownerId");
  }

  const incomingIds = new Set(values.variants.map((v) => v.id).filter((x): x is string => !!x));
  const removed = current.variants.filter((v) => !incomingIds.has(v.id));
  for (const v of removed) {
    if (v._count.transactions > 0 || v._count.levels > 0 || v._count.orderItems > 0) {
      throw new ProductServiceError("VARIANT_HAS_HISTORY", `SKU ${v.sku} has inventory or order history and cannot be removed — archive it instead.`, "variants");
    }
  }
  const newSkus = values.variants.filter((v) => !v.id || current.variants.find((c) => c.id === v.id)?.sku !== v.sku).map((v) => v.sku);
  await assertSkusFree(newSkus, id);
  await assertBarcodesFree(values.variants.map((v) => v.barcode), id);
  const { options, variantValues } = normaliseOptions(values);

  return withUniqueErrors(() => prisma.$transaction(async (tx) => {
    const product = await tx.product.update({
      where: { id },
      data: { ownerId: values.ownerId, name: values.name, category: values.category ?? null, description: values.description ?? null, notes: values.notes ?? null, status: values.status, options },
    });
    for (const v of removed) await tx.productVariant.delete({ where: { id: v.id } });
    for (const [i, v] of values.variants.entries()) {
      const data = { ...variantData(v, variantValues(v)), isDefault: values.variants.length === 1 && i === 0 };
      if (v.id && current.variants.some((c) => c.id === v.id)) await tx.productVariant.update({ where: { id: v.id }, data });
      else await tx.productVariant.create({ data: { ...data, productId: id } });
    }
    await recordAudit(
      {
        userId: actorId,
        action: values.ownerId !== current.ownerId ? "product.owner_changed" : "product.updated",
        entityType: "Product",
        entityId: id,
        oldValues: { ownerId: current.ownerId, name: current.name, status: current.status, options: current.options, variants: current.variants.map((v) => v.sku) },
        newValues: { ownerId: values.ownerId, name: values.name, status: values.status, options, variants: values.variants.map((v) => v.sku) },
      },
      tx,
    );
    return product;
  }));
}

export async function setProductStatus(id: string, status: ProductStatus, actorId: string) {
  const current = await prisma.product.findUnique({ where: { id }, select: { id: true, status: true } });
  if (!current) throw new ProductServiceError("NOT_FOUND", "Product not found.");
  if (current.status === status) return current;
  return prisma.$transaction(async (tx) => {
    const product = await tx.product.update({ where: { id }, data: { status } });
    await recordAudit({ userId: actorId, action: status === "ACTIVE" ? "product.reactivated" : "product.archived", entityType: "Product", entityId: id, oldValues: { status: current.status }, newValues: { status } }, tx);
    return product;
  });
}

// --- Shopify store conflicts (D-057, QA SKU-03) -----------------------------

export type SkuStoreConflict = {
  sku: string;
  storeId: string;
  storeName: string;
  /** MATCHED = Shopify SKU already mapped to a V3PL variant (`mappedSku`); UNMATCHED/CONFLICT = present in the store, not mapped. */
  mappingStatus: "MATCHED" | "UNMATCHED" | "CONFLICT" | "IGNORED";
  /** Internal SKU the Shopify variant is currently mapped to, when different from `sku`. */
  mappedSku: string | null;
  shopifyProductTitle: string | null;
};

/**
 * Where each SKU already exists in a *connected* Shopify store (read-only; mappings are never changed
 * here). Rows whose mapping already points at a variant of `exceptProductId` are not conflicts — that
 * is the normal one SKU → one store situation for the product being edited.
 */
export async function skuStoreConflicts(skus: string[], exceptProductId?: string): Promise<SkuStoreConflict[]> {
  const wanted = [...new Set(skus.map((s) => s.trim().toUpperCase()).filter(Boolean))];
  if (wanted.length === 0) return [];
  const rows = await prisma.shopifyVariantMapping.findMany({
    where: { shopifySku: { in: wanted, mode: "insensitive" }, store: { status: "CONNECTED" } },
    select: { shopifySku: true, status: true, shopifyProductTitle: true, store: { select: { id: true, name: true } }, variant: { select: { sku: true, productId: true } } },
  });
  return rows
    .filter((r) => !(exceptProductId && r.variant?.productId === exceptProductId))
    .map((r) => ({
      sku: (r.shopifySku ?? "").toUpperCase(),
      storeId: r.store.id,
      storeName: r.store.name,
      mappingStatus: r.status,
      mappedSku: r.variant && r.variant.sku.toUpperCase() !== (r.shopifySku ?? "").toUpperCase() ? r.variant.sku : null,
      shopifyProductTitle: r.shopifyProductTitle,
    }));
}

/** Human-readable warnings per SKU (one SKU → one store is the normal rule). */
export function describeSkuStoreConflicts(conflicts: SkuStoreConflict[]): Record<string, string[]> {
  const bySku = new Map<string, SkuStoreConflict[]>();
  for (const c of conflicts) (bySku.get(c.sku) ?? bySku.set(c.sku, []).get(c.sku)!).push(c);
  const out: Record<string, string[]> = {};
  for (const [sku, list] of bySku) {
    const stores = [...new Set(list.map((c) => c.storeName))];
    const msgs: string[] = [];
    for (const c of list) {
      if (c.mappingStatus === "MATCHED") msgs.push(`${sku} is already mapped in Shopify store “${c.storeName}”${c.mappedSku ? ` to V3PL SKU ${c.mappedSku}` : ""} — the existing mapping is kept; saving will not re-map it.`);
      else msgs.push(`${sku} already exists as a Shopify SKU in store “${c.storeName}” (${c.shopifyProductTitle ?? "unmapped"}); it will match on the next catalog sync.`);
    }
    if (stores.length > 1) msgs.push(`${sku} appears in ${stores.length} connected stores (${stores.join(", ")}) — the normal rule is one SKU → one store.`);
    out[sku] = msgs;
  }
  return out;
}

// --- Deletion (D-054) -------------------------------------------------------

export type ProductDeleteCheck = { canDelete: boolean; blockers: string[] };

/**
 * A product can be hard-deleted only while none of its SKUs appears in the ledger, on stock
 * levels, orders, receipts, transfers, returns or a Shopify mapping. Otherwise: archive.
 */
export async function productDeleteCheck(id: string): Promise<ProductDeleteCheck> {
  const variants = await prisma.productVariant.findMany({
    where: { productId: id },
    select: { sku: true, _count: { select: { transactions: true, levels: true, balances: true, orderItems: true, receivingItems: true, transferItems: true, returnItems: true, shopifyMappings: { where: { status: "MATCHED" } } } } },
  });
  const blockers: string[] = [];
  const sum = (k: keyof (typeof variants)[number]["_count"]) => variants.reduce((s, v) => s + v._count[k], 0);
  if (sum("transactions") > 0) blockers.push("Has inventory history (ledger entries)");
  if (sum("levels") + sum("balances") > 0 && sum("transactions") === 0) blockers.push("Has stock records");
  if (sum("orderItems") > 0) blockers.push(`Used on ${sum("orderItems")} order line${sum("orderItems") === 1 ? "" : "s"}`);
  if (sum("receivingItems") > 0) blockers.push("Appears on receiving records");
  if (sum("transferItems") > 0) blockers.push("Appears on transfers");
  if (sum("returnItems") > 0) blockers.push("Appears on returns");
  if (sum("shopifyMappings") > 0) blockers.push("Mapped to a Shopify variant");
  return { canDelete: blockers.length === 0, blockers };
}

/** Hard-deletes a product with no history. Returns the Cloudinary public ids to destroy afterwards. */
export async function deleteProduct(id: string, actorId: string): Promise<{ name: string; imagePublicIds: string[] }> {
  const product = await prisma.product.findUnique({ where: { id }, select: { id: true, name: true, ownerId: true, images: { select: { cloudinaryPublicId: true } }, variants: { select: { id: true, sku: true } } } });
  if (!product) throw new ProductServiceError("NOT_FOUND", "Product not found.");
  const check = await productDeleteCheck(id);
  if (!check.canDelete) throw new ProductServiceError("HAS_HISTORY", `${product.name} cannot be deleted: ${check.blockers.join("; ")}. Archive it instead.`);
  await prisma.$transaction(async (tx) => {
    await tx.productImage.deleteMany({ where: { productId: id } });
    await tx.shopifyVariantMapping.updateMany({ where: { variantId: { in: product.variants.map((v) => v.id) } }, data: { variantId: null, status: "UNMATCHED", matchedBy: null } });
    await tx.productVariant.deleteMany({ where: { productId: id } });
    await tx.product.delete({ where: { id } });
    await recordAudit({ userId: actorId, action: "product.deleted", entityType: "Product", entityId: id, oldValues: { name: product.name, ownerId: product.ownerId, variants: product.variants.map((v) => v.sku) } }, tx);
  });
  return { name: product.name, imagePublicIds: product.images.map((i) => i.cloudinaryPublicId) };
}

// --- Images -----------------------------------------------------------------

export async function addProductImage(input: ProductImageInput & { alt?: string | null }, actorId: string) {
  const product = await prisma.product.findUnique({ where: { id: input.productId }, select: { id: true, _count: { select: { images: true } } } });
  if (!product) throw new ProductServiceError("NOT_FOUND", "Product not found.");
  return prisma.$transaction(async (tx) => {
    const image = await tx.productImage.create({
      data: {
        productId: input.productId,
        variantId: input.variantId ?? null,
        cloudinaryPublicId: input.cloudinaryPublicId,
        url: input.url,
        width: input.width ?? null,
        height: input.height ?? null,
        alt: input.alt ?? null,
        position: product._count.images,
      },
    });
    await recordAudit({ userId: actorId, action: "product.image_added", entityType: "Product", entityId: input.productId, newValues: { imageId: image.id, publicId: input.cloudinaryPublicId } }, tx);
    return image;
  });
}

/** Removes the DB row; the caller deletes the Cloudinary asset afterwards (best effort). */
export async function removeProductImage(imageId: string, actorId: string) {
  const image = await prisma.productImage.findUnique({ where: { id: imageId } });
  if (!image) throw new ProductServiceError("NOT_FOUND", "Image not found.");
  await prisma.$transaction(async (tx) => {
    await tx.productImage.delete({ where: { id: imageId } });
    await recordAudit({ userId: actorId, action: "product.image_removed", entityType: "Product", entityId: image.productId, oldValues: { imageId, publicId: image.cloudinaryPublicId } }, tx);
  });
  return image;
}

/**
 * Barcodes are globally unique like SKUs (D-059). Checked before the write for a clear message and
 * guaranteed by the database unique index (`withUniqueErrors` maps a race to the same error).
 */
async function assertBarcodesFree(barcodes: (string | null | undefined)[], exceptProductId?: string) {
  const wanted = [...new Set(barcodes.filter((b): b is string => !!b))];
  if (wanted.length === 0) return;
  const clash = await prisma.productVariant.findFirst({
    where: { barcode: { in: wanted }, ...(exceptProductId ? { productId: { not: exceptProductId } } : {}) },
    select: { barcode: true, sku: true, product: { select: { name: true, owner: { select: { businessName: true } } } } },
  });
  if (clash) {
    throw new ProductServiceError("BARCODE_TAKEN", `Barcode ${clash.barcode} is already used by SKU ${clash.sku} ("${clash.product.name}", ${clash.product.owner.businessName}). Barcodes are unique across the platform.`, "variants");
  }
}

/** Translate a unique-constraint violation raced past the pre-checks into the service's own error. */
async function withUniqueErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const e = err as { code?: string; meta?: unknown; message?: string };
    if (e.code === "P2002") {
      // Prisma reports the violated constraint either in meta.target (classic engine) or in
      // meta.driverAdapterError.cause.constraint.index / the message (driver adapters, Prisma 7).
      const where = `${JSON.stringify(e.meta ?? {})} ${e.message ?? ""}`;
      if (/barcode/i.test(where)) throw new ProductServiceError("BARCODE_TAKEN", "That barcode is already used by another variant. Barcodes are unique across the platform.", "variants");
      if (/sku/i.test(where)) throw new ProductServiceError("SKU_TAKEN", "That SKU is already used by another variant. SKUs are unique across the platform.", "variants");
    }
    throw err;
  }
}

async function assertSkusFree(skus: string[], exceptProductId?: string) {
  if (skus.length === 0) return;
  const clash = await prisma.productVariant.findFirst({
    where: { sku: { in: skus }, ...(exceptProductId ? { productId: { not: exceptProductId } } : {}) },
    select: { sku: true, product: { select: { name: true, owner: { select: { businessName: true } } } } },
  });
  if (clash) {
    throw new ProductServiceError("SKU_TAKEN", `SKU ${clash.sku} already belongs to "${clash.product.name}" (${clash.product.owner.businessName}). SKUs are unique across the platform.`, "variants");
  }
}
