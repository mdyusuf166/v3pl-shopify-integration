import type { PresentedStatus } from "@/lib/order-presentation";
import type { FinancialStatus, FulfillmentStatus, OrderSource, OrderStatus, Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/server/services/audit";
import { InventoryError, releaseStock, reserveStock } from "@/server/services/inventory";
import { deriveFulfillmentStatus, deriveOrderStatus, remainingQty } from "@/server/services/order-status";

/**
 * ORDER SERVICE (spec §21–§27, §34–§35; D-008/D-009/D-013/D-028).
 *
 * - One customer order = one Order; every line carries its owner (denormalised from the SKU).
 * - Identity/idempotency: UNIQUE (shopifyStoreId, shopifyOrderId) and UNIQUE (source, sourceRef).
 *   Re-creating an existing order returns it instead of duplicating.
 * - Reservation state lives on OrderItem.reservedQty; the inventory service is the only
 *   writer of stock. reserveOrder() only ever reserves the *delta*, so it can be retried
 *   (webhook redelivery, "Reserve now") without double-reserving.
 * - Insufficient stock never fails an order: the line stays unreserved and the order is
 *   flagged needsAttention with the exact SKUs (D-028). Available never goes negative (D-007).
 * - Statuses are derived by order-status.ts after every change.
 */

export type OrderErrorCode =
  | "NOT_FOUND"
  | "UNKNOWN_SKU"
  | "SKU_INACTIVE"
  | "OWNER_MISMATCH"
  | "WAREHOUSE_REQUIRED"
  | "WAREHOUSE_INVALID"
  | "BAD_STATUS"
  | "INVALID_QUANTITY"
  | "LINE_NOT_FOUND"
  | "ALREADY_PROCESSED";

export class OrderServiceError extends Error {
  constructor(
    public readonly code: OrderErrorCode,
    message: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(message);
  }
}

type Db = Prisma.TransactionClient;
const TX = { timeout: 30_000, maxWait: 10_000 } as const;

export type CreateOrderLine = {
  variantId?: string;
  sku?: string;
  quantity: number;
  unitPrice?: string | number | null;
  discount?: string | number | null;
  tax?: string | number | null;
  title?: string | null;
  variantTitle?: string | null;
  requiresShipping?: boolean;
  externalLineId?: string | null;
  shopifyVariantId?: string | null;
};

export type ShipTo = {
  customerName?: string | null;
  customerEmail?: string | null;
  customerPhone?: string | null;
  shipName?: string | null;
  shipCompany?: string | null;
  shipAddress1?: string | null;
  shipAddress2?: string | null;
  shipCity?: string | null;
  shipProvince?: string | null;
  shipZip?: string | null;
  shipCountry?: string | null;
  shipPhone?: string | null;
};

export type CreateOrderInput = ShipTo & {
  source: OrderSource;
  /** Optional link to the customer directory (D-060); the ship-to snapshot above is still the order's own copy. */
  customerId?: string | null;
  /** External reference (CSV "Name"); unique per source. */
  sourceRef?: string | null;
  shopify?: {
    storeId: string;
    orderId: string;
    orderName?: string | null;
    financialStatus?: string | null;
    fulfillmentStatus?: string | null;
    updatedAt?: Date | null;
    cancelledAt?: Date | null;
  } | null;
  currency?: string | null;
  subtotal?: string | number | null;
  discountTotal?: string | number | null;
  taxTotal?: string | number | null;
  shippingTotal?: string | number | null;
  total?: string | number | null;
  shippingMethod?: string | null;
  financialStatus?: FinancialStatus | null;
  invoiceReference?: string | null;
  notes?: string | null;
  tags?: string | null;
  placedAt?: Date | null;
  /** Default warehouse for reservation/fulfilment. Required when `reserve` is true. */
  warehouseId?: string | null;
  /** 3PL portal submissions: all lines must belong to this owner (D-011). */
  submittedByOwnerId?: string | null;
  reserve: boolean;
  lines: CreateOrderLine[];
  externalEventId?: string | null;
};

export type ReservationOutcome = {
  reserved: { orderItemId: string; sku: string; quantity: number }[];
  short: { orderItemId: string; sku: string; requested: number; available: number }[];
};

export type CreateOrderResult = {
  orderId: string;
  orderNumber: string;
  /** false when an order with the same identity already existed (idempotent replay). */
  created: boolean;
  reservation: ReservationOutcome;
};

const money = (v: string | number | null | undefined) => (v === null || v === undefined || v === "" ? null : String(v));

/** Ledger rows need a user. Integration-driven changes (actorId null) are attributed to the first active admin. */
export async function ensureActor(tx: Db, actorId: string | null | undefined): Promise<string> {
  if (actorId) return actorId;
  const u = await tx.user.findFirst({ where: { role: "ADMIN", status: "ACTIVE" }, orderBy: { createdAt: "asc" }, select: { id: true } });
  if (!u) throw new OrderServiceError("NOT_FOUND", "No active administrator to attribute the change to.");
  return u.id;
}

async function nextOrderNumber(tx: Db): Promise<string> {
  const rows = await tx.$queryRaw<{ n: bigint }[]>`SELECT nextval('"Order_number_seq"') AS n`;
  return String(rows[0].n);
}

async function findExisting(input: CreateOrderInput) {
  if (input.shopify) {
    const o = await prisma.order.findUnique({ where: { shopifyStoreId_shopifyOrderId: { shopifyStoreId: input.shopify.storeId, shopifyOrderId: input.shopify.orderId } }, select: { id: true, orderNumber: true } });
    if (o) return o;
  }
  if (input.sourceRef) {
    const o = await prisma.order.findUnique({ where: { source_sourceRef: { source: input.source, sourceRef: input.sourceRef } }, select: { id: true, orderNumber: true } });
    if (o) return o;
  }
  return null;
}

/** Resolve lines to variants; enforce active status and (optionally) a single owner. */
async function resolveLines(db: Db, lines: CreateOrderLine[], restrictToOwnerId?: string | null) {
  const ids = lines.map((l) => l.variantId).filter((x): x is string => !!x);
  const skus = lines.map((l) => l.sku?.trim().toUpperCase()).filter((x): x is string => !!x);
  const variants = await db.productVariant.findMany({
    where: { OR: [{ id: { in: ids } }, { sku: { in: skus } }] },
    select: { id: true, sku: true, name: true, status: true, price: true, currency: true, product: { select: { id: true, name: true, ownerId: true, status: true } } },
  });
  const unknown: string[] = [];
  const inactive: string[] = [];
  const foreign: string[] = [];
  const resolved = lines.map((l) => {
    const v = l.variantId ? variants.find((x) => x.id === l.variantId) : variants.find((x) => x.sku === l.sku?.trim().toUpperCase());
    if (!v) {
      unknown.push(l.sku ?? l.variantId ?? "?");
      return null;
    }
    if (v.status !== "ACTIVE" || v.product.status !== "ACTIVE") inactive.push(v.sku);
    if (restrictToOwnerId && v.product.ownerId !== restrictToOwnerId) foreign.push(v.sku);
    return { line: l, variant: v };
  });
  if (unknown.length) throw new OrderServiceError("UNKNOWN_SKU", `Unknown SKU: ${unknown.join(", ")}`, { skus: unknown });
  if (inactive.length) throw new OrderServiceError("SKU_INACTIVE", `Archived SKU: ${inactive.join(", ")}`, { skus: inactive });
  if (foreign.length) throw new OrderServiceError("OWNER_MISMATCH", `SKU ${foreign.join(", ")} does not belong to this account.`, { skus: foreign });
  return resolved as { line: CreateOrderLine; variant: (typeof variants)[number] }[];
}

/** Reserve the unreserved remainder of every line. Never throws for stock shortage; reports it. */
async function reserveRemaining(tx: Db, orderId: string, actor: string | null, externalEventId?: string | null): Promise<ReservationOutcome> {
  const actorId = await ensureActor(tx, actor);
  const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { id: true, warehouseId: true, items: true } });
  const outcome: ReservationOutcome = { reserved: [], short: [] };
  for (const item of order.items) {
    const wanted = remainingQty(item) - item.reservedQty;
    if (wanted <= 0) continue;
    const warehouseId = item.warehouseId ?? order.warehouseId;
    if (!warehouseId) throw new OrderServiceError("WAREHOUSE_REQUIRED", "Choose a warehouse before reserving stock.");
    try {
      await reserveStock({ userId: actorId, variantId: item.variantId, warehouseId, quantity: wanted, refs: { orderId, orderItemId: item.id, externalEventId } }, tx);
      await tx.orderItem.update({ where: { id: item.id }, data: { reservedQty: item.reservedQty + wanted, warehouseId } });
      outcome.reserved.push({ orderItemId: item.id, sku: item.sku, quantity: wanted });
    } catch (err) {
      if (err instanceof InventoryError && err.code === "INSUFFICIENT_STOCK") {
        const available = Number(err.detail?.onHand ?? 0) - Number(err.detail?.reserved ?? 0);
        outcome.short.push({ orderItemId: item.id, sku: item.sku, requested: wanted, available: Math.max(0, available) });
        continue;
      }
      throw err;
    }
  }
  return outcome;
}

