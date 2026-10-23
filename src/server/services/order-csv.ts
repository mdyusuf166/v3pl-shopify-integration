import type { Prisma } from "@/generated/prisma/client";
import { normalizeHeader, parseCsv, toCsv, type CsvRow } from "@/lib/csv";
import { prisma } from "@/lib/prisma";
import type { ExportFilters, ImportOptions } from "@/lib/validation/orders";
import { financialStatusFromShopifyLabel, shopifyFinancialLabel, shopifyFulfillmentLabel } from "@/server/services/order-status";
import { createOrder, orderWhere, OrderServiceError, type CreateOrderInput } from "@/server/services/orders";

/**
 * ORDER CSV — Shopify-compatible layout (one row per line item, grouped by "Name";
 * the first row of an order carries the header fields, later rows repeat only "Name"
 * and line columns, exactly like Shopify's order export). V3PL-specific data lives
 * in columns prefixed "V3PL " so the Shopify columns keep Shopify semantics.
 * Mapping decisions: docs/csv-orders.md (D-046).
 */

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

export const SHOPIFY_ORDER_COLUMNS = [
  "Name",
  "Email",
  "Phone",
  "Financial Status",
  "Fulfillment Status",
  "Currency",
  "Subtotal",
  "Shipping",
  "Taxes",
  "Total",
  "Discount Amount",
  "Shipping Method",
  "Created at",
  "Cancelled at",
  "Notes",
  "Tags",
  "Source",
  "Vendor",
  "Lineitem quantity",
  "Lineitem name",
  "Lineitem price",
  "Lineitem sku",
  "Lineitem discount",
  "Lineitem requires shipping",
  "Lineitem fulfillment status",
  "Shipping Name",
  "Shipping Company",
  "Shipping Address1",
  "Shipping Address2",
  "Shipping City",
  "Shipping Province",
  "Shipping Zip",
  "Shipping Country",
  "Shipping Phone",
] as const;

export const V3PL_ORDER_COLUMNS = [
  "V3PL Order Number",
  "V3PL Order Status",
  "V3PL Fulfillment Status",
  "V3PL Financial Status",
  "V3PL Invoice Reference",
  "V3PL Needs Attention",
  "V3PL Warehouse",
  "V3PL Owner Code",
  "V3PL Line Reserved",
  "V3PL Line Shipped",
  "V3PL Line Returned",
  "V3PL Line Cancelled",
  "V3PL Shipment Status",
  "V3PL Carrier",
  "V3PL Tracking Number",
  "V3PL Tracking URL",
  "V3PL Shipped At",
  "V3PL Shopify Store",
  "V3PL Shopify Order Id",
] as const;

export const EXPORT_COLUMNS = [...SHOPIFY_ORDER_COLUMNS, ...V3PL_ORDER_COLUMNS];

/** Import: required + optional recognised columns (matched case/space-insensitively). */
export const IMPORT_REQUIRED = ["Name", "Lineitem sku", "Lineitem quantity"] as const;
export const IMPORT_OPTIONAL = [
  "Email", "Phone", "Financial Status", "Currency", "Subtotal", "Shipping", "Taxes", "Total", "Discount Amount", "Shipping Method", "Created at", "Notes", "Tags",
  "Lineitem name", "Lineitem price", "Lineitem discount", "Lineitem requires shipping",
  "Shipping Name", "Shipping Company", "Shipping Street", "Shipping Address1", "Shipping Address2", "Shipping City", "Shipping Province", "Shipping Zip", "Shipping Country", "Shipping Phone",
  "V3PL Warehouse", "V3PL Owner Code", "V3PL Financial Status", "V3PL Invoice Reference",
] as const;

export type DetectedFormat = "shopify-orders" | "v3pl-orders" | "unknown";

// ---------------------------------------------------------------------------
// Preview / validation
// ---------------------------------------------------------------------------

