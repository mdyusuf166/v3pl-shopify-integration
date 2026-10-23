import type { FulfillmentRecordStatus, Prisma, ShipmentStatus } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/server/services/audit";
import { runShipmentHandlers, type ShipmentTracking } from "@/server/services/fulfillment-hooks";
import { recordShipmentFinancials } from "@/server/services/finance";
import { InventoryError, shipStock } from "@/server/services/inventory";
import { OrderServiceError, addEvent, ensureActor, hasProcessedEvent, recomputeOrder } from "@/server/services/orders";
import { remainingQty } from "@/server/services/order-status";
import { getDefaultLocation } from "@/server/services/warehouses";

/**
 * FULFILLMENT SERVICE (spec §29–§33, §41–§42; D-032).
 *   startPicking → markPacked → shipFulfillment   (manual warehouse flow)
 *   recordExternalShipment                         (fulfilment created in Shopify, mirrored once)
 * A Fulfillment groups lines + quantities; shipping it creates exactly one Shipment
 * (unique fulfillmentId) and consumes reservations through the inventory service.
 * Double-picking is impossible: a line's pickable quantity excludes units already in
 * open fulfilments. Order/fulfilment/shipment statuses stay separate (D-008).
 */

type Db = Prisma.TransactionClient;
const TX = { timeout: 30_000, maxWait: 10_000 } as const;

export class FulfillmentServiceError extends Error {
  constructor(
    public readonly code: "NOT_FOUND" | "BAD_STATUS" | "INVALID_QUANTITY" | "WAREHOUSE_REQUIRED" | "ORDER_NOT_OPEN" | "INVALID_REFERENCE",
    message: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** Units of a line not shipped, not cancelled and not sitting in an open fulfilment. */
export async function pickableQuantities(db: Db, orderId: string) {
  const items = await db.orderItem.findMany({ where: { orderId }, orderBy: { position: "asc" }, include: { owner: { select: { businessName: true } } } });
  const open = await db.fulfillmentItem.groupBy({ by: ["orderItemId"], where: { orderItem: { orderId }, fulfillment: { status: { in: ["PICKING", "PACKED"] } } }, _sum: { quantity: true } });
  return items.map((i) => {
    const inOpen = open.find((o) => o.orderItemId === i.id)?._sum.quantity ?? 0;
    return { ...i, inOpenFulfillment: inOpen, pickable: Math.max(0, remainingQty(i) - inOpen) };
  });
}

/** Best pick location: the location in the warehouse holding the most of the SKU. */
async function suggestLocation(db: Db, variantId: string, warehouseId: string): Promise<string | null> {
  const level = await db.inventoryLevel.findFirst({ where: { variantId, warehouseId, onHand: { gt: 0 }, location: { isActive: true } }, orderBy: { onHand: "desc" }, select: { locationId: true } });
  if (level) return level.locationId;
  return (await getDefaultLocation(warehouseId, db))?.id ?? null;
}

export async function startPicking(input: { orderId: string; warehouseId?: string | null; lines?: { orderItemId: string; quantity: number }[]; assignedToId?: string | null }, actorId: string) {
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({ where: { id: input.orderId }, select: { id: true, status: true, warehouseId: true, orderNumber: true } });
    if (!order) throw new FulfillmentServiceError("NOT_FOUND", "Order not found.");
    if (order.status !== "NEW" && order.status !== "CONFIRMED") throw new FulfillmentServiceError("ORDER_NOT_OPEN", `Order is ${order.status.toLowerCase()}; only new or confirmed orders can be picked.`);
    const warehouseId = input.warehouseId ?? order.warehouseId;
    if (!warehouseId) throw new FulfillmentServiceError("WAREHOUSE_REQUIRED", "Choose a warehouse to pick from.");
    const items = await pickableQuantities(tx, order.id);
    const wanted = input.lines ?? items.filter((i) => i.pickable > 0).map((i) => ({ orderItemId: i.id, quantity: i.pickable }));
    if (wanted.length === 0) throw new FulfillmentServiceError("INVALID_QUANTITY", "Nothing left to pick on this order.");
    const lines: { orderItemId: string; quantity: number; locationId: string | null; sku: string }[] = [];
    for (const w of wanted) {
      const item = items.find((i) => i.id === w.orderItemId);
      if (!item) throw new FulfillmentServiceError("NOT_FOUND", "Order line not found.");
      if (!Number.isInteger(w.quantity) || w.quantity <= 0) throw new FulfillmentServiceError("INVALID_QUANTITY", `Invalid quantity for ${item.sku}.`);
      if (w.quantity > item.pickable) throw new FulfillmentServiceError("INVALID_QUANTITY", `${item.sku}: only ${item.pickable} left to pick (${item.inOpenFulfillment} already being picked).`, { sku: item.sku, pickable: item.pickable });
      lines.push({ orderItemId: item.id, quantity: w.quantity, locationId: await suggestLocation(tx, item.variantId, warehouseId), sku: item.sku });
    }
    const f = await tx.fulfillment.create({
      data: { orderId: order.id, warehouseId, status: "PICKING", type: "MANUAL", createdById: actorId, assignedToId: input.assignedToId ?? null, items: { create: lines.map((l) => ({ orderItemId: l.orderItemId, quantity: l.quantity, locationId: l.locationId })) } },
      select: { id: true },
    });
    await addEvent(tx, order.id, "picking_started", `Picking started: ${lines.map((l) => `${l.quantity} × ${l.sku}`).join(", ")}`, actorId, { fulfillmentId: f.id });
    await recomputeOrder(tx, order.id);
    return f;
  }, TX);
}