/** Recompute derived statuses + attention text from line state. Exported for fulfillment/returns. */
export async function recomputeOrder(tx: Db, orderId: string) {
  const order = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    select: { id: true, status: true, needsAttention: true, needsAttentionReason: true, items: true, fulfillments: { select: { status: true } }, shipments: { select: { status: true } } },
  });
  const fulfillmentStatus: FulfillmentStatus = deriveFulfillmentStatus(order.items, order.fulfillments, order.shipments);
  const status: OrderStatus = deriveOrderStatus(order.status, order.items);
  const data: Prisma.OrderUpdateInput = { fulfillmentStatus, status };
  if (status === "COMPLETED" && order.status !== "COMPLETED") data.completedAt = new Date();
  if (status === "CANCELLED" && order.status !== "CANCELLED") data.cancelledAt = new Date();
  await tx.order.update({ where: { id: orderId }, data });
  return { status, fulfillmentStatus };
}

async function setAttention(tx: Db, orderId: string, outcome: ReservationOutcome, actorId: string | null) {
  if (outcome.short.length > 0) {
    const reason = `Insufficient stock: ${outcome.short.map((s) => `${s.sku} (${s.requested} needed, ${s.available} available)`).join("; ")}`;
    await tx.order.update({ where: { id: orderId }, data: { needsAttention: true, needsAttentionReason: reason } });
    await addEvent(tx, orderId, "attention", reason, actorId, { short: outcome.short });
  } else {
    const o = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { needsAttention: true, needsAttentionReason: true } });
    if (o.needsAttention && o.needsAttentionReason?.startsWith("Insufficient stock")) {
      await tx.order.update({ where: { id: orderId }, data: { needsAttention: false, needsAttentionReason: null } });
    }
  }
}

