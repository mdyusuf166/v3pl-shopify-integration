import type { Prisma } from "@/generated/prisma/client";
import { toCsv } from "@/lib/csv";
import { prisma } from "@/lib/prisma";
import { orderCounters } from "@/server/services/orders";
import { stockTotals } from "@/server/services/inventory";

/**
 * REPORTS (spec §48). Every figure is computed from the operational tables
 * (ledger, orders, shipments, returns) — nothing is stored or duplicated.
 *
 * Scope rules: `ownerId` in a ReportScope is set by the CALLER from the session for
 * portal users (never from a request parameter); admins may pass any owner or none.
 */

export type ReportScope = {
  ownerId?: string;
  warehouseId?: string;
  from?: Date;
  to?: Date;
};

const dateRange = (s: ReportScope, field = "createdAt"): Record<string, { gte?: Date; lte?: Date }> | Record<string, never> =>
  s.from || s.to ? { [field]: { ...(s.from ? { gte: s.from } : {}), ...(s.to ? { lte: s.to } : {}) } } : {};

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export async function portalDashboard(ownerId: string) {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [stock, counters, shipped30, received30, lost30, returnsAwaiting, byWarehouse, recentOrders, recentMovements, skuCount] = await Promise.all([
    stockTotals(ownerId),
    orderCounters(ownerId),
    prisma.inventoryTransaction.aggregate({ where: { ownerId, type: "SHIP", bucket: "ON_HAND", createdAt: { gte: since } }, _sum: { quantity: true } }),
    prisma.inventoryTransaction.aggregate({ where: { ownerId, type: "RECEIVE", createdAt: { gte: since } }, _sum: { quantity: true } }),
    prisma.inventoryTransaction.aggregate({ where: { ownerId, type: { in: ["DAMAGE", "MISSING"] }, createdAt: { gte: since } }, _sum: { quantity: true } }),
    prisma.return.count({ where: { status: "RECEIVED", items: { some: { ownerId } } } }),
    prisma.inventoryBalance.groupBy({ by: ["warehouseId"], where: { variant: { product: { ownerId } }, onHand: { gt: 0 } }, _sum: { onHand: true, reserved: true } }),
    prisma.order.findMany({
      where: { items: { some: { ownerId } } },
      orderBy: { placedAt: "desc" },
      take: 5,
      select: { id: true, orderNumber: true, status: true, fulfillmentStatus: true, placedAt: true, shipName: true, customerName: true, items: { where: { ownerId }, select: { quantity: true, cancelledQty: true, shippedQty: true, returnedQty: true } } },
    }),
    prisma.inventoryTransaction.findMany({
      where: { ownerId },
      orderBy: { createdAt: "desc" },
      take: 8,
      select: { id: true, type: true, bucket: true, quantity: true, createdAt: true, variant: { select: { sku: true } }, warehouse: { select: { code: true } } },
    }),
    prisma.productVariant.count({ where: { status: "ACTIVE", product: { ownerId, status: "ACTIVE" } } }),
  ]);
  const warehouses = byWarehouse.length ? await prisma.warehouse.findMany({ where: { id: { in: byWarehouse.map((w) => w.warehouseId) } }, select: { id: true, code: true, name: true, city: true, country: true } }) : [];
  return {
    stock,
    skuCount,
    counters,
    shippedUnits30d: Math.abs(shipped30._sum.quantity ?? 0),
    receivedUnits30d: received30._sum.quantity ?? 0,
    lostUnits30d: Math.abs(lost30._sum.quantity ?? 0),
    returnsAwaiting,
    byWarehouse: byWarehouse.map((w) => ({ ...(warehouses.find((x) => x.id === w.warehouseId) ?? { id: w.warehouseId, code: "?", name: "", city: null, country: null }), onHand: w._sum.onHand ?? 0, reserved: w._sum.reserved ?? 0, available: (w._sum.onHand ?? 0) - (w._sum.reserved ?? 0) })),
    recentOrders,
    recentMovements,
  };
}

// ---------------------------------------------------------------------------
// SKU activity
// ---------------------------------------------------------------------------

