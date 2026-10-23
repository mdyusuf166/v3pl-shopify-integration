import type { Prisma, ReturnCondition } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/server/services/audit";
import { adjustStock, returnStock } from "@/server/services/inventory";
import { addEvent, recomputeOrder } from "@/server/services/orders";
import { getDefaultLocation } from "@/server/services/warehouses";

/**
 * RETURNS (spec §15/§19): receive → inspect → restock (SELLABLE) or write off (DAMAGED).
 * Receiving a return has NO stock effect; units become available only after inspection.
 * Damaged units are booked in (RETURN) and immediately out (DAMAGE) so the ledger shows
 * both the return and the write-off without ever making them available.
 */

const TX = { timeout: 30_000, maxWait: 10_000 } as const;

export class ReturnServiceError extends Error {
  constructor(
    public readonly code: "NOT_FOUND" | "INVALID_QUANTITY" | "BAD_STATUS" | "WAREHOUSE_INVALID",
    message: string,
  ) {
    super(message);
  }
}

export async function receiveReturn(input: { orderId: string; warehouseId: string; reference?: string | null; reason?: string | null; notes?: string | null; lines: { orderItemId: string; quantity: number }[] }, actorId: string) {
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({ where: { id: input.orderId }, include: { items: true } });
    if (!order) throw new ReturnServiceError("NOT_FOUND", "Order not found.");
    const wh = await tx.warehouse.findUnique({ where: { id: input.warehouseId }, select: { status: true } });
    if (!wh || wh.status !== "ACTIVE") throw new ReturnServiceError("WAREHOUSE_INVALID", "Choose an active warehouse.");
    const pending = await tx.returnItem.groupBy({ by: ["orderItemId"], where: { orderItem: { orderId: input.orderId }, return: { status: "RECEIVED" } }, _sum: { quantity: true } });
    const lines = input.lines.map((l) => {
      const item = order.items.find((i) => i.id === l.orderItemId);
      if (!item) throw new ReturnServiceError("NOT_FOUND", "Order line not found.");
      const awaiting = pending.find((p) => p.orderItemId === item.id)?._sum.quantity ?? 0;
      const returnable = item.shippedQty - item.returnedQty - awaiting;
      if (!Number.isInteger(l.quantity) || l.quantity <= 0) throw new ReturnServiceError("INVALID_QUANTITY", `Invalid quantity for ${item.sku}.`);
      if (l.quantity > returnable) throw new ReturnServiceError("INVALID_QUANTITY", `${item.sku}: only ${returnable} shipped units can still be returned.`);
      return { item, quantity: l.quantity };
    });
    const ret = await tx.return.create({
      data: {
        orderId: order.id,
        warehouseId: input.warehouseId,
        reference: input.reference ?? null,
        reason: input.reason ?? null,
        notes: input.notes ?? null,
        receivedById: actorId,
        items: { create: lines.map((l) => ({ orderItemId: l.item.id, variantId: l.item.variantId, ownerId: l.item.ownerId, quantity: l.quantity })) },
      },
      select: { id: true },
    });
    await addEvent(tx, order.id, "return_received", `Return received: ${lines.map((l) => `${l.quantity} × ${l.item.sku}`).join(", ")} — awaiting inspection`, actorId, { returnId: ret.id });
    await recordAudit({ userId: actorId, action: "return.received", entityType: "Return", entityId: ret.id, newValues: { orderId: order.id, lines: lines.length } }, tx);
    return ret;
  }, TX);
}

export async function inspectReturn(returnId: string, input: { lines: { returnItemId: string; condition: ReturnCondition; locationId?: string | null; notes?: string | null }[] }, actorId: string) {
  return prisma.$transaction(async (tx) => {
    const ret = await tx.return.findUnique({ where: { id: returnId }, include: { items: { include: { orderItem: true } } } });
    if (!ret) throw new ReturnServiceError("NOT_FOUND", "Return not found.");
    if (ret.status !== "RECEIVED") throw new ReturnServiceError("BAD_STATUS", "This return has already been inspected.");
    const fallback = (await getDefaultLocation(ret.warehouseId, tx))?.id ?? null;
    const summary: string[] = [];
    for (const ri of ret.items) {
      const decision = input.lines.find((l) => l.returnItemId === ri.id);
      if (!decision) throw new ReturnServiceError("INVALID_QUANTITY", `Decide the condition of ${ri.orderItem.sku}.`);
      const locationId = decision.locationId ?? fallback;
      if (!locationId) throw new ReturnServiceError("WAREHOUSE_INVALID", "Warehouse has no location to receive into.");
      await returnStock({ userId: actorId, variantId: ri.variantId, warehouseId: ret.warehouseId, locationId, quantity: ri.quantity, reason: decision.condition === "SELLABLE" ? "Customer return — restocked" : "Customer return — damaged", refs: { orderId: ret.orderId, orderItemId: ri.orderItemId } }, tx);
      if (decision.condition === "DAMAGED") {
        await adjustStock({ userId: actorId, variantId: ri.variantId, warehouseId: ret.warehouseId, locationId, kind: "DAMAGE", quantity: ri.quantity, reason: `Damaged return${ret.reference ? ` ${ret.reference}` : ""}`, notes: decision.notes ?? ret.reason ?? null, refs: { orderId: ret.orderId, orderItemId: ri.orderItemId } }, tx);
      }
      await tx.returnItem.update({ where: { id: ri.id }, data: { condition: decision.condition, locationId, inspectionNotes: decision.notes ?? null } });
      await tx.orderItem.update({ where: { id: ri.orderItemId }, data: { returnedQty: ri.orderItem.returnedQty + ri.quantity } });
      summary.push(`${ri.quantity} × ${ri.orderItem.sku} ${decision.condition === "SELLABLE" ? "restocked" : "damaged"}`);
    }
    await tx.return.update({ where: { id: returnId }, data: { status: "INSPECTED", inspectedAt: new Date(), inspectedById: actorId } });
    await addEvent(tx, ret.orderId, "return_inspected", `Return inspected: ${summary.join(", ")}`, actorId, { returnId });
    await recomputeOrder(tx, ret.orderId);
    await recordAudit({ userId: actorId, action: "return.inspected", entityType: "Return", entityId: returnId, newValues: { lines: input.lines } }, tx);
  }, TX);
}

export async function listReturns(params: { status?: "RECEIVED" | "INSPECTED" | "ALL"; scopeOwnerId?: string; page?: number; pageSize?: number }) {
  const page = Math.max(1, params.page ?? 1);
  const pageSize = params.pageSize ?? 25;
  const where: Prisma.ReturnWhereInput = {
    ...(params.status && params.status !== "ALL" ? { status: params.status } : {}),
    ...(params.scopeOwnerId ? { items: { some: { ownerId: params.scopeOwnerId } } } : {}),
  };
  const [total, items] = await prisma.$transaction([
    prisma.return.count({ where }),
    prisma.return.findMany({
      where,
      orderBy: { receivedAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { order: { select: { id: true, orderNumber: true } }, warehouse: { select: { code: true } }, receivedBy: { select: { name: true } }, items: { where: params.scopeOwnerId ? { ownerId: params.scopeOwnerId } : undefined, select: { quantity: true, condition: true } } },
    }),
  ]);
  return { items, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}