export async function addEvent(tx: Db, orderId: string, type: string, message: string, userId: string | null, data?: Record<string, unknown>, externalEventId?: string | null) {
  await tx.orderEvent.create({ data: { orderId, type, message, userId, data: (data ?? undefined) as Prisma.InputJsonValue | undefined, externalEventId: externalEventId ?? null } });
}

/** Has this external event already been applied to the order? (webhook redelivery guard) */
export async function hasProcessedEvent(orderId: string, externalEventId: string, db: Db = prisma): Promise<boolean> {
  const n = await db.orderEvent.count({ where: { orderId, externalEventId } });
  return n > 0;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createOrder(input: CreateOrderInput, actorId: string | null): Promise<CreateOrderResult> {
  const existing = await findExisting(input);
  if (existing) {
    return { orderId: existing.id, orderNumber: existing.orderNumber, created: false, reservation: { reserved: [], short: [] } };
  }
  if (input.lines.length === 0) throw new OrderServiceError("INVALID_QUANTITY", "An order needs at least one line.");
  for (const l of input.lines) {
    if (!Number.isInteger(l.quantity) || l.quantity <= 0) throw new OrderServiceError("INVALID_QUANTITY", `Invalid quantity for ${l.sku ?? l.variantId}.`);
  }

  let warehouseId = input.warehouseId ?? null;
  if (!warehouseId) {
    const active = await prisma.warehouse.findMany({ where: { status: "ACTIVE" }, select: { id: true }, take: 2 });
    if (active.length === 1) warehouseId = active[0].id;
  }
  if (warehouseId) {
    const wh = await prisma.warehouse.findUnique({ where: { id: warehouseId }, select: { status: true } });
    if (!wh || wh.status !== "ACTIVE") throw new OrderServiceError("WAREHOUSE_INVALID", "Choose an active warehouse.");
  }
  if (input.reserve && !warehouseId) throw new OrderServiceError("WAREHOUSE_REQUIRED", "Choose the warehouse that will fulfil this order.");

  try {
    return await prisma.$transaction(async (tx) => {
      const resolved = await resolveLines(tx, input.lines, input.submittedByOwnerId ?? null);
      const orderNumber = await nextOrderNumber(tx);
      const order = await tx.order.create({
        data: {
          orderNumber,
          source: input.source,
          sourceRef: input.sourceRef ?? null,
          shopifyStoreId: input.shopify?.storeId ?? null,
          shopifyOrderId: input.shopify?.orderId ?? null,
          shopifyOrderName: input.shopify?.orderName ?? null,
          shopifyFinancialStatus: input.shopify?.financialStatus ?? null,
          shopifyFulfillmentStatus: input.shopify?.fulfillmentStatus ?? null,
          shopifyUpdatedAt: input.shopify?.updatedAt ?? null,
          shopifyCancelledAt: input.shopify?.cancelledAt ?? null,
          status: "NEW",
          financialStatus: input.financialStatus ?? "NOT_INVOICED",
          invoiceReference: input.invoiceReference ?? null,
          currency: input.currency ?? "USD",
          subtotal: money(input.subtotal),
          discountTotal: money(input.discountTotal),
          taxTotal: money(input.taxTotal),
          shippingTotal: money(input.shippingTotal),
          total: money(input.total),
          shippingMethod: input.shippingMethod ?? null,
          customerId: input.customerId ?? null,
          customerName: input.customerName ?? null,
          customerEmail: input.customerEmail ?? null,
          customerPhone: input.customerPhone ?? null,
          shipName: input.shipName ?? null,
          shipCompany: input.shipCompany ?? null,
          shipAddress1: input.shipAddress1 ?? null,
          shipAddress2: input.shipAddress2 ?? null,
          shipCity: input.shipCity ?? null,
          shipProvince: input.shipProvince ?? null,
          shipZip: input.shipZip ?? null,
          shipCountry: input.shipCountry ?? null,
          shipPhone: input.shipPhone ?? null,
          notes: input.notes ?? null,
          tags: input.tags ?? null,
          warehouseId,
          submittedByOwnerId: input.submittedByOwnerId ?? null,
          createdById: actorId,
          placedAt: input.placedAt ?? new Date(),
          items: {
            create: resolved.map(({ line, variant }, i) => ({
              variantId: variant.id,
              ownerId: variant.product.ownerId,
              position: i,
              sku: variant.sku,
              title: line.title ?? variant.product.name,
              variantTitle: line.variantTitle ?? variant.name,
              quantity: line.quantity,
              unitPrice: money(line.unitPrice) ?? variant.price ?? null,
              discount: money(line.discount),
              tax: money(line.tax),
              currency: input.currency ?? variant.currency ?? "USD",
              requiresShipping: line.requiresShipping ?? true,
              shopifyLineItemId: line.externalLineId ?? null,
              shopifyVariantId: line.shopifyVariantId ?? null,
            })),
          },
        },
        select: { id: true, orderNumber: true },
      });
      await addEvent(tx, order.id, "created", `Order ${order.orderNumber} created (${input.source.toLowerCase().replace("_", " ")})`, actorId, { source: input.source, sourceRef: input.sourceRef ?? null }, input.externalEventId);

      let reservation: ReservationOutcome = { reserved: [], short: [] };
      const cancelledExternally = !!input.shopify?.cancelledAt;
      if (input.reserve && !cancelledExternally) {
        reservation = await reserveRemaining(tx, order.id, actorId, input.externalEventId);
        if (reservation.reserved.length) await addEvent(tx, order.id, "reserved", `Reserved ${reservation.reserved.map((r) => `${r.quantity} × ${r.sku}`).join(", ")}`, actorId, undefined, input.externalEventId);
        await setAttention(tx, order.id, reservation, actorId);
      }
      if (cancelledExternally) {
        await tx.orderItem.updateMany({ where: { orderId: order.id }, data: { cancelledQty: 0 } });
        await tx.order.update({ where: { id: order.id }, data: { status: "CANCELLED", cancelledAt: input.shopify?.cancelledAt ?? new Date() } });
        await addEvent(tx, order.id, "cancelled", "Imported as already cancelled", actorId);
      }
      await recomputeOrder(tx, order.id);
      await recordAudit({ userId: actorId, action: "order.created", entityType: "Order", entityId: order.id, newValues: { orderNumber, source: input.source, lines: resolved.length } }, tx);
      return { orderId: order.id, orderNumber: order.orderNumber, created: true, reservation };
    }, TX);
  } catch (err) {
    // Concurrent duplicate (same identity created between our check and insert): treat as replay.
    if ((err as { code?: string }).code === "P2002") {
      const again = await findExisting(input);
      if (again) return { orderId: again.id, orderNumber: again.orderNumber, created: false, reservation: { reserved: [], short: [] } };
    }
    throw err;
  }
}

/** Shopify contract alias (shopify-integration.md §6). */
export const createExternal = createOrder;

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/** "Reserve now": reserve whatever is still unreserved (idempotent — only the delta). */
export async function reserveOrder(orderId: string, actorId: string, externalEventId?: string | null): Promise<ReservationOutcome> {
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId }, select: { id: true, status: true } });
    if (!order) throw new OrderServiceError("NOT_FOUND", "Order not found.");
    if (order.status === "CANCELLED") throw new OrderServiceError("BAD_STATUS", "Cancelled orders cannot be reserved.");
    const outcome = await reserveRemaining(tx, orderId, actorId, externalEventId);
    if (outcome.reserved.length) await addEvent(tx, orderId, "reserved", `Reserved ${outcome.reserved.map((r) => `${r.quantity} × ${r.sku}`).join(", ")}`, actorId, undefined, externalEventId);
    await setAttention(tx, orderId, outcome, actorId);
    await recomputeOrder(tx, orderId);
    return outcome;
  }, TX);
}