export type PreviewRow = { index: number; name: string; raw: CsvRow; errors: string[] };
export type PreviewGroup = {
  name: string;
  rowIndexes: number[];
  header: Record<string, string>;
  lines: { rowIndex: number; sku: string; quantity: number; price: string | null; discount: string | null; title: string | null; requiresShipping: boolean; variantId: string | null; ownerCode: string | null }[];
  warehouseCode: string | null;
  errors: string[];
  duplicate: boolean;
};
export type ImportPreview = {
  format: DetectedFormat;
  headers: string[];
  missingRequired: string[];
  unknownColumns: string[];
  rows: PreviewRow[];
  groups: PreviewGroup[];
  summary: { totalRows: number; totalOrders: number; validOrders: number; failedOrders: number; duplicateOrders: number; failedRows: number };
};

function col(row: CsvRow, headerMap: Map<string, string>, name: string): string {
  const actual = headerMap.get(normalizeHeader(name));
  return actual ? (row[actual] ?? "").trim() : "";
}

function parseBool(v: string, fallback = true): boolean {
  if (!v) return fallback;
  return !["false", "0", "no", "n"].includes(v.trim().toLowerCase());
}

function isMoney(v: string): boolean {
  return /^-?\$?\d{1,10}(\.\d{1,2})?$/.test(v.trim());
}