export type SkuActivityRow = {
  variantId: string;
  sku: string;
  product: string;
  variantName: string | null;
  owner: string;
  ownerCode: string;
  received: number;
  shipped: number;
  returned: number;
  damaged: number;
  missing: number;
  adjusted: number;
  transferred: number;
  onHand: number;
  reserved: number;
  available: number;
};

/** Per-SKU movement totals in the period + current stock. Sorted by shipped desc, then SKU. */
export async function skuActivityReport(scope: ReportScope): Promise<SkuActivityRow[]> {
  const where: Prisma.InventoryTransactionWhereInput = {
    bucket: "ON_HAND",
    ...(scope.ownerId ? { ownerId: scope.ownerId } : {}),
    ...(scope.warehouseId ? { warehouseId: scope.warehouseId } : {}),
    ...dateRange(scope),
  };
  const [movements, variants] = await Promise.all([
    prisma.inventoryTransaction.groupBy({ by: ["variantId", "type"], where, _sum: { quantity: true } }),
    prisma.productVariant.findMany({
      where: { ...(scope.ownerId ? { product: { ownerId: scope.ownerId } } : {}), OR: [{ status: "ACTIVE" }, { balances: { some: { onHand: { gt: 0 } } } }] },
      select: { id: true, sku: true, name: true, product: { select: { name: true, owner: { select: { code: true, businessName: true } } } }, balances: { where: scope.warehouseId ? { warehouseId: scope.warehouseId } : undefined, select: { onHand: true, reserved: true } } },
    }),
  ]);
  const byVariant = new Map<string, Record<string, number>>();
  for (const m of movements) {
    const row = byVariant.get(m.variantId) ?? {};
    row[m.type] = (row[m.type] ?? 0) + (m._sum.quantity ?? 0);
    byVariant.set(m.variantId, row);
  }
  const rows: SkuActivityRow[] = variants.map((v) => {
    const m = byVariant.get(v.id) ?? {};
    const onHand = v.balances.reduce((s, b) => s + b.onHand, 0);
    const reserved = v.balances.reduce((s, b) => s + b.reserved, 0);
    return {
      variantId: v.id,
      sku: v.sku,
      product: v.product.name,
      variantName: v.name,
      owner: v.product.owner.businessName,
      ownerCode: v.product.owner.code,
      received: m.RECEIVE ?? 0,
      shipped: Math.abs(m.SHIP ?? 0),
      returned: m.RETURN ?? 0,
      damaged: Math.abs(m.DAMAGE ?? 0),
      missing: Math.abs(m.MISSING ?? 0),
      adjusted: m.ADJUSTMENT ?? 0,
      transferred: (m.TRANSFER_IN ?? 0) + (m.TRANSFER_OUT ?? 0),
      onHand,
      reserved,
      available: onHand - reserved,
    };
  });
  // Include variants that only exist in movements (e.g. archived with history in period)
  return rows.sort((a, b) => b.shipped - a.shipped || a.sku.localeCompare(b.sku));
}

export function skuActivityCsv(rows: SkuActivityRow[], includeOwner: boolean): string {
  const headers = [...(includeOwner ? ["Owner", "Owner Code"] : []), "SKU", "Product", "Variant", "Received", "Shipped", "Returned", "Damaged", "Missing", "Adjusted", "Transferred (net)", "On Hand", "Reserved", "Available"];
  return toCsv(
    headers,
    rows.map((r) => ({ Owner: r.owner, "Owner Code": r.ownerCode, SKU: r.sku, Product: r.product, Variant: r.variantName ?? "", Received: r.received, Shipped: r.shipped, Returned: r.returned, Damaged: r.damaged, Missing: r.missing, Adjusted: r.adjusted, "Transferred (net)": r.transferred, "On Hand": r.onHand, Reserved: r.reserved, Available: r.available })),
  );
}

// ---------------------------------------------------------------------------
// Orders summary
// ---------------------------------------------------------------------------