export async function confirmOrder(orderId: string, actorId: string) {
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId }, select: { status: true, orderNumber: true } });
    if (!order) throw new OrderServiceError("NOT_FOUND", "Order not found.");
    if (order.status !== "NEW" && order.status !== "DRAFT") throw new OrderServiceError("BAD_STATUS", `Order is ${order.status.toLowerCase()}.`);
    await tx.order.update({ where: { id: orderId }, data: { status: "CONFIRMED" } });
    await addEvent(tx, orderId, "confirmed", "Order confirmed", actorId);
    await recordAudit({ userId: actorId, action: "order.status_changed", entityType: "Order", entityId: orderId, oldValues: { status: order.status }, newValues: { status: "CONFIRMED" } }, tx);
  }, TX);
}

/**
 * Cancel: releases every unshipped reservation, cancels open fulfilments, marks the
 * unshipped remainder cancelled. Nothing shipped → CANCELLED; partially shipped → COMPLETED
 * with the remainder recorded as cancelled. Idempotent.
 */
export async function cancelOrder(orderId: string, reason: string, actorId: string | null, externalEventId?: string | null) {
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId }, include: { items: true, fulfillments: { where: { status: { in: ["PICKING", "PACKED"] } } } } });
    if (!order) throw new OrderServiceError("NOT_FOUND", "Order not found.");
    if (order.status === "CANCELLED") return { alreadyCancelled: true };
    if (externalEventId && (await hasProcessedEvent(orderId, externalEventId, tx))) return { alreadyCancelled: false, replay: true };
    const ledgerActor = await ensureActor(tx, actorId);
    for (const f of order.fulfillments) {
      await tx.fulfillment.update({ where: { id: f.id }, data: { status: "CANCELLED", cancelledAt: new Date() } });
    }
    for (const item of order.items) {
      const remaining = remainingQty(item);
      if (item.reservedQty > 0 && item.warehouseId) {
        await releaseStock({ userId: ledgerActor, variantId: item.variantId, warehouseId: item.warehouseId, quantity: item.reservedQty, reason: `Order cancelled: ${reason}`, refs: { orderId, orderItemId: item.id, externalEventId } }, tx);
      }
      if (remaining > 0 || item.reservedQty > 0) {
        await tx.orderItem.update({ where: { id: item.id }, data: { reservedQty: 0, cancelledQty: item.cancelledQty + remaining } });
      }
    }
    const anyShipped = order.items.some((i) => i.shippedQty > 0);
    await tx.order.update({ where: { id: orderId }, data: { status: anyShipped ? "COMPLETED" : "CANCELLED", cancelledAt: new Date(), needsAttention: false, needsAttentionReason: null } });
    await addEvent(tx, orderId, "cancelled", anyShipped ? `Unshipped remainder cancelled: ${reason}` : `Order cancelled: ${reason}`, actorId, { reason }, externalEventId);
    await recomputeOrder(tx, orderId);
    await recordAudit({ userId: actorId, action: "order.cancelled", entityType: "Order", entityId: orderId, newValues: { reason } }, tx);
    return { alreadyCancelled: false };
  }, TX);
}