export async function previewOrderCsv(text: string, opts: { source?: "CSV_IMPORT" } = {}): Promise<ImportPreview> {
  const { headers, rows } = parseCsv(text);
  const headerMap = new Map(headers.map((h) => [normalizeHeader(h), h]));
  const missingRequired = IMPORT_REQUIRED.filter((c) => !headerMap.has(normalizeHeader(c)));
  const known = new Set([...IMPORT_REQUIRED, ...IMPORT_OPTIONAL, ...EXPORT_COLUMNS].map(normalizeHeader));
  const unknownColumns = headers.filter((h) => !known.has(normalizeHeader(h)));
  const format: DetectedFormat = missingRequired.length > 0 ? "unknown" : headers.some((h) => normalizeHeader(h).startsWith("v3pl ")) ? "v3pl-orders" : "shopify-orders";

  const previewRows: PreviewRow[] = rows.map((raw, i) => ({ index: i + 2, name: col(raw, headerMap, "Name"), raw, errors: [] }));
  if (missingRequired.length > 0) {
    for (const r of previewRows) r.errors.push(`Missing required column(s): ${missingRequired.join(", ")}`);
    return { format, headers, missingRequired, unknownColumns, rows: previewRows, groups: [], summary: { totalRows: rows.length, totalOrders: 0, validOrders: 0, failedOrders: 0, duplicateOrders: 0, failedRows: rows.length } };
  }

  // Catalog lookups in one query.
  const skus = [...new Set(previewRows.map((r) => col(r.raw, headerMap, "Lineitem sku").toUpperCase()).filter(Boolean))];
  const variants = await prisma.productVariant.findMany({ where: { sku: { in: skus } }, select: { id: true, sku: true, status: true, product: { select: { status: true, owner: { select: { code: true } } } } } });
  const warehouseCodes = [...new Set(previewRows.map((r) => col(r.raw, headerMap, "V3PL Warehouse").toUpperCase()).filter(Boolean))];
  const warehouses = await prisma.warehouse.findMany({ where: { code: { in: warehouseCodes } }, select: { code: true, status: true } });

  // Group by Name (Shopify convention: later rows of the same order leave header fields blank).
  const groups = new Map<string, PreviewGroup>();
  const seenOrder: string[] = [];
  for (const r of previewRows) {
    if (!r.name) {
      r.errors.push("Name (order reference) is required on every row");
      continue;
    }
    let g = groups.get(r.name);
    if (!g) {
      g = { name: r.name, rowIndexes: [], header: {}, lines: [], warehouseCode: null, errors: [], duplicate: false };
      groups.set(r.name, g);
      seenOrder.push(r.name);
    }
    g.rowIndexes.push(r.index);
    // Header fields: first non-empty value wins.
    for (const c of ["Email", "Phone", "Financial Status", "Currency", "Subtotal", "Shipping", "Taxes", "Total", "Discount Amount", "Shipping Method", "Created at", "Notes", "Tags", "Shipping Name", "Shipping Company", "Shipping Street", "Shipping Address1", "Shipping Address2", "Shipping City", "Shipping Province", "Shipping Zip", "Shipping Country", "Shipping Phone", "V3PL Warehouse", "V3PL Financial Status", "V3PL Invoice Reference"]) {
      const v = col(r.raw, headerMap, c);
      if (v && !g.header[c]) g.header[c] = v;
    }
    const sku = col(r.raw, headerMap, "Lineitem sku").toUpperCase();
    const qtyRaw = col(r.raw, headerMap, "Lineitem quantity");
    const qty = Number(qtyRaw);
    const price = col(r.raw, headerMap, "Lineitem price");
    const discount = col(r.raw, headerMap, "Lineitem discount");
    const ownerCode = col(r.raw, headerMap, "V3PL Owner Code").toUpperCase() || null;
    if (!sku) r.errors.push("Lineitem sku is required");
    if (!qtyRaw || !Number.isInteger(qty) || qty <= 0) r.errors.push(`Invalid Lineitem quantity "${qtyRaw}" (whole number ≥ 1)`);
    if (price && !isMoney(price)) r.errors.push(`Invalid Lineitem price "${price}"`);
    if (discount && !isMoney(discount)) r.errors.push(`Invalid Lineitem discount "${discount}"`);
    const variant = sku ? variants.find((v) => v.sku === sku) : undefined;
    if (sku && !variant) r.errors.push(`Unknown SKU "${sku}" — not in the V3PL catalogue`);
    if (variant && (variant.status !== "ACTIVE" || variant.product.status !== "ACTIVE")) r.errors.push(`SKU "${sku}" is archived`);
    if (variant && ownerCode && variant.product.owner.code !== ownerCode) r.errors.push(`SKU "${sku}" belongs to ${variant.product.owner.code}, not ${ownerCode}`);
    g.lines.push({ rowIndex: r.index, sku, quantity: qty, price: price || null, discount: discount || null, title: col(r.raw, headerMap, "Lineitem name") || null, requiresShipping: parseBool(col(r.raw, headerMap, "Lineitem requires shipping")), variantId: variant?.id ?? null, ownerCode });
  }

  // Group-level validation.
  const names = seenOrder;
  const existing = names.length ? await prisma.order.findMany({ where: { source: opts.source ?? "CSV_IMPORT", sourceRef: { in: names } }, select: { sourceRef: true, orderNumber: true } }) : [];
  for (const g of groups.values()) {
    const dup = existing.find((e) => e.sourceRef === g.name);
    if (dup) {
      g.duplicate = true;
      g.errors.push(`Order "${g.name}" was already imported as V3PL order ${dup.orderNumber}`);
    }
    const whCode = (g.header["V3PL Warehouse"] ?? "").toUpperCase() || null;
    g.warehouseCode = whCode;
    if (whCode) {
      const wh = warehouses.find((w) => w.code === whCode);
      if (!wh) g.errors.push(`Unknown V3PL Warehouse "${whCode}"`);
      else if (wh.status !== "ACTIVE") g.errors.push(`Warehouse "${whCode}" is inactive`);
    }
    for (const c of ["Subtotal", "Shipping", "Taxes", "Total", "Discount Amount"]) {
      const v = g.header[c];
      if (v && !isMoney(v)) g.errors.push(`Invalid ${c} "${v}"`);
    }
    if (g.header["Created at"] && Number.isNaN(new Date(g.header["Created at"]).getTime())) g.errors.push(`Invalid Created at "${g.header["Created at"]}"`);
    const fs = g.header["V3PL Financial Status"];
    if (fs && !["NOT_INVOICED", "INVOICED", "PAID", "PARTIALLY_PAID", "OUTSTANDING"].includes(fs.toUpperCase().replace(/ /g, "_"))) g.errors.push(`Invalid V3PL Financial Status "${fs}"`);
    // Duplicate SKU lines within an order are merged? No — Shopify allows repeated SKUs (different line items). Keep as separate lines.
    // Propagate group errors to all rows of the group so a failed order never partially imports.
    const rowErrors = previewRows.filter((r) => g.rowIndexes.includes(r.index) && r.errors.length > 0).length > 0;
    if (rowErrors && g.errors.length === 0) g.errors.push("One or more lines of this order have errors — the whole order is skipped");
  }

  const groupList = [...groups.values()];
  const failedOrders = groupList.filter((g) => g.errors.length > 0 && !g.duplicate).length;
  const duplicateOrders = groupList.filter((g) => g.duplicate).length;
  const failedRows = previewRows.filter((r) => r.errors.length > 0 || groupList.find((g) => g.name === r.name)?.errors.length).length;
  return {
    format,
    headers,
    missingRequired: [],
    unknownColumns,
    rows: previewRows,
    groups: groupList,
    summary: { totalRows: rows.length, totalOrders: groupList.length, validOrders: groupList.length - failedOrders - duplicateOrders, failedOrders, duplicateOrders, failedRows },
  };
}