export async function markPacked(fulfillmentId: string, actorId: string) {
  return prisma.$transaction(async (tx) => {
    const f = await tx.fulfillment.findUnique({ where: { id: fulfillmentId }, select: { id: true, status: true, orderId: true } });
    if (!f) throw new FulfillmentServiceError("NOT_FOUND", "Fulfilment not found.");
    if (f.status !== "PICKING") throw new FulfillmentServiceError("BAD_STATUS", `Fulfilment is ${f.status.toLowerCase()}.`);
    await tx.fulfillment.update({ where: { id: fulfillmentId }, data: { status: "PACKED", packedAt: new Date() } });
    await addEvent(tx, f.orderId, "packed", "Packed", actorId, { fulfillmentId });
    await recomputeOrder(tx, f.orderId);
  }, TX);
}

export async function cancelFulfillment(fulfillmentId: string, actorId: string) {
  return prisma.$transaction(async (tx) => {
    const f = await tx.fulfillment.findUnique({ where: { id: fulfillmentId }, select: { id: true, status: true, orderId: true } });
    if (!f) throw new FulfillmentServiceError("NOT_FOUND", "Fulfilment not found.");
    if (f.status === "SHIPPED") throw new FulfillmentServiceError("BAD_STATUS", "A shipped fulfilment cannot be cancelled — record a return instead.");
    if (f.status === "CANCELLED") return;
    await tx.fulfillment.update({ where: { id: fulfillmentId }, data: { status: "CANCELLED", cancelledAt: new Date() } });
    await addEvent(tx, f.orderId, "picking_cancelled", "Picking cancelled; lines are available to pick again", actorId, { fulfillmentId });
    await recomputeOrder(tx, f.orderId);
  }, TX);
}

export type ShipInput = { carrier?: string | null; service?: string | null; trackingNumber?: string | null; trackingUrl?: string | null; shippedAt?: Date | null; notes?: string | null };