/** Change a line's quantity (order edit / refund before shipment). Releases or reserves the difference. */
export async function adjustLineQuantity(orderId: string, orderItemId: string, newQuantity: number, reason: string, actorId: string | null, externalEventId?: string | null) {
  if (!Number.isInteger(newQuantity) || newQuantity < 0) throw new OrderServiceError("INVALID_QUANTITY", "Quantity must be a whole number ≥ 0.");
  return prisma.$transaction(async (tx) => {
    if (externalEventId && (await hasProcessedEvent(orderId, externalEventId, tx))) return { replay: true };
    const item = await tx.orderItem.findFirst({ where: { id: orderItemId, orderId }, include: { order: { select: { status: true, warehouseId: true } } } });
    if (!item) throw new OrderServiceError("LINE_NOT_FOUND", "Order line not found.");
    if (item.order.status === "CANCELLED") throw new OrderServiceError("BAD_STATUS", "Order is cancelled.");
    const inOpenFulfillment = await tx.fulfillmentItem.aggregate({ where: { orderItemId, fulfillment: { status: { in: ["PICKING", "PACKED"] } } }, _sum: { quantity: true } });
    const floor = item.shippedQty + item.cancelledQty + (inOpenFulfillment._sum.quantity ?? 0);
    const ledgerActor = await ensureActor(tx, actorId);
    if (newQuantity < floor) throw new OrderServiceError("INVALID_QUANTITY", `Quantity cannot go below ${floor} (already shipped, cancelled or being picked).`);
    if (newQuantity === 0) {
      // Zero → treat as line cancellation.
      if (item.reservedQty > 0 && item.warehouseId) {
        await releaseStock({ userId: ledgerActor, variantId: item.variantId, warehouseId: item.warehouseId, quantity: item.reservedQty, reason, refs: { orderId, orderItemId, externalEventId } }, tx);
      }
      await tx.orderItem.update({ where: { id: orderItemId }, data: { reservedQty: 0, cancelledQty: item.quantity - item.shippedQty } });
    } else {
      const newRemaining = newQuantity - item.shippedQty - item.cancelledQty;
      let reservedQty = item.reservedQty;
      if (reservedQty > newRemaining && item.warehouseId) {
        const release = reservedQty - newRemaining;
        await releaseStock({ userId: ledgerActor, variantId: item.variantId, warehouseId: item.warehouseId, quantity: release, reason, refs: { orderId, orderItemId, externalEventId } }, tx);
        reservedQty = newRemaining;
      }
      await tx.orderItem.update({ where: { id: orderItemId }, data: { quantity: newQuantity, reservedQty } });
      if (newQuantity > item.quantity && item.reservedQty > 0) {
        const outcome = await reserveRemaining(tx, orderId, actorId, externalEventId);
        await setAttention(tx, orderId, outcome, actorId);
      }
    }
    await addEvent(tx, orderId, "line_changed", `${item.sku}: quantity ${item.quantity} → ${newQuantity} (${reason})`, actorId, { orderItemId, from: item.quantity, to: newQuantity }, externalEventId);
    await recomputeOrder(tx, orderId);
    return { replay: false };
  }, TX);
}