// ---------------------------------------------------------------------------
// Import execution
// ---------------------------------------------------------------------------

export type ImportOutcome = {
  created: { name: string; orderId: string; orderNumber: string; short: number }[];
  failed: { name: string; errors: string[] }[];
  duplicates: { name: string }[];
};

function shopifyHeaderToInput(g: PreviewGroup, options: ImportOptions, warehouseIdByCode: Map<string, string>): CreateOrderInput {
  const h = g.header;
  const street = h["Shipping Street"];
  const address1 = h["Shipping Address1"] || (street ? street.split(",")[0]?.trim() : "") || null;
  const address2 = h["Shipping Address2"] || (street && !h["Shipping Address1"] ? street.split(",").slice(1).join(",").trim() || null : null);
  const v3plFinancial = h["V3PL Financial Status"]?.toUpperCase().replace(/ /g, "_") as CreateOrderInput["financialStatus"] | undefined;
  return {
    source: "CSV_IMPORT",
    sourceRef: g.name,
    customerEmail: h["Email"]?.toLowerCase() || null,
    customerPhone: h["Phone"] || null,
    customerName: h["Shipping Name"] || null,
    shipName: h["Shipping Name"] || null,
    shipCompany: h["Shipping Company"] || null,
    shipAddress1: address1,
    shipAddress2: address2,
    shipCity: h["Shipping City"] || null,
    shipProvince: h["Shipping Province"] || null,
    shipZip: h["Shipping Zip"] || null,
    shipCountry: h["Shipping Country"] || null,
    shipPhone: h["Shipping Phone"] || null,
    currency: h["Currency"]?.toUpperCase() || "USD",
    subtotal: h["Subtotal"]?.replace(/^\$/, "") || null,
    shippingTotal: h["Shipping"]?.replace(/^\$/, "") || null,
    taxTotal: h["Taxes"]?.replace(/^\$/, "") || null,
    total: h["Total"]?.replace(/^\$/, "") || null,
    discountTotal: h["Discount Amount"]?.replace(/^\$/, "") || null,
    shippingMethod: h["Shipping Method"] || null,
    financialStatus: v3plFinancial ?? financialStatusFromShopifyLabel(h["Financial Status"]) ?? "NOT_INVOICED",
    invoiceReference: h["V3PL Invoice Reference"] || null,
    notes: h["Notes"] || null,
    tags: h["Tags"] || null,
    placedAt: h["Created at"] ? new Date(h["Created at"]) : null,
    warehouseId: (g.warehouseCode ? warehouseIdByCode.get(g.warehouseCode) : undefined) ?? options.defaultWarehouseId,
    reserve: options.reserve,
    lines: g.lines.map((l) => ({ sku: l.sku, quantity: l.quantity, unitPrice: l.price?.replace(/^\$/, "") ?? null, discount: l.discount?.replace(/^\$/, "") ?? null, title: l.title, requiresShipping: l.requiresShipping })),
  };
}

