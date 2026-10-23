import type { Prisma } from "@/generated/prisma/client";
import { normalizeHeader, parseCsv, toCsv, type CsvRow } from "@/lib/csv";
import { prisma } from "@/lib/prisma";
import { productFormSchema, skuSchema, variantLabel, type ProductExportFilters, type ProductFormValues, type ProductImportOptions } from "@/lib/validation/products";
import { createProduct, productWhere, updateProduct } from "@/server/services/products";
import { createReceiving } from "@/server/services/receiving";
import { getDefaultLocation } from "@/server/services/warehouses";

/**
 * Product CSV in Shopify's product-export layout (D-053, docs/csv-products.md).
 * - One row per variant; rows with the same `Handle` form one product. The first row of a
 *   product carries the product fields (Title, Status, Option names…) like Shopify's export.
 * - `Variant SKU` is the identity: it must be present on every row and is globally unique.
 *   Multiple variants of a handle become variants of ONE V3PL product — never separate products.
 * - Import is Upload → Preview → Validate → Confirm; a product with any error is skipped whole.
 * - Quantities (`Variant Inventory Qty`) are booked as a receipt into the chosen warehouse for
 *   NEW SKUs only (the inventory service is the sole writer); existing SKUs keep their stock.
 */

export const SHOPIFY_PRODUCT_COLUMNS = [
  "Handle",
  "Title",
  "Body (HTML)",
  "Vendor",
  "Product Category",
  "Type",
  "Tags",
  "Published",
  "Option1 Name",
  "Option1 Value",
  "Option2 Name",
  "Option2 Value",
  "Option3 Name",
  "Option3 Value",
  "Variant SKU",
  "Variant Grams",
  "Variant Inventory Tracker",
  "Variant Inventory Qty",
  "Variant Inventory Policy",
  "Variant Fulfillment Service",
  "Variant Price",
  "Variant Compare At Price",
  "Variant Requires Shipping",
  "Variant Taxable",
  "Variant Barcode",
  "Image Src",
  "Image Position",
  "Image Alt Text",
  "Status",
] as const;

export const V3PL_PRODUCT_COLUMNS = ["V3PL Owner Code", "V3PL Owner", "V3PL Product Status", "V3PL Variant Status", "V3PL Wholesale Price", "V3PL Cost", "V3PL Length (cm)", "V3PL Width (cm)", "V3PL Height (cm)", "V3PL On Hand", "V3PL Reserved", "V3PL Available"] as const;

export const PRODUCT_EXPORT_COLUMNS = [...SHOPIFY_PRODUCT_COLUMNS, ...V3PL_PRODUCT_COLUMNS];

export const PRODUCT_IMPORT_REQUIRED = ["Handle", "Variant SKU"] as const;
/** Columns the import actually reads; every other column (Shopify-only or unknown) is listed as ignored. */
const PRODUCT_IMPORT_USED = ["Handle", "Title", "Option1 Name", "Option1 Value", "Option2 Name", "Option2 Value", "Option3 Name", "Option3 Value", "Variant SKU", "Variant Price", "Variant Barcode", "Variant Inventory Qty", "Variant Grams", "Status", "Cost per item", "Image Src", "Image Position", "V3PL Owner Code", "V3PL Product Status", "V3PL Variant Status", "V3PL Wholesale Price", "V3PL Cost", "V3PL Length (cm)", "V3PL Width (cm)", "V3PL Height (cm)"];
/** Variant-level columns; a row without any of them (and no option values) is a media/image row, not a variant. */
const VARIANT_DATA_COLUMNS = ["Variant SKU", "Variant Price", "Variant Inventory Qty", "Variant Barcode", "Variant Grams", "Variant Compare At Price", "Cost per item", "V3PL Cost", "V3PL Wholesale Price"];

export type ProductCsvFormat = "shopify-products" | "v3pl-products" | "unknown";