/** Ship a picked/packed fulfilment: one Shipment, ledger SHIP rows per line, statuses recomputed, hooks run. */
export async function shipFulfillment(fulfillmentId: string, input: ShipInput, actorId: string) {
  return prisma.$transaction(async (tx) => {
    const f = await tx.fulfillment.findUnique({ where: { id: fulfillmentId }, include: { items: { include: { orderItem: true } }, order: { select: { id: true, source: true, shopifyStoreId: true, orderNumber: true } } } });
    if (!f) throw new FulfillmentServiceError("NOT_FOUND", "Fulfilment not found.");
    if (f.status !== "PICKING" && f.status !== "PACKED") throw new FulfillmentServiceError("BAD_STATUS", `Fulfilment is already ${f.status.toLowerCase()}.`);
    const shipment = await tx.shipment.create({
      data: {
        orderId: f.orderId,
        fulfillmentId: f.id,
        status: "SHIPPED",
        carrier: input.carrier ?? null,
        service: input.service ?? null,
        trackingNumber: input.trackingNumber ?? null,
        trackingUrl: input.trackingUrl ?? null,
        shippedAt: input.shippedAt ?? new Date(),
        notes: input.notes ?? null,
        createdById: actorId,
        items: { create: f.items.map((i) => ({ orderItemId: i.orderItemId, quantity: i.quantity })) },
      },
      select: { id: true },
    });
    for (const fi of f.items) {
      const item = fi.orderItem;
      const reservedPart = Math.min(item.reservedQty, fi.quantity);
      const locationId = fi.locationId ?? (await suggestLocation(tx, item.variantId, f.warehouseId));
      if (!locationId) throw new FulfillmentServiceError("WAREHOUSE_REQUIRED", "Warehouse has no location to ship from.");
      await shipStock({ userId: actorId, variantId: item.variantId, warehouseId: f.warehouseId, locationId, quantity: fi.quantity, reservedQuantity: reservedPart, refs: { orderId: f.orderId, orderItemId: item.id, shipmentId: shipment.id } }, tx);
      await tx.orderItem.update({ where: { id: item.id }, data: { shippedQty: item.shippedQty + fi.quantity, reservedQty: item.reservedQty - reservedPart, warehouseId: item.warehouseId ?? f.warehouseId } });
    }
    await tx.fulfillment.update({ where: { id: f.id }, data: { status: "SHIPPED", shippedAt: input.shippedAt ?? new Date() } });
    await addEvent(tx, f.orderId, "shipped", `Shipped ${f.items.map((i) => `${i.quantity} × ${i.orderItem.sku}`).join(", ")}${input.carrier ? ` via ${input.carrier}` : ""}${input.trackingNumber ? ` (${input.trackingNumber})` : ""}`, actorId, { shipmentId: shipment.id });
    await recomputeOrder(tx, f.orderId);
    await recordAudit({ userId: actorId, action: "shipment.created", entityType: "Shipment", entityId: shipment.id, newValues: { orderId: f.orderId, carrier: input.carrier, trackingNumber: input.trackingNumber } }, tx);
    // Wholesale valuation + operational charges for what actually left the warehouse (D-063); idempotent per shipment.
    await recordShipmentFinancials(tx, shipment.id, actorId);
    await runShipmentHandlers(tx, { kind: "SHIPPED", shipmentId: shipment.id, fulfillmentId: f.id, orderId: f.orderId, orderSource: f.order.source, shopifyStoreId: f.order.shopifyStoreId, external: false });
    return shipment;
  }, TX);
}

export type ExternalShipmentInput = {
  lines: { orderItemId: string; quantity: number }[];
  carrier?: string | null;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  shippedAt?: Date | null;
  externalFulfillmentId: string;
  shopifyStoreId: string;
  externalEventId?: string | null;
  warehouseId?: string | null;
};

/**
 * Mirror a fulfilment created outside V3PL (Shopify Admin, D-032) exactly once.
 * Unreserved units ship from available stock; if even that is missing the order is
 * flagged for attention and no negative stock is created.
 */