/** Create one order per valid group; each order is its own transaction so one failure never blocks the rest. */
export async function executeOrderImport(preview: ImportPreview, options: ImportOptions, actorId: string): Promise<ImportOutcome> {
  const outcome: ImportOutcome = { created: [], failed: [], duplicates: [] };
  const codes = [...new Set(preview.groups.map((g) => g.warehouseCode).filter((c): c is string => !!c))];
  const whs = await prisma.warehouse.findMany({ where: { code: { in: codes } }, select: { id: true, code: true } });
  const warehouseIdByCode = new Map(whs.map((w) => [w.code, w.id]));
  for (const g of preview.groups) {
    if (g.duplicate) {
      outcome.duplicates.push({ name: g.name });
      continue;
    }
    const rowErrors = preview.rows.filter((r) => g.rowIndexes.includes(r.index)).flatMap((r) => r.errors);
    if (g.errors.length > 0 || rowErrors.length > 0) {
      outcome.failed.push({ name: g.name, errors: [...new Set([...g.errors, ...rowErrors])] });
      continue;
    }
    try {
      const res = await createOrder(shopifyHeaderToInput(g, options, warehouseIdByCode), actorId);
      if (!res.created) outcome.duplicates.push({ name: g.name });
      else outcome.created.push({ name: g.name, orderId: res.orderId, orderNumber: res.orderNumber, short: res.reservation.short.length });
    } catch (err) {
      outcome.failed.push({ name: g.name, errors: [err instanceof OrderServiceError ? err.message : "Unexpected error while creating the order"] });
    }
  }
  return outcome;
}