export async function ordersSummaryReport(scope: ReportScope) {
  const ownerLine = scope.ownerId ? { ownerId: scope.ownerId } : {};
  const orderWhere: Prisma.OrderWhereInput = {
    ...(scope.ownerId ? { items: { some: { ownerId: scope.ownerId } } } : {}),
    ...(scope.warehouseId ? { OR: [{ warehouseId: scope.warehouseId }, { items: { some: { warehouseId: scope.warehouseId } } }] } : {}),
    ...dateRange(scope, "placedAt"),
  };
  const [byStatus, byFulfillment, lines, bySource] = await Promise.all([
    prisma.order.groupBy({ by: ["status"], where: orderWhere, _count: { _all: true } }),
    prisma.order.groupBy({ by: ["fulfillmentStatus"], where: orderWhere, _count: { _all: true } }),
    prisma.orderItem.aggregate({ where: { ...ownerLine, order: orderWhere }, _sum: { quantity: true, shippedQty: true, cancelledQty: true, returnedQty: true, reservedQty: true }, _count: { _all: true } }),
    prisma.order.groupBy({ by: ["source"], where: orderWhere, _count: { _all: true } }),
  ]);
  const total = byStatus.reduce((s, r) => s + r._count._all, 0);
  return {
    totalOrders: total,
    byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r._count._all])) as Record<string, number>,
    byFulfillment: Object.fromEntries(byFulfillment.map((r) => [r.fulfillmentStatus, r._count._all])) as Record<string, number>,
    bySource: Object.fromEntries(bySource.map((r) => [r.source, r._count._all])) as Record<string, number>,
    lines: lines._count._all,
    units: { ordered: lines._sum.quantity ?? 0, shipped: lines._sum.shippedQty ?? 0, cancelled: lines._sum.cancelledQty ?? 0, returned: lines._sum.returnedQty ?? 0, reserved: lines._sum.reservedQty ?? 0 },
  };
}

// ---------------------------------------------------------------------------
// Shipments
// ---------------------------------------------------------------------------

export type ShipmentsReportParams = ReportScope & { status?: string; q?: string; page?: number; pageSize?: number };