export type ExternalPatch = Partial<Pick<CreateOrderInput, "financialStatus" | "notes" | "tags" | "customerEmail" | "customerPhone" | "shipName" | "shipCompany" | "shipAddress1" | "shipAddress2" | "shipCity" | "shipProvince" | "shipZip" | "shipCountry" | "shipPhone">> & {
  shopifyFinancialStatus?: string | null;
  shopifyFulfillmentStatus?: string | null;
  shopifyUpdatedAt?: Date | null;
};

/** Header-only sync from an external system (Shopify orders/updated). Lines are never touched here. */
export async function syncExternalUpdate(orderId: string, patch: ExternalPatch, actorId: string | null, externalEventId?: string | null) {
  return prisma.$transaction(async (tx) => {
    if (externalEventId && (await hasProcessedEvent(orderId, externalEventId, tx))) return { replay: true };
    const order = await tx.order.findUnique({ where: { id: orderId }, select: { id: true, shopifyUpdatedAt: true, fulfillmentStatus: true } });
    if (!order) throw new OrderServiceError("NOT_FOUND", "Order not found.");
    if (patch.shopifyUpdatedAt && order.shopifyUpdatedAt && patch.shopifyUpdatedAt <= order.shopifyUpdatedAt) return { replay: false, stale: true };
    const shipped = order.fulfillmentStatus !== "UNFULFILLED" && order.fulfillmentStatus !== "RESERVED";
    const { shopifyFinancialStatus, shopifyFulfillmentStatus, shopifyUpdatedAt, financialStatus, notes, tags, ...ship } = patch;
    const data: Prisma.OrderUpdateInput = { shopifyFinancialStatus, shopifyFulfillmentStatus, shopifyUpdatedAt, notes, tags };
    if (financialStatus) data.financialStatus = financialStatus;
    if (!shipped) Object.assign(data, ship); // address changes only while nothing has shipped
    await tx.order.update({ where: { id: orderId }, data });
    await addEvent(tx, orderId, "synced", "Order details synchronised from external system", actorId, patch as Record<string, unknown>, externalEventId);
    return { replay: false, stale: false };
  }, TX);
}

export async function flagAttention(orderId: string, reason: string, actorId: string | null) {
  await prisma.$transaction(async (tx) => {
    await tx.order.update({ where: { id: orderId }, data: { needsAttention: true, needsAttentionReason: reason } });
    await addEvent(tx, orderId, "attention", reason, actorId);
  });
}

export async function clearAttention(orderId: string, actorId: string | null) {
  await prisma.$transaction(async (tx) => {
    await tx.order.update({ where: { id: orderId }, data: { needsAttention: false, needsAttentionReason: null } });
    await addEvent(tx, orderId, "attention_cleared", "Attention flag cleared", actorId);
  });
}

export async function setFinancialStatus(orderId: string, financialStatus: FinancialStatus, invoiceReference: string | null, actorId: string) {
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId }, select: { financialStatus: true, invoiceReference: true } });
    if (!order) throw new OrderServiceError("NOT_FOUND", "Order not found.");
    await tx.order.update({ where: { id: orderId }, data: { financialStatus, invoiceReference } });
    await addEvent(tx, orderId, "financial", `Financial status: ${financialStatus.toLowerCase().replace("_", " ")}${invoiceReference ? ` · invoice ${invoiceReference}` : ""}`, actorId);
    await recordAudit({ userId: actorId, action: "order.financial_status_changed", entityType: "Order", entityId: orderId, oldValues: { ...order }, newValues: { financialStatus, invoiceReference } }, tx);
  });
}