export async function recordExternalShipment(orderId: string, input: ExternalShipmentInput, actorId: string | null) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.fulfillment.findUnique({ where: { shopifyStoreId_shopifyFulfillmentId: { shopifyStoreId: input.shopifyStoreId, shopifyFulfillmentId: input.externalFulfillmentId } }, include: { shipment: { select: { id: true } } } });
    if (existing) return { fulfillmentId: existing.id, shipmentId: existing.shipment?.id ?? null, created: false };
    if (input.externalEventId && (await hasProcessedEvent(orderId, input.externalEventId, tx))) return { fulfillmentId: null, shipmentId: null, created: false };
    const order = await tx.order.findUnique({ where: { id: orderId }, select: { id: true, warehouseId: true, source: true, shopifyStoreId: true, status: true } });
    if (!order) throw new OrderServiceError("NOT_FOUND", "Order not found.");
    const warehouseId = input.warehouseId ?? order.warehouseId;
    if (!warehouseId) throw new FulfillmentServiceError("WAREHOUSE_REQUIRED", "Order has no warehouse to ship from.");
    const items = await pickableQuantities(tx, orderId);
    const shortages: string[] = [];
    const ledgerActor = await ensureActor(tx, actorId);
    const f = await tx.fulfillment.create({
      data: { orderId, warehouseId, status: "SHIPPED", type: "EXTERNAL", shopifyStoreId: input.shopifyStoreId, shopifyFulfillmentId: input.externalFulfillmentId, createdById: ledgerActor, shippedAt: input.shippedAt ?? new Date() },
      select: { id: true },
    });
    const shipment = await tx.shipment.create({
      data: { orderId, fulfillmentId: f.id, status: "SHIPPED", carrier: input.carrier ?? null, trackingNumber: input.trackingNumber ?? null, trackingUrl: input.trackingUrl ?? null, shippedAt: input.shippedAt ?? new Date(), createdById: ledgerActor, shopifySyncedAt: new Date() },
      select: { id: true },
    });
    for (const l of input.lines) {
      const item = items.find((i) => i.id === l.orderItemId);
      if (!item) throw new FulfillmentServiceError("NOT_FOUND", "Order line not found.");
      const qty = Math.min(l.quantity, Math.max(0, remainingQty(item)));
      if (qty <= 0) continue;
      const reservedPart = Math.min(item.reservedQty, qty);
      const locationId = await suggestLocation(tx, item.variantId, warehouseId);
      await tx.fulfillmentItem.create({ data: { fulfillmentId: f.id, orderItemId: item.id, quantity: qty, locationId } });
      await tx.shipmentItem.create({ data: { shipmentId: shipment.id, orderItemId: item.id, quantity: qty } });
      let movedQty = 0;
      if (locationId) {
        try {
          await shipStock({ userId: ledgerActor, variantId: item.variantId, warehouseId, locationId, quantity: qty, reservedQuantity: reservedPart, refs: { orderId, orderItemId: item.id, shipmentId: shipment.id, externalEventId: input.externalEventId } }, tx);
          movedQty = qty;
        } catch (err) {
          if (!(err instanceof InventoryError && err.code === "INSUFFICIENT_STOCK")) throw err;
          // Ship what the reservation covers, flag the rest.
          if (reservedPart > 0) {
            await shipStock({ userId: ledgerActor, variantId: item.variantId, warehouseId, locationId, quantity: reservedPart, reservedQuantity: reservedPart, refs: { orderId, orderItemId: item.id, shipmentId: shipment.id, externalEventId: input.externalEventId } }, tx);
            movedQty = reservedPart;
          }
          shortages.push(`${item.sku} (${qty - movedQty} units)`);
        }
      } else shortages.push(`${item.sku} (${qty} units)`);
      await tx.orderItem.update({ where: { id: item.id }, data: { shippedQty: item.shippedQty + qty, reservedQty: item.reservedQty - reservedPart, warehouseId: item.warehouseId ?? warehouseId } });
    }
    await addEvent(tx, orderId, "shipped", `Fulfilment recorded from external system${input.trackingNumber ? ` (${input.trackingNumber})` : ""}`, actorId, { shipmentId: shipment.id, externalFulfillmentId: input.externalFulfillmentId }, input.externalEventId);
    if (shortages.length) {
      const reason = `Shipped externally but no internal stock for ${shortages.join(", ")}`;
      await tx.order.update({ where: { id: orderId }, data: { needsAttention: true, needsAttentionReason: reason } });
      await addEvent(tx, orderId, "attention", reason, actorId);
    }
    await recomputeOrder(tx, orderId);
    await recordShipmentFinancials(tx, shipment.id, actorId); // goods left the warehouse even when Shopify created the fulfilment (D-063)
    await runShipmentHandlers(tx, { kind: "SHIPPED", shipmentId: shipment.id, fulfillmentId: f.id, orderId, orderSource: order.source, shopifyStoreId: order.shopifyStoreId, external: true, externalEventId: input.externalEventId });
    return { fulfillmentId: f.id, shipmentId: shipment.id, created: true };
  }, TX);
}