/** Original rows of failed orders + an "Error" column, for correction and re-upload. */
export function failedRowsCsv(preview: ImportPreview, outcome?: ImportOutcome): string {
  const failedNames = new Set<string>([...preview.groups.filter((g) => g.errors.length > 0).map((g) => g.name), ...(outcome?.failed.map((f) => f.name) ?? [])]);
  const rows = preview.rows.filter((r) => r.errors.length > 0 || failedNames.has(r.name));
  const headers = [...preview.headers, "Error"];
  return toCsv(
    headers,
    rows.map((r) => {
      const g = preview.groups.find((x) => x.name === r.name);
      const runtime = outcome?.failed.find((f) => f.name === r.name)?.errors ?? [];
      return { ...r.raw, Error: [...r.errors, ...(g?.errors ?? []), ...runtime].filter((v, i, a) => a.indexOf(v) === i).join(" | ") };
    }),
  );
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

const EXPORT_MAX_ORDERS = 5000;

export async function exportOrdersCsv(filters: ExportFilters & { scopeOwnerId?: string }): Promise<{ csv: string; orders: number; rows: number }> {
  const where: Prisma.OrderWhereInput = {
    ...orderWhere({
      status: filters.status,
      fulfillmentStatus: filters.fulfillmentStatus,
      source: filters.source,
      ownerId: filters.ownerId || undefined,
      scopeOwnerId: filters.scopeOwnerId,
      warehouseId: filters.warehouseId || undefined,
      from: filters.from ? new Date(filters.from) : undefined,
      to: filters.to ? new Date(`${filters.to}T23:59:59.999Z`) : undefined,
    }),
    ...(filters.shipmentStatus && filters.shipmentStatus !== "ALL" ? { shipments: { some: { status: filters.shipmentStatus } } } : {}),
    ...(filters.shopifyStoreId ? { shopifyStoreId: filters.shopifyStoreId } : {}),
  };
  const orders = await prisma.order.findMany({
    where,
    orderBy: { placedAt: "desc" },
    take: EXPORT_MAX_ORDERS,
    include: {
      warehouse: { select: { code: true } },
      items: { where: filters.scopeOwnerId ? { ownerId: filters.scopeOwnerId } : undefined, orderBy: { position: "asc" }, include: { owner: { select: { code: true, businessName: true } } } },
      shipments: { orderBy: { shippedAt: "desc" }, take: 1 },
    },
  });
  const rows: Record<string, unknown>[] = [];
  for (const o of orders) {
    const ship = o.shipments[0];
    const name = o.shopifyOrderName ?? o.sourceRef ?? `#${o.orderNumber}`;
    o.items.forEach((it, i) => {
      const first = i === 0;
      const lineFulfilment = it.shippedQty >= it.quantity - it.cancelledQty && it.quantity - it.cancelledQty > 0 ? "fulfilled" : it.shippedQty > 0 ? "partial" : "pending";
      rows.push({
        Name: name,
        Email: first ? o.customerEmail : "",
        Phone: first ? o.customerPhone : "",
        "Financial Status": first ? shopifyFinancialLabel(o.financialStatus) : "",
        "Fulfillment Status": first ? shopifyFulfillmentLabel(o.fulfillmentStatus) : "",
        Currency: first ? o.currency : "",
        Subtotal: first ? o.subtotal?.toString() ?? "" : "",
        Shipping: first ? o.shippingTotal?.toString() ?? "" : "",
        Taxes: first ? o.taxTotal?.toString() ?? "" : "",
        Total: first ? o.total?.toString() ?? "" : "",
        "Discount Amount": first ? o.discountTotal?.toString() ?? "" : "",
        "Shipping Method": first ? o.shippingMethod : "",
        "Created at": first ? o.placedAt.toISOString() : "",
        "Cancelled at": first ? o.cancelledAt?.toISOString() ?? "" : "",
        Notes: first ? o.notes : "",
        Tags: first ? o.tags : "",
        Source: first ? o.source.toLowerCase() : "",
        Vendor: it.owner.businessName,
        "Lineitem quantity": it.quantity,
        "Lineitem name": [it.title, it.variantTitle].filter(Boolean).join(" - "),
        "Lineitem price": it.unitPrice?.toString() ?? "",
        "Lineitem sku": it.sku,
        "Lineitem discount": it.discount?.toString() ?? "",
        "Lineitem requires shipping": it.requiresShipping ? "true" : "false",
        "Lineitem fulfillment status": lineFulfilment,
        "Shipping Name": first ? o.shipName : "",
        "Shipping Company": first ? o.shipCompany : "",
        "Shipping Address1": first ? o.shipAddress1 : "",
        "Shipping Address2": first ? o.shipAddress2 : "",
        "Shipping City": first ? o.shipCity : "",
        "Shipping Province": first ? o.shipProvince : "",
        "Shipping Zip": first ? o.shipZip : "",
        "Shipping Country": first ? o.shipCountry : "",
        "Shipping Phone": first ? o.shipPhone : "",
        "V3PL Order Number": o.orderNumber,
        "V3PL Order Status": o.status,
        "V3PL Fulfillment Status": o.fulfillmentStatus,
        "V3PL Financial Status": o.financialStatus,
        "V3PL Invoice Reference": o.invoiceReference,
        "V3PL Needs Attention": o.needsAttention ? o.needsAttentionReason ?? "yes" : "",
        "V3PL Warehouse": o.warehouse?.code ?? "",
        "V3PL Owner Code": it.owner.code,
        "V3PL Line Reserved": it.reservedQty,
        "V3PL Line Shipped": it.shippedQty,
        "V3PL Line Returned": it.returnedQty,
        "V3PL Line Cancelled": it.cancelledQty,
        "V3PL Shipment Status": ship?.status ?? "",
        "V3PL Carrier": ship?.carrier ?? "",
        "V3PL Tracking Number": ship?.trackingNumber ?? "",
        "V3PL Tracking URL": ship?.trackingUrl ?? "",
        "V3PL Shipped At": ship?.shippedAt.toISOString() ?? "",
        "V3PL Shopify Store": o.shopifyStoreId ?? "",
        "V3PL Shopify Order Id": o.shopifyOrderId ?? "",
      });
    });
  }
  return { csv: toCsv([...EXPORT_COLUMNS], rows), orders: orders.length, rows: rows.length };
}