export async function shipmentsReport(params: ShipmentsReportParams) {
  const page = Math.max(1, params.page ?? 1);
  const pageSize = params.pageSize ?? 25;
  const where: Prisma.ShipmentWhereInput = {
    ...(params.ownerId ? { items: { some: { orderItem: { ownerId: params.ownerId } } } } : {}),
    ...(params.warehouseId ? { fulfillment: { warehouseId: params.warehouseId } } : {}),
    ...(params.status && params.status !== "ALL" ? { status: params.status as Prisma.EnumShipmentStatusFilter } : {}),
    ...dateRange(params, "shippedAt"),
    ...(params.q ? { OR: [{ trackingNumber: { contains: params.q, mode: "insensitive" } }, { carrier: { contains: params.q, mode: "insensitive" } }, { order: { orderNumber: { contains: params.q, mode: "insensitive" } } }] } : {}),
  };
  const [total, items] = await prisma.$transaction([
    prisma.shipment.count({ where }),
    prisma.shipment.findMany({
      where,
      orderBy: { shippedAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        status: true,
        carrier: true,
        service: true,
        trackingNumber: true,
        trackingUrl: true,
        shippedAt: true,
        deliveredAt: true,
        order: { select: { id: true, orderNumber: true, shipName: true, shipCity: true, shipCountry: true, source: true } },
        fulfillment: { select: { warehouse: { select: { code: true } } } },
        items: { where: params.ownerId ? { orderItem: { ownerId: params.ownerId } } : undefined, select: { quantity: true, orderItem: { select: { sku: true, owner: { select: { businessName: true } } } } } },
      },
    }),
  ]);
  return { items, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

export function shipmentsCsv(rows: Awaited<ReturnType<typeof shipmentsReport>>["items"], includeOwner: boolean): string {
  const headers = ["Order", "Shipped At", "Status", "Carrier", "Service", "Tracking Number", "Tracking URL", "Warehouse", "Ship To", "City", "Country", "SKU", "Quantity", ...(includeOwner ? ["Owner"] : [])];
  const out: Record<string, unknown>[] = [];
  for (const s of rows) {
    for (const it of s.items) {
      out.push({ Order: s.order.orderNumber, "Shipped At": s.shippedAt.toISOString(), Status: s.status, Carrier: s.carrier ?? "", Service: s.service ?? "", "Tracking Number": s.trackingNumber ?? "", "Tracking URL": s.trackingUrl ?? "", Warehouse: s.fulfillment.warehouse.code, "Ship To": s.order.shipName ?? "", City: s.order.shipCity ?? "", Country: s.order.shipCountry ?? "", SKU: it.orderItem.sku, Quantity: it.quantity, Owner: it.orderItem.owner.businessName });
    }
  }
  return toCsv(headers, out);
}

// ---------------------------------------------------------------------------
// Returns
// ---------------------------------------------------------------------------

export type ReturnsReportParams = ReportScope & { status?: "RECEIVED" | "INSPECTED" | "ALL"; page?: number; pageSize?: number };

export async function returnsReport(params: ReturnsReportParams) {
  const page = Math.max(1, params.page ?? 1);
  const pageSize = params.pageSize ?? 25;
  const where: Prisma.ReturnWhereInput = {
    ...(params.ownerId ? { items: { some: { ownerId: params.ownerId } } } : {}),
    ...(params.warehouseId ? { warehouseId: params.warehouseId } : {}),
    ...(params.status && params.status !== "ALL" ? { status: params.status } : {}),
    ...dateRange(params, "receivedAt"),
  };
  const [total, items] = await prisma.$transaction([
    prisma.return.count({ where }),
    prisma.return.findMany({
      where,
      orderBy: { receivedAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        status: true,
        reference: true,
        reason: true,
        receivedAt: true,
        inspectedAt: true,
        order: { select: { id: true, orderNumber: true } },
        warehouse: { select: { code: true } },
        items: { where: params.ownerId ? { ownerId: params.ownerId } : undefined, select: { quantity: true, condition: true, orderItem: { select: { sku: true, owner: { select: { businessName: true } } } }, location: { select: { label: true } } } },
      },
    }),
  ]);
  return { items, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

export function returnsCsv(rows: Awaited<ReturnType<typeof returnsReport>>["items"], includeOwner: boolean): string {
  const headers = ["Order", "Received At", "Inspected At", "Status", "Reference", "Reason", "Warehouse", "SKU", "Quantity", "Condition", "Location", ...(includeOwner ? ["Owner"] : [])];
  const out: Record<string, unknown>[] = [];
  for (const r of rows) {
    for (const it of r.items) {
      out.push({ Order: r.order.orderNumber, "Received At": r.receivedAt.toISOString(), "Inspected At": r.inspectedAt?.toISOString() ?? "", Status: r.status, Reference: r.reference ?? "", Reason: r.reason ?? "", Warehouse: r.warehouse.code, SKU: it.orderItem.sku, Quantity: it.quantity, Condition: it.condition ?? "PENDING", Location: it.location?.label ?? "", Owner: it.orderItem.owner.businessName });
    }
  }
  return toCsv(headers, out);
}

// ---------------------------------------------------------------------------
// Inventory snapshot (per SKU × warehouse) for CSV
// ---------------------------------------------------------------------------

export async function inventorySnapshotCsv(scope: ReportScope, includeOwner: boolean): Promise<string> {
  const rows = await prisma.inventoryBalance.findMany({
    where: { ...(scope.ownerId ? { variant: { product: { ownerId: scope.ownerId } } } : {}), ...(scope.warehouseId ? { warehouseId: scope.warehouseId } : {}) },
    orderBy: [{ variant: { sku: "asc" } }, { warehouse: { code: "asc" } }],
    select: { onHand: true, reserved: true, warehouse: { select: { code: true } }, variant: { select: { sku: true, name: true, product: { select: { name: true, owner: { select: { code: true, businessName: true } } } } } } },
  });
  const headers = [...(includeOwner ? ["Owner", "Owner Code"] : []), "SKU", "Product", "Variant", "Warehouse", "On Hand", "Reserved", "Available"];
  return toCsv(headers, rows.map((r) => ({ Owner: r.variant.product.owner.businessName, "Owner Code": r.variant.product.owner.code, SKU: r.variant.sku, Product: r.variant.product.name, Variant: r.variant.name ?? "", Warehouse: r.warehouse.code, "On Hand": r.onHand, Reserved: r.reserved, Available: r.onHand - r.reserved })));
}