export type TrackingPatch = { carrier?: string | null; service?: string | null; trackingNumber?: string | null; trackingUrl?: string | null };

const normalise = (v: string | null | undefined): string | null => {
  const t = v?.trim();
  return t ? t : null;
};

/**
 * Update carrier / tracking on a shipment (core-requests.md R-2).
 * - Fields left undefined or null are unchanged (partial patch).
 * - No-op when nothing meaningful changes: no event, no audit, no hook (idempotent).
 * - `externalEventId` replays are ignored; an externally-originated change is flagged
 *   `external: true` on the hook so integrations do not push it back.
 * - On a real change: one order event + one TRACKING_UPDATED hook, inside the transaction.
 */
export async function updateShipmentTracking(shipmentId: string, tracking: TrackingPatch, actorId: string | null, externalEventId?: string | null): Promise<{ changed: boolean }> {
  return prisma.$transaction(async (tx) => {
    const s = await tx.shipment.findUnique({
      where: { id: shipmentId },
      select: { id: true, orderId: true, fulfillmentId: true, carrier: true, service: true, trackingNumber: true, trackingUrl: true, fulfillment: { select: { type: true } }, order: { select: { source: true, shopifyStoreId: true } } },
    });
    if (!s) throw new FulfillmentServiceError("NOT_FOUND", "Shipment not found.");
    if (externalEventId && (await hasProcessedEvent(s.orderId, externalEventId, tx))) return { changed: false };

    const previous: ShipmentTracking = { carrier: s.carrier, service: s.service, trackingNumber: s.trackingNumber, trackingUrl: s.trackingUrl };
    const next: ShipmentTracking = {
      carrier: tracking.carrier === undefined || tracking.carrier === null ? previous.carrier : normalise(tracking.carrier),
      service: tracking.service === undefined || tracking.service === null ? previous.service : normalise(tracking.service),
      trackingNumber: tracking.trackingNumber === undefined || tracking.trackingNumber === null ? previous.trackingNumber : normalise(tracking.trackingNumber),
      trackingUrl: tracking.trackingUrl === undefined || tracking.trackingUrl === null ? previous.trackingUrl : normalise(tracking.trackingUrl),
    };
    const changed = (Object.keys(next) as (keyof ShipmentTracking)[]).some((k) => next[k] !== previous[k]);
    if (!changed) return { changed: false };

    await tx.shipment.update({ where: { id: shipmentId }, data: next });
    await addEvent(tx, s.orderId, "tracking_updated", `Tracking updated${next.trackingNumber ? `: ${next.trackingNumber}` : ""}${next.carrier ? ` (${next.carrier})` : ""}`, actorId, { shipmentId, previous, next }, externalEventId);
    await recordAudit({ userId: actorId, action: "shipment.tracking_updated", entityType: "Shipment", entityId: shipmentId, oldValues: previous, newValues: next }, tx);
    await runShipmentHandlers(tx, {
      kind: "TRACKING_UPDATED",
      shipmentId: s.id,
      fulfillmentId: s.fulfillmentId,
      orderId: s.orderId,
      orderSource: s.order.source,
      shopifyStoreId: s.order.shopifyStoreId,
      external: s.fulfillment.type === "EXTERNAL" || !!externalEventId,
      tracking: next,
      previousTracking: previous,
      externalEventId: externalEventId ?? null,
    });
    return { changed: true };
  }, TX);
}

/**
 * Link a V3PL fulfilment to the external (Shopify) fulfillment that represents it
 * (core-requests.md R-1). No stock or status effect. Idempotent for the same reference;
 * conflicts surface as BAD_STATUS; the fulfilment's order must belong to the same store.
 */