export async function addOrderNote(orderId: string, message: string, actorId: string) {
  await prisma.$transaction(async (tx) => {
    await addEvent(tx, orderId, "note", message, actorId);
  });
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const ORDER_PAGE_SIZE = 25;

export type OrderListParams = {
  q?: string;
  status?: OrderStatus | "ALL" | "OPEN";
  fulfillmentStatus?: FulfillmentStatus | "ALL";
  /** Customer-facing status filter (D-055); combined with `status` when both are given. */
  view?: PresentedStatus | "ALL";
  source?: OrderSource | "ALL";
  /** Admin filter OR portal scope (see `scopeOwnerId`). */
  ownerId?: string;
  /** Portal scope: only orders containing this owner's lines; lines are filtered too. */
  scopeOwnerId?: string;
  warehouseId?: string;
  needsAttention?: boolean;
  from?: Date;
  to?: Date;
  page?: number;
  pageSize?: number;
};

/** Database predicate for a customer-facing status (D-055). RETURNED approximates "has a return". */
function presentedStatusWhere(view: PresentedStatus | "ALL" | undefined): Prisma.OrderWhereInput {
  switch (view) {
    case "CANCELLED":
      return { status: "CANCELLED" };
    case "UNFULFILLED":
      return { status: { not: "CANCELLED" }, fulfillmentStatus: { in: ["UNFULFILLED", "RESERVED", "PICKING", "PACKED"] } };
    case "PARTIALLY_FULFILLED":
      return { status: { not: "CANCELLED" }, fulfillmentStatus: "PARTIALLY_SHIPPED" };
    case "FULFILLED":
      return { status: { not: "CANCELLED" }, fulfillmentStatus: "SHIPPED" };
    case "DELIVERED":
      return { status: { not: "CANCELLED" }, fulfillmentStatus: "FULFILLED" };
    case "RETURNED":
      return { status: { not: "CANCELLED" }, returns: { some: {} } };
    default:
      return {};
  }
}

export function orderWhere(params: OrderListParams): Prisma.OrderWhereInput {
  const ownerId = params.scopeOwnerId ?? params.ownerId;
  return {
    ...(params.status === "OPEN" ? { status: { in: ["NEW", "CONFIRMED"] } } : params.status && params.status !== "ALL" ? { status: params.status } : {}),
    ...(params.fulfillmentStatus && params.fulfillmentStatus !== "ALL" ? { fulfillmentStatus: params.fulfillmentStatus } : {}),
    ...presentedStatusWhere(params.view),
    ...(params.source && params.source !== "ALL" ? { source: params.source } : {}),
    ...(params.warehouseId ? { OR: [{ warehouseId: params.warehouseId }, { items: { some: { warehouseId: params.warehouseId } } }] } : {}),
    ...(params.needsAttention ? { needsAttention: true } : {}),
    ...(ownerId ? { items: { some: { ownerId } } } : {}),
    ...(params.from || params.to ? { placedAt: { ...(params.from ? { gte: params.from } : {}), ...(params.to ? { lte: params.to } : {}) } } : {}),
    ...(params.q
      ? {
          OR: [
            { orderNumber: { contains: params.q, mode: "insensitive" } },
            { sourceRef: { contains: params.q, mode: "insensitive" } },
            { shopifyOrderName: { contains: params.q, mode: "insensitive" } },
            { customerName: { contains: params.q, mode: "insensitive" } },
            { customerEmail: { contains: params.q, mode: "insensitive" } },
            { shipName: { contains: params.q, mode: "insensitive" } },
            { items: { some: { sku: { contains: params.q, mode: "insensitive" }, ...(ownerId ? { ownerId } : {}) } } },
            { shipments: { some: { trackingNumber: { contains: params.q, mode: "insensitive" } } } },
          ],
        }
      : {}),
  };
}

export async function listOrders(params: OrderListParams) {
  const page = Math.max(1, params.page ?? 1);
  const pageSize = params.pageSize ?? ORDER_PAGE_SIZE;
  const where = orderWhere(params);
  const [total, items] = await prisma.$transaction([
    prisma.order.count({ where }),
    prisma.order.findMany({
      where,
      orderBy: { placedAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        orderNumber: true,
        source: true,
        sourceRef: true,
        shopifyOrderName: true,
        status: true,
        fulfillmentStatus: true,
        financialStatus: true,
        needsAttention: true,
        customerName: true,
        shipName: true,
        total: true,
        currency: true,
        placedAt: true,
        warehouse: { select: { code: true } },
        items: { where: params.scopeOwnerId ? { ownerId: params.scopeOwnerId } : undefined, select: { id: true, sku: true, quantity: true, shippedQty: true, returnedQty: true, cancelledQty: true, ownerId: true, owner: { select: { code: true, businessName: true } } } },
        shipments: { select: { status: true }, orderBy: { shippedAt: "desc" }, take: 1 },
      },
    }),
  ]);
  return { items, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

/** Full order. With `scopeOwnerId`, only that owner's lines are returned and totals are hidden. */
export async function getOrder(id: string, scopeOwnerId?: string) {
  const order = await prisma.order.findFirst({
    where: { id, ...(scopeOwnerId ? { items: { some: { ownerId: scopeOwnerId } } } : {}) },
    include: {
      warehouse: { select: { id: true, code: true, name: true } },
      createdBy: { select: { name: true } },
      submittedByOwner: { select: { businessName: true } },
      customer: { select: { id: true, name: true } },
      items: {
        where: scopeOwnerId ? { ownerId: scopeOwnerId } : undefined,
        orderBy: { position: "asc" },
        include: { owner: { select: { id: true, code: true, businessName: true, type: true } }, variant: { select: { productId: true } }, warehouse: { select: { code: true } } },
      },
      fulfillments: {
        orderBy: { createdAt: "asc" },
        include: { warehouse: { select: { code: true } }, createdBy: { select: { name: true } }, items: { include: { orderItem: { select: { sku: true, ownerId: true } }, location: { select: { label: true } } } }, shipment: { select: { id: true } } },
      },
      shipments: { orderBy: { shippedAt: "asc" }, include: { items: { include: { orderItem: { select: { sku: true, ownerId: true } } } }, createdBy: { select: { name: true } } } },
      returns: { orderBy: { receivedAt: "asc" }, include: { warehouse: { select: { code: true } }, receivedBy: { select: { name: true } }, items: { include: { orderItem: { select: { sku: true, ownerId: true } }, location: { select: { label: true } } } } } },
      events: { orderBy: { createdAt: "asc" }, include: { user: { select: { name: true } } } },
    },
  });
  if (!order) return null;
  if (scopeOwnerId) {
    // Hide other owners' lines inside fulfilments/shipments/returns and hide money totals.
    return {
      ...order,
      subtotal: null,
      discountTotal: null,
      taxTotal: null,
      shippingTotal: null,
      total: null,
      fulfillments: order.fulfillments.map((f) => ({ ...f, items: f.items.filter((i) => i.orderItem.ownerId === scopeOwnerId) })).filter((f) => f.items.length > 0),
      shipments: order.shipments.map((s) => ({ ...s, items: s.items.filter((i) => i.orderItem.ownerId === scopeOwnerId) })).filter((s) => s.items.length > 0),
      returns: order.returns.map((r) => ({ ...r, items: r.items.filter((i) => i.orderItem.ownerId === scopeOwnerId) })).filter((r) => r.items.length > 0),
    };
  }
  return order;
}

export type OrderDetail = NonNullable<Awaited<ReturnType<typeof getOrder>>>;

// ---------------------------------------------------------------------------
// Deletion (D-054)
// ---------------------------------------------------------------------------

export type OrderDeleteCheck = { canDelete: boolean; blockers: string[] };

/**
 * An order can be hard-deleted only while it left no trace in the ledger and has no fulfilment,
 * shipment or return records — i.e. it was never reserved, picked or shipped. Shopify-sourced
 * orders are never deleted here (the store connection would re-import them; cancel in Shopify).
 * Everything else is cancelled, which keeps history and releases stock.
 */
export async function orderDeleteCheck(orderId: string): Promise<OrderDeleteCheck> {
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { source: true, _count: { select: { transactions: true, fulfillments: true, shipments: true, returns: true } } } });
  if (!order) return { canDelete: false, blockers: ["Order not found"] };
  const blockers: string[] = [];
  if (order.source === "SHOPIFY") blockers.push("Imported from Shopify — cancel it in Shopify instead");
  if (order._count.transactions > 0) blockers.push("Stock was reserved, shipped or released for this order (ledger history)");
  if (order._count.fulfillments > 0) blockers.push("Has picking / packing records");
  if (order._count.shipments > 0) blockers.push("Has shipments");
  if (order._count.returns > 0) blockers.push("Has returns");
  return { canDelete: blockers.length === 0, blockers };
}

export async function deleteOrder(orderId: string, actorId: string) {
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { id: true, orderNumber: true, source: true, sourceRef: true, status: true, items: { select: { sku: true, quantity: true } } } });
  if (!order) throw new OrderServiceError("NOT_FOUND", "Order not found.");
  const check = await orderDeleteCheck(orderId);
  if (!check.canDelete) throw new OrderServiceError("BAD_STATUS", `Order ${order.orderNumber} cannot be deleted: ${check.blockers.join("; ")}. Cancel it instead — cancelling keeps the history.`);
  await prisma.$transaction(async (tx) => {
    await tx.shopifySyncLog.updateMany({ where: { orderId }, data: { orderId: null } });
    await tx.orderEvent.deleteMany({ where: { orderId } });
    await tx.orderItem.deleteMany({ where: { orderId } });
    await tx.order.delete({ where: { id: orderId } });
    await recordAudit({ userId: actorId, action: "order.deleted", entityType: "Order", entityId: orderId, oldValues: { orderNumber: order.orderNumber, source: order.source, sourceRef: order.sourceRef, status: order.status, items: order.items } }, tx);
  }, TX);
  return { orderNumber: order.orderNumber };
}

/** Dashboard counters. */
export async function orderCounters(scopeOwnerId?: string) {
  const scope = scopeOwnerId ? { items: { some: { ownerId: scopeOwnerId } } } : {};
  const [open, picking, packed, attention, shippedToday] = await prisma.$transaction([
    prisma.order.count({ where: { ...scope, status: { in: ["NEW", "CONFIRMED"] } } }),
    prisma.order.count({ where: { ...scope, fulfillmentStatus: "PICKING" } }),
    prisma.order.count({ where: { ...scope, fulfillmentStatus: "PACKED" } }),
    prisma.order.count({ where: { ...scope, needsAttention: true } }),
    prisma.shipment.count({ where: { shippedAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) }, ...(scopeOwnerId ? { items: { some: { orderItem: { ownerId: scopeOwnerId } } } } : {}) } }),
  ]);
  return { open, picking, packed, attention, shippedToday };
}