export type ProductPreviewRow = {
  index: number;
  handle: string;
  raw: CsvRow;
  errors: string[];
  /** Shopify exports carry extra image rows per product (Handle + Image Src/Position only). They are not variants. */
  media?: boolean;
};
export type ProductPreviewVariant = {
  rowIndex: number;
  sku: string;
  optionValues: string[];
  price: string | null;
  cost: string | null;
  wholesalePrice: string | null;
  weightGrams: number | null;
  lengthCm: string | null;
  widthCm: string | null;
  heightCm: string | null;
  barcode: string | null;
  status: "ACTIVE" | "ARCHIVED";
  quantity: number | null;
  existingVariantId: string | null;
};
export type ProductPreviewGroup = {
  handle: string;
  title: string;
  rowIndexes: number[];
  ownerId: string | null;
  ownerCode: string | null;
  ownerName: string | null;
  status: "ACTIVE" | "ARCHIVED";
  options: string[];
  action: "create" | "update";
  existingProductId: string | null;
  variants: ProductPreviewVariant[];
  /** Non-blocking remarks (e.g. quantity ignored for an existing SKU). */
  notes: string[];
  errors: string[];
};
export type ProductImportPreview = {
  format: ProductCsvFormat;
  headers: string[];
  missingRequired: string[];
  unknownColumns: string[];
  options: ProductImportOptions;
  rows: ProductPreviewRow[];
  groups: ProductPreviewGroup[];
  summary: { totalRows: number; totalProducts: number; validProducts: number; failedProducts: number; failedRows: number; newSkus: number; existingSkus: number; unitsToReceive: number; mediaRows: number };
};

/**
 * Official Shopify product exports list additional images as their own rows: same Handle, `Image Src` /
 * `Image Position` (sometimes `Image Alt Text`), and every product/option/variant column empty.
 * Such a row describes media, not a sellable variant, so it must not produce SKU/option errors.
 */
export function isMediaRow(row: CsvRow, headerMap: Map<string, string>): boolean {
  const c = (name: string) => col(row, headerMap, name);
  if (!c("Handle")) return false;
  const hasVariantData = VARIANT_DATA_COLUMNS.some((name) => c(name) !== "");
  const hasOptionValue = [1, 2, 3].some((n) => c(`Option${n} Value`) !== "");
  if (hasVariantData || hasOptionValue) return false;
  const hasImage = c("Image Src") !== "" || c("Image Position") !== "";
  const hasProductData = c("Title") !== "" || [1, 2, 3].some((n) => c(`Option${n} Name`) !== "");
  return hasImage && !hasProductData;
}

function col(row: CsvRow, headerMap: Map<string, string>, name: string): string {
  const actual = headerMap.get(normalizeHeader(name));
  return actual ? (row[actual] ?? "").trim() : "";
}

function parseStatus(v: string): "ACTIVE" | "ARCHIVED" | null {
  switch (v.trim().toLowerCase()) {
    case "":
      return null;
    case "active":
    case "draft":
      return "ACTIVE";
    case "archived":
      return "ARCHIVED";
    default:
      return null;
  }
}

const isMoney = (v: string) => /^\$?\d{1,10}(\.\d{1,2})?$/.test(v.trim());
const money = (v: string) => (v ? v.trim().replace(/^\$/, "") : null);