export async function recordExternalReference(fulfillmentId: string, ref: { shopifyStoreId: string; shopifyFulfillmentId: string }, actorId: string | null): Promise<{ updated: boolean }> {
  const storeId = ref?.shopifyStoreId?.trim();
  const externalId = ref?.shopifyFulfillmentId?.trim();
  if (!fulfillmentId?.trim() || !storeId || !externalId) throw new FulfillmentServiceError("INVALID_REFERENCE", "Fulfilment id, store id and external fulfillment id are all required.");
  try {
    return await prisma.$transaction(async (tx) => {
      const f = await tx.fulfillment.findUnique({
        where: { id: fulfillmentId },
        select: { id: true, orderId: true, status: true, shopifyStoreId: true, shopifyFulfillmentId: true, order: { select: { shopifyStoreId: true, orderNumber: true } }, shipment: { select: { id: true } } },
      });
      if (!f) throw new FulfillmentServiceError("NOT_FOUND", "Fulfilment not found.");
      if (f.shopifyFulfillmentId === externalId && f.shopifyStoreId === storeId) return { updated: false };
      if (f.shopifyFulfillmentId) throw new FulfillmentServiceError("BAD_STATUS", "Fulfilment is already linked to another Shopify fulfillment.");
      if (f.order.shopifyStoreId !== storeId) throw new FulfillmentServiceError("BAD_STATUS", "Fulfilment belongs to an order of a different store.");
      if (f.status !== "SHIPPED") throw new FulfillmentServiceError("BAD_STATUS", "Only shipped fulfilments can be linked to an external fulfillment.");
      const ledgerActor = await ensureActor(tx, actorId);
      await tx.fulfillment.update({ where: { id: f.id }, data: { shopifyStoreId: storeId, shopifyFulfillmentId: externalId } });
      if (f.shipment) await tx.shipment.update({ where: { id: f.shipment.id }, data: { shopifySyncedAt: new Date() } });
      await addEvent(tx, f.orderId, "shopify_synced", `Fulfilment sent to Shopify (${externalId})`, actorId, { fulfillmentId: f.id, shipmentId: f.shipment?.id ?? null, shopifyStoreId: storeId, shopifyFulfillmentId: externalId });
      await recordAudit({ userId: ledgerActor, action: "shipment.shopify_synced", entityType: "Fulfillment", entityId: f.id, newValues: { shopifyStoreId: storeId, shopifyFulfillmentId: externalId } }, tx);
      return { updated: true };
    }, TX);
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") throw new FulfillmentServiceError("BAD_STATUS", "That Shopify fulfillment is already linked to another V3PL fulfilment.");
    throw err;
  }
}

export async function updateShipmentStatus(shipmentId: string, status: ShipmentStatus, actorId: string | null, externalEventId?: string | null) {
  return prisma.$transaction(async (tx) => {
    const s = await tx.shipment.findUnique({ where: { id: shipmentId }, select: { id: true, orderId: true, status: true } });
    if (!s) throw new FulfillmentServiceError("NOT_FOUND", "Shipment not found.");
    if (s.status === status) return;
    await tx.shipment.update({ where: { id: shipmentId }, data: { status, deliveredAt: status === "DELIVERED" ? new Date() : undefined } });
    await addEvent(tx, s.orderId, "shipment_status", `Shipment ${status.toLowerCase().replace("_", " ")}`, actorId, { shipmentId, from: s.status, to: status }, externalEventId);
    await recomputeOrder(tx, s.orderId);
  }, TX);
}

/** Warehouse work queue. */
export async function listFulfillmentQueue(status: FulfillmentRecordStatus | "OPEN", warehouseId?: string, page = 1, pageSize = 50) {
  const where: Prisma.FulfillmentWhereInput = { ...(status === "OPEN" ? { status: { in: ["PICKING", "PACKED"] } } : { status }), ...(warehouseId ? { warehouseId } : {}) };
  const [total, items] = await prisma.$transaction([
    prisma.fulfillment.count({ where }),
    prisma.fulfillment.findMany({
      where,
      orderBy: { createdAt: "asc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        order: { select: { id: true, orderNumber: true, shipName: true, customerName: true, shipCity: true, shipCountry: true, source: true } },
        warehouse: { select: { code: true } },
        items: { include: { orderItem: { select: { sku: true, title: true, variantTitle: true } }, location: { select: { label: true } } } },
        shipment: { select: { id: true, trackingNumber: true, carrier: true, status: true } },
      },
    }),
  ]);
  return { items, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}