export async function previewProductCsv(text: string, options: ProductImportOptions): Promise<ProductImportPreview> {
  const { headers, rows: rawRows } = parseCsv(text);
  const headerMap = new Map(headers.map((h) => [normalizeHeader(h), h]));
  const has = (name: string) => headerMap.has(normalizeHeader(name));
  const missingRequired = PRODUCT_IMPORT_REQUIRED.filter((c) => !has(c));
  const unknownColumns = headers.filter((h) => !PRODUCT_IMPORT_USED.some((k) => normalizeHeader(k) === normalizeHeader(h)));
  const format: ProductCsvFormat = missingRequired.length ? "unknown" : has("V3PL Owner Code") ? "v3pl-products" : "shopify-products";

  const rows: ProductPreviewRow[] = rawRows.map((raw, i) => ({ index: i + 2, handle: col(raw, headerMap, "Handle"), raw, errors: missingRequired.length ? [`Missing required column(s): ${missingRequired.join(", ")}`] : [] }));
  const groups: ProductPreviewGroup[] = [];
  if (missingRequired.length) {
    return { format, headers, missingRequired, unknownColumns, options, rows, groups, summary: { totalRows: rows.length, totalProducts: 0, validProducts: 0, failedProducts: 0, failedRows: rows.length, newSkus: 0, existingSkus: 0, unitsToReceive: 0, mediaRows: 0 } };
  }
  for (const r of rows) if (isMediaRow(r.raw, headerMap)) r.media = true;

  // Group rows by handle (order of first appearance; non-contiguous rows still join their product).
  const byHandle = new Map<string, ProductPreviewRow[]>();
  for (const r of rows) {
    if (!r.handle) {
      r.errors.push("Handle is required");
      continue;
    }
    (byHandle.get(r.handle) ?? byHandle.set(r.handle, []).get(r.handle)!).push(r);
  }

  // Lookups: owners by code, existing SKUs, default owner.
  const ownerCodes = [...new Set(rows.map((r) => col(r.raw, headerMap, "V3PL Owner Code").toUpperCase()).filter(Boolean))];
  const owners = await prisma.owner.findMany({ where: { OR: [{ code: { in: ownerCodes } }, ...(options.ownerId ? [{ id: options.ownerId }] : [])] }, select: { id: true, code: true, businessName: true, status: true } });
  const ownerByCode = new Map(owners.map((o) => [o.code.toUpperCase(), o]));
  const defaultOwner = options.ownerId ? owners.find((o) => o.id === options.ownerId) ?? null : null;
  const skus = [...new Set(rows.map((r) => col(r.raw, headerMap, "Variant SKU").toUpperCase()).filter(Boolean))];
  const existing = skus.length ? await prisma.productVariant.findMany({ where: { sku: { in: skus } }, select: { id: true, sku: true, productId: true, product: { select: { name: true, ownerId: true, options: true, _count: { select: { variants: true } } } } } }) : [];
  const existingBySku = new Map(existing.map((v) => [v.sku, v]));
  // Barcodes are globally unique (D-059): detect duplicates inside the file and clashes with other SKUs.
  const barcodeRows = new Map<string, number[]>();
  for (const r of rows) {
    const b = col(r.raw, headerMap, "Variant Barcode");
    if (b) (barcodeRows.get(b) ?? barcodeRows.set(b, []).get(b)!).push(r.index);
  }
  const barcodeOwners = barcodeRows.size ? await prisma.productVariant.findMany({ where: { barcode: { in: [...barcodeRows.keys()] } }, select: { barcode: true, sku: true } }) : [];
  const barcodeToSku = new Map(barcodeOwners.map((v) => [v.barcode!, v.sku]));
  const skuRows = new Map<string, number[]>();
  for (const r of rows) {
    const sku = col(r.raw, headerMap, "Variant SKU").toUpperCase();
    if (sku) (skuRows.get(sku) ?? skuRows.set(sku, []).get(sku)!).push(r.index);
  }

  for (const [handle, groupRows] of byHandle) {
    const first = groupRows[0];
    const firstValue = (name: string) => groupRows.map((r) => col(r.raw, headerMap, name)).find((v) => v !== "") ?? "";
    const title = firstValue("Title");
    const errors: string[] = [];
    const notes: string[] = [];
    if (!title) errors.push("Title is required on the first row of the product");
    const status = parseStatus(firstValue("V3PL Product Status")) ?? parseStatus(firstValue("Status")) ?? "ACTIVE";
    const rawStatus = firstValue("Status").toLowerCase();
    if (rawStatus && !parseStatus(rawStatus)) errors.push(`Unknown Status "${firstValue("Status")}" (use active, draft or archived)`);
    if (rawStatus === "draft") notes.push("Shopify draft imported as Active (V3PL has no draft state)");

    // Option names: first non-empty OptionN Name in the group. "Title" / "Default Title" = simple product.
    const optionNames = [1, 2, 3].map((n) => firstValue(`Option${n} Name`)).filter((v, i, arr) => v !== "" && arr.slice(0, i).every((x) => x !== v || x === ""));
    const options0 = optionNames.length === 1 && optionNames[0].toLowerCase() === "title" && groupRows.filter((r) => !r.media).every((r) => ["", "default title"].includes(col(r.raw, headerMap, "Option1 Value").toLowerCase())) ? [] : optionNames;

    // Owner: row code → default owner. Every row of a product must resolve to the same owner.
    const rowOwnerIds = new Set<string>();
    let ownerId: string | null = null;
    let ownerCode: string | null = null;
    let ownerName: string | null = null;
    for (const r of groupRows) {
      if (r.media) continue;
      const code = col(r.raw, headerMap, "V3PL Owner Code").toUpperCase();
      const o = code ? ownerByCode.get(code) : defaultOwner;
      if (code && !o) r.errors.push(`Unknown V3PL Owner Code "${code}"`);
      else if (o && o.status !== "ACTIVE") r.errors.push(`Owner ${o.code} is inactive`);
      else if (!o) r.errors.push("No owner: choose a default owner for the import or add a V3PL Owner Code column");
      if (o) {
        rowOwnerIds.add(o.id);
        ownerId = o.id;
        ownerCode = o.code;
        ownerName = o.businessName;
      }
    }
    if (rowOwnerIds.size > 1) errors.push("Rows of this product resolve to different owners");

    const variants: ProductPreviewVariant[] = [];
    const existingProductIds = new Set<string>();
    for (const r of groupRows) {
      if (r.media) continue; // image-only row: belongs to the product, is not a variant
      const skuRaw = col(r.raw, headerMap, "Variant SKU");
      const parsedSku = skuSchema.safeParse(skuRaw);
      if (!skuRaw) r.errors.push("Variant SKU is required — the SKU is the identity of every variant");
      else if (!parsedSku.success) r.errors.push(`Invalid SKU "${skuRaw}": ${parsedSku.error.issues[0]?.message}`);
      const sku = parsedSku.success ? parsedSku.data : skuRaw.toUpperCase();
      if (sku && (skuRows.get(sku)?.length ?? 0) > 1) r.errors.push(`SKU ${sku} appears more than once in the file (rows ${skuRows.get(sku)!.join(", ")})`);
      const optionValues = options0.map((_, j) => col(r.raw, headerMap, `Option${j + 1} Value`));
      options0.forEach((name, j) => {
        if (!optionValues[j]) r.errors.push(`${name} value is required`);
      });
      const priceRaw = col(r.raw, headerMap, "Variant Price");
      if (priceRaw && !isMoney(priceRaw)) r.errors.push(`Invalid Variant Price "${priceRaw}"`);
      const costRaw = col(r.raw, headerMap, "V3PL Cost") || col(r.raw, headerMap, "Cost per item");
      if (costRaw && !isMoney(costRaw)) r.errors.push(`Invalid cost "${costRaw}"`);
      const wholesaleRaw = col(r.raw, headerMap, "V3PL Wholesale Price");
      if (wholesaleRaw && !isMoney(wholesaleRaw)) r.errors.push(`Invalid V3PL Wholesale Price "${wholesaleRaw}"`);
      const gramsRaw = col(r.raw, headerMap, "Variant Grams");
      let weightGrams: number | null = null;
      if (gramsRaw) {
        if (!/^\d{1,9}(\.0+)?$/.test(gramsRaw)) r.errors.push(`Invalid Variant Grams "${gramsRaw}" (whole grams)`);
        else weightGrams = Math.round(Number(gramsRaw));
      }
      const dims = (["Length", "Width", "Height"] as const).map((d) => {
        const raw = col(r.raw, headerMap, `V3PL ${d} (cm)`);
        if (raw && !/^\d{1,6}(\.\d{1,2})?$/.test(raw)) r.errors.push(`Invalid V3PL ${d} (cm) "${raw}"`);
        return raw || null;
      });
      const qtyRaw = col(r.raw, headerMap, "Variant Inventory Qty");
      let quantity: number | null = null;
      if (qtyRaw) {
        if (!/^\d{1,7}$/.test(qtyRaw)) r.errors.push(`Invalid Variant Inventory Qty "${qtyRaw}" (whole number ≥ 0)`);
        else quantity = Number(qtyRaw);
      }
      const barcodeRaw = col(r.raw, headerMap, "Variant Barcode");
      if (barcodeRaw) {
        if (/\s/.test(barcodeRaw) || barcodeRaw.length > 64) r.errors.push(`Invalid Variant Barcode "${barcodeRaw}" (no spaces, max 64 characters)`);
        if ((barcodeRows.get(barcodeRaw)?.length ?? 0) > 1) r.errors.push(`Barcode ${barcodeRaw} appears more than once in the file (rows ${barcodeRows.get(barcodeRaw)!.join(", ")})`);
        const ownerSku = barcodeToSku.get(barcodeRaw);
        if (ownerSku && ownerSku !== sku) r.errors.push(`Barcode ${barcodeRaw} is already used by SKU ${ownerSku} — barcodes are unique across the platform`);
      }
      const vStatusRaw = col(r.raw, headerMap, "V3PL Variant Status");
      const vStatus = parseStatus(vStatusRaw);
      if (vStatusRaw && !vStatus) r.errors.push(`Unknown V3PL Variant Status "${vStatusRaw}"`);
      const ex = sku ? existingBySku.get(sku) : undefined;
      if (ex) {
        existingProductIds.add(ex.productId);
        if (ownerId && ex.product.ownerId !== ownerId) r.errors.push(`SKU ${sku} already belongs to "${ex.product.name}" of another owner — SKUs are unique across the platform`);
        if (quantity !== null && options.stockWarehouseId) notes.push(`${sku} exists — quantity ${quantity} not applied (adjust stock in Inventory)`);
      } else if (quantity && options.stockWarehouseId && (status === "ARCHIVED" || vStatus === "ARCHIVED")) {
        notes.push(`${sku} is archived — quantity ${quantity} not received (archived SKUs cannot receive stock)`);
      }
      variants.push({ rowIndex: r.index, sku, optionValues, price: money(priceRaw), cost: money(costRaw), wholesalePrice: money(wholesaleRaw), weightGrams, lengthCm: dims[0], widthCm: dims[1], heightCm: dims[2], barcode: col(r.raw, headerMap, "Variant Barcode") || null, status: vStatus ?? "ACTIVE", quantity, existingVariantId: ex?.id ?? null });
    }

    let existingProductId: string | null = null;
    if (existingProductIds.size > 1) {
      const names = [...existingProductIds].map((id) => existing.find((e) => e.productId === id)?.product.name ?? id);
      errors.push(`SKUs of this handle already belong to different V3PL products (${names.join(", ")}) — split them into separate handles`);
    } else if (existingProductIds.size === 1) {
      existingProductId = [...existingProductIds][0];
      const ex = existing.find((e) => e.productId === existingProductId)!;
      const sameOptions = ex.product.options.length === options0.length && ex.product.options.every((o, i) => o.toLowerCase() === options0[i].toLowerCase());
      const coversAll = ex.product._count.variants === variants.filter((v) => v.existingVariantId).length;
      if (!sameOptions && !coversAll) errors.push(`Options in the file (${options0.join(", ") || "none"}) differ from V3PL (${ex.product.options.join(", ") || "none"}); include every variant of "${ex.product.name}" in the file to change its options`);
    }
    // Duplicate option combinations inside the group.
    if (options0.length) {
      const seen = new Map<string, number>();
      for (const v of variants) {
        const key = v.optionValues.map((x) => x.toLowerCase()).join(" ");
        const prev = seen.get(key);
        const row = rows.find((r) => r.index === v.rowIndex)!;
        if (prev !== undefined && v.optionValues.every(Boolean)) row.errors.push(`Same option values as row ${prev}`);
        else seen.set(key, v.rowIndex);
      }
    }
    if (variants.length === 0) errors.push("No variants (only image rows found for this handle)");

    groups.push({
      handle,
      title,
      rowIndexes: groupRows.map((r) => r.index),
      ownerId: rowOwnerIds.size === 1 ? ownerId : null,
      ownerCode,
      ownerName,
      status,
      options: options0,
      action: existingProductId ? "update" : "create",
      existingProductId,
      variants,
      notes: [...new Set(notes)],
      errors,
    });
    void first;
  }

  const groupOk = (g: ProductPreviewGroup) => g.errors.length === 0 && rows.filter((r) => g.rowIndexes.includes(r.index)).every((r) => r.errors.length === 0);
  const valid = groups.filter(groupOk);
  const newSkus = valid.reduce((s, g) => s + g.variants.filter((v) => !v.existingVariantId).length, 0);
  const existingSkus = valid.reduce((s, g) => s + g.variants.filter((v) => v.existingVariantId).length, 0);
  const receivable = (g: ProductPreviewGroup) => (g.status === "ACTIVE" ? g.variants.filter((v) => !v.existingVariantId && v.status === "ACTIVE") : []);
  const unitsToReceive = options.stockWarehouseId ? valid.reduce((s, g) => s + receivable(g).reduce((x, v) => x + (v.quantity ?? 0), 0), 0) : 0;
  return {
    format,
    headers,
    missingRequired,
    unknownColumns,
    options,
    rows,
    groups,
    summary: { totalRows: rows.length, totalProducts: groups.length, validProducts: valid.length, failedProducts: groups.length - valid.length, failedRows: rows.filter((r) => r.errors.length).length, newSkus, existingSkus, unitsToReceive, mediaRows: rows.filter((r) => r.media).length },
  };
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

export type ProductImportOutcome = {
  created: { handle: string; title: string; productId: string; skus: string[]; received: number }[];
  updated: { handle: string; title: string; productId: string; skus: string[]; received: number }[];
  failed: { handle: string; title: string; errors: string[] }[];
};

export async function executeProductImport(preview: ProductImportPreview, options: ProductImportOptions, actorId: string, reference: string): Promise<ProductImportOutcome> {
  const outcome: ProductImportOutcome = { created: [], updated: [], failed: [] };
  const rowErrors = (g: ProductPreviewGroup) => preview.rows.filter((r) => g.rowIndexes.includes(r.index)).flatMap((r) => r.errors.map((e) => `Row ${r.index}: ${e}`));
  const warehouse = options.stockWarehouseId ? await prisma.warehouse.findUnique({ where: { id: options.stockWarehouseId }, select: { id: true, status: true, code: true } }) : null;
  const location = warehouse ? await getDefaultLocation(warehouse.id) : null;

  for (const g of preview.groups) {
    const errors = [...g.errors, ...rowErrors(g)];
    if (errors.length || !g.ownerId) {
      outcome.failed.push({ handle: g.handle, title: g.title, errors: errors.length ? errors : ["No owner"] });
      continue;
    }
    try {
      let productId: string;
      let variantIdBySku: Map<string, string>;
      if (g.action === "update" && g.existingProductId) {
        const current = await prisma.product.findUnique({ where: { id: g.existingProductId }, include: { variants: true } });
        if (!current) throw new Error("The existing product disappeared");
        const bySku = new Map(g.variants.map((v) => [v.sku, v]));
        const keep = current.variants.filter((v) => !bySku.has(v.sku)).map((v) => ({ id: v.id, sku: v.sku, optionValues: v.optionValues, name: v.name, barcode: v.barcode, price: v.price?.toString() ?? null, wholesalePrice: v.wholesalePrice?.toString() ?? null, cost: v.cost?.toString() ?? null, weightGrams: v.weightGrams, lengthCm: v.lengthCm?.toString() ?? null, widthCm: v.widthCm?.toString() ?? null, heightCm: v.heightCm?.toString() ?? null, status: v.status }));
        const cur = (v: ProductPreviewVariant) => current.variants.find((c) => c.id === v.existingVariantId);
        const fromFile = g.variants.map((v) => ({ id: v.existingVariantId ?? undefined, sku: v.sku, optionValues: v.optionValues, name: null, barcode: v.barcode ?? cur(v)?.barcode ?? null, price: v.price ?? cur(v)?.price?.toString() ?? null, wholesalePrice: v.wholesalePrice ?? cur(v)?.wholesalePrice?.toString() ?? null, cost: v.cost ?? cur(v)?.cost?.toString() ?? null, weightGrams: v.weightGrams ?? cur(v)?.weightGrams ?? null, lengthCm: v.lengthCm ?? cur(v)?.lengthCm?.toString() ?? null, widthCm: v.widthCm ?? cur(v)?.widthCm?.toString() ?? null, heightCm: v.heightCm ?? cur(v)?.heightCm?.toString() ?? null, status: v.status }));
        const values = parseValues({ ownerId: g.ownerId, name: g.title, category: current.category, description: current.description, notes: current.notes, status: g.status, options: g.options, variants: [...keep, ...fromFile] });
        await updateProduct(current.id, values, actorId);
        productId = current.id;
        const fresh = await prisma.productVariant.findMany({ where: { productId }, select: { id: true, sku: true } });
        variantIdBySku = new Map(fresh.map((v) => [v.sku, v.id]));
      } else {
        const values = parseValues({ ownerId: g.ownerId, name: g.title, category: null, description: null, notes: null, status: g.status, options: g.options, variants: g.variants.map((v) => ({ sku: v.sku, optionValues: v.optionValues, name: null, barcode: v.barcode, price: v.price, wholesalePrice: v.wholesalePrice, cost: v.cost, weightGrams: v.weightGrams, lengthCm: v.lengthCm, widthCm: v.widthCm, heightCm: v.heightCm, status: v.status })) });
        const product = await createProduct(values, actorId);
        productId = product.id;
        variantIdBySku = new Map(product.variants.map((v) => [v.sku, v.id]));
      }
      let received = 0;
      if (warehouse && location && warehouse.status === "ACTIVE" && g.status === "ACTIVE") {
        // Archived SKUs cannot receive stock (receiving service rule) — they were flagged in the preview notes.
        const lines = g.variants.filter((v) => !v.existingVariantId && v.status === "ACTIVE" && (v.quantity ?? 0) > 0 && variantIdBySku.has(v.sku)).map((v) => ({ variantId: variantIdBySku.get(v.sku)!, locationId: location.id, quantity: v.quantity! }));
        if (lines.length) {
          await createReceiving({ ownerId: g.ownerId, warehouseId: warehouse.id, reference: `${reference} · ${g.handle}`.slice(0, 80), notes: "Initial stock from product CSV import", lines }, actorId);
          received = lines.reduce((s, l) => s + l.quantity, 0);
        }
      }
      const entry = { handle: g.handle, title: g.title, productId, skus: g.variants.map((v) => v.sku), received };
      if (g.action === "update") outcome.updated.push(entry);
      else outcome.created.push(entry);
    } catch (err) {
      outcome.failed.push({ handle: g.handle, title: g.title, errors: [err instanceof Error ? err.message : String(err)] });
    }
  }
  return outcome;
}

function parseValues(input: unknown): ProductFormValues {
  const parsed = productFormSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return parsed.data;
}

/** Failed rows (original columns + Error) for download and re-upload. */
export function failedProductRowsCsv(preview: ProductImportPreview, outcome?: ProductImportOutcome): string {
  const failedHandles = new Set(outcome?.failed.map((f) => f.handle) ?? preview.groups.filter((g) => g.errors.length || preview.rows.some((r) => g.rowIndexes.includes(r.index) && r.errors.length)).map((g) => g.handle));
  const rows = preview.rows
    .filter((r) => r.errors.length || failedHandles.has(r.handle))
    .map((r) => {
      const g = preview.groups.find((x) => x.handle === r.handle);
      const errs = [...r.errors, ...(g?.errors ?? []), ...(outcome?.failed.find((f) => f.handle === r.handle)?.errors.filter((e) => !/^Row \d+:/.test(e)) ?? [])];
      return { ...r.raw, Error: [...new Set(errs)].join(" | ") };
    });
  return toCsv([...preview.headers, "Error"], rows);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

const EXPORT_MAX_PRODUCTS = 5000;

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "product";
}

export async function exportProductsCsv(filters: ProductExportFilters & { scopeOwnerId?: string }): Promise<{ csv: string; products: number; rows: number }> {
  const where: Prisma.ProductWhereInput = productWhere({ q: filters.q, ownerId: filters.scopeOwnerId ?? (filters.ownerId || undefined), status: filters.status });
  const products = await prisma.product.findMany({
    where,
    orderBy: [{ name: "asc" }, { createdAt: "asc" }],
    take: EXPORT_MAX_PRODUCTS,
    include: {
      owner: { select: { code: true, businessName: true } },
      variants: { orderBy: [{ isDefault: "desc" }, { sku: "asc" }], include: { balances: { select: { onHand: true, reserved: true } } } },
      images: { orderBy: { position: "asc" }, take: 1 },
    },
  });
  const handles = new Set<string>();
  const rows: Record<string, unknown>[] = [];
  for (const p of products) {
    let handle = slugify(p.name);
    if (handles.has(handle)) handle = `${handle}-${p.id.slice(-6)}`;
    handles.add(handle);
    const simple = p.options.length === 0;
    p.variants.forEach((v, i) => {
      const first = i === 0;
      const onHand = v.balances.reduce((s, b) => s + b.onHand, 0);
      const reserved = v.balances.reduce((s, b) => s + b.reserved, 0);
      const values = simple ? ["Default Title"] : p.options.map((_, j) => v.optionValues[j] ?? "");
      const names = simple ? ["Title"] : p.options;
      rows.push({
        Handle: handle,
        Title: first ? p.name : "",
        "Body (HTML)": first ? p.description ?? "" : "",
        Vendor: first ? p.owner.businessName : "",
        "Product Category": "",
        Type: first ? p.category ?? "" : "",
        Tags: "",
        Published: first ? (p.status === "ACTIVE" ? "TRUE" : "FALSE") : "",
        "Option1 Name": first ? names[0] ?? "" : "",
        "Option1 Value": values[0] ?? "",
        "Option2 Name": first ? names[1] ?? "" : "",
        "Option2 Value": values[1] ?? "",
        "Option3 Name": first ? names[2] ?? "" : "",
        "Option3 Value": values[2] ?? "",
        "Variant SKU": v.sku,
        "Variant Grams": v.weightGrams ?? "",
        "Variant Inventory Tracker": "shopify",
        "Variant Inventory Qty": Math.max(0, onHand - reserved),
        "Variant Inventory Policy": "deny",
        "Variant Fulfillment Service": "manual",
        "Variant Price": v.price?.toString() ?? "",
        "Variant Compare At Price": "",
        "Variant Requires Shipping": "TRUE",
        "Variant Taxable": "TRUE",
        "Variant Barcode": v.barcode ?? "",
        "Image Src": first ? p.images[0]?.url ?? "" : "",
        "Image Position": first && p.images[0] ? 1 : "",
        "Image Alt Text": first ? p.images[0]?.alt ?? "" : "",
        Status: first ? (p.status === "ACTIVE" ? "active" : "archived") : "",
        "V3PL Owner Code": p.owner.code,
        "V3PL Owner": p.owner.businessName,
        "V3PL Product Status": p.status,
        "V3PL Variant Status": v.status,
        "V3PL Wholesale Price": v.wholesalePrice?.toString() ?? "",
        "V3PL Cost": v.cost?.toString() ?? "",
        "V3PL Length (cm)": v.lengthCm?.toString() ?? "",
        "V3PL Width (cm)": v.widthCm?.toString() ?? "",
        "V3PL Height (cm)": v.heightCm?.toString() ?? "",
        "V3PL On Hand": onHand,
        "V3PL Reserved": reserved,
        "V3PL Available": onHand - reserved,
      });
    });
  }
  return { csv: toCsv([...PRODUCT_EXPORT_COLUMNS], rows), products: products.length, rows: rows.length };
}

export { variantLabel };
