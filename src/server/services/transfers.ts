import type { Prisma, TransferStatus } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import type { TransferFormValues } from "@/lib/validation/inventory";
import { recordAudit } from "@/server/services/audit";
import { transferIn, transferOut } from "@/server/services/inventory";
import { getDefaultLocation } from "@/server/services/warehouses";

/**
 * Warehouse-to-warehouse transfers (spec §18).
 *   create   → PENDING: TRANSFER_OUT at the source (stock in transit, available drops at once)
 *   complete → COMPLETED: TRANSFER_IN at the destination locations chosen by the receiver
 *   cancel   → CANCELLED: TRANSFER_IN back to the original source locations
 * Both sides are visible in the ledger through `transferId`.
 */

export class TransferServiceError extends Error {
  constructor(
    public readonly code: "NOT_FOUND" | "WAREHOUSE_INVALID" | "BAD_STATUS" | "LINES_MISMATCH",
    message: string,
    public readonly field?: string,
  ) {
    super(message);
  }
}

export const TRANSFER_PAGE_SIZE = 25;
const TX = { timeout: 30_000, maxWait: 10_000 } as const;

export async function createTransfer(values: TransferFormValues, actorId: string) {
  const [source, dest] = await Promise.all([
    prisma.warehouse.findUnique({ where: { id: values.sourceWarehouseId }, select: { id: true, status: true } }),
    prisma.warehouse.findUnique({ where: { id: values.destWarehouseId }, select: { id: true, status: true } }),
  ]);
  if (!source || source.status !== "ACTIVE") throw new TransferServiceError("WAREHOUSE_INVALID", "Choose an active source warehouse.", "sourceWarehouseId");
  if (!dest || dest.status !== "ACTIVE") throw new TransferServiceError("WAREHOUSE_INVALID", "Choose an active destination warehouse.", "destWarehouseId");

  return prisma.$transaction(async (tx) => {
    const transfer = await tx.transfer.create({
      data: {
        sourceWarehouseId: values.sourceWarehouseId,
        destWarehouseId: values.destWarehouseId,
        reference: values.reference ?? null,
        notes: values.notes ?? null,
        createdById: actorId,
        items: { create: values.lines.map((l) => ({ variantId: l.variantId, sourceLocationId: l.sourceLocationId, quantity: l.quantity })) },
      },
      select: { id: true, reference: true },
    });
    await transferOut(
      { userId: actorId, transferId: transfer.id, warehouseId: values.sourceWarehouseId, lines: values.lines.map((l) => ({ variantId: l.variantId, locationId: l.sourceLocationId, quantity: l.quantity })), reason: `Transfer ${transfer.reference ?? transfer.id.slice(-6)} out` },
      tx,
    );
    await recordAudit({ userId: actorId, action: "transfer.created", entityType: "Transfer", entityId: transfer.id, newValues: { ...values, lines: values.lines.length } }, tx);
    return transfer;
  }, TX);
}

/** Receiver books the goods into destination locations (defaults to the destination's MAIN location). */
export async function completeTransfer(id: string, destLocations: { itemId: string; destLocationId: string }[] | undefined, actorId: string) {
  const transfer = await prisma.transfer.findUnique({ where: { id }, include: { items: true } });
  if (!transfer) throw new TransferServiceError("NOT_FOUND", "Transfer not found.");
  if (transfer.status !== "PENDING") throw new TransferServiceError("BAD_STATUS", `Transfer is already ${transfer.status.toLowerCase()}.`);

  return prisma.$transaction(async (tx) => {
    const fallback = await getDefaultLocation(transfer.destWarehouseId, tx);
    const lines = transfer.items.map((item) => {
      const chosen = destLocations?.find((d) => d.itemId === item.id)?.destLocationId ?? fallback?.id;
      if (!chosen) throw new TransferServiceError("LINES_MISMATCH", "Destination warehouse has no location to receive into.");
      return { itemId: item.id, variantId: item.variantId, locationId: chosen, quantity: item.quantity };
    });
    for (const l of lines) await tx.transferItem.update({ where: { id: l.itemId }, data: { destLocationId: l.locationId } });
    await transferIn({ userId: actorId, transferId: id, warehouseId: transfer.destWarehouseId, lines, reason: `Transfer ${transfer.reference ?? id.slice(-6)} in` }, tx);
    const updated = await tx.transfer.update({ where: { id }, data: { status: "COMPLETED", completedAt: new Date(), completedById: actorId } });
    await recordAudit({ userId: actorId, action: "transfer.completed", entityType: "Transfer", entityId: id, newValues: { lines: lines.length } }, tx);
    return updated;
  }, TX);
}

/** Cancel a pending transfer: stock returns to its original source locations. */
export async function cancelTransfer(id: string, reason: string, actorId: string) {
  const transfer = await prisma.transfer.findUnique({ where: { id }, include: { items: true } });
  if (!transfer) throw new TransferServiceError("NOT_FOUND", "Transfer not found.");
  if (transfer.status !== "PENDING") throw new TransferServiceError("BAD_STATUS", `Transfer is already ${transfer.status.toLowerCase()}.`);

  return prisma.$transaction(async (tx) => {
    await transferIn(
      { userId: actorId, transferId: id, warehouseId: transfer.sourceWarehouseId, lines: transfer.items.map((i) => ({ variantId: i.variantId, locationId: i.sourceLocationId, quantity: i.quantity })), reason: `Transfer cancelled: ${reason}` },
      tx,
    );
    const updated = await tx.transfer.update({ where: { id }, data: { status: "CANCELLED", cancelledAt: new Date(), notes: [transfer.notes, `Cancelled: ${reason}`].filter(Boolean).join("\n") } });
    await recordAudit({ userId: actorId, action: "transfer.cancelled", entityType: "Transfer", entityId: id, newValues: { reason } }, tx);
    return updated;
  }, TX);
}

export type TransferListParams = { status?: TransferStatus | "ALL"; warehouseId?: string; page?: number };

export async function listTransfers(params: TransferListParams) {
  const page = Math.max(1, params.page ?? 1);
  const where: Prisma.TransferWhereInput = {
    ...(params.status && params.status !== "ALL" ? { status: params.status } : {}),
    ...(params.warehouseId ? { OR: [{ sourceWarehouseId: params.warehouseId }, { destWarehouseId: params.warehouseId }] } : {}),
  };
  const [total, items] = await prisma.$transaction([
    prisma.transfer.count({ where }),
    prisma.transfer.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * TRANSFER_PAGE_SIZE,
      take: TRANSFER_PAGE_SIZE,
      select: {
        id: true,
        reference: true,
        status: true,
        createdAt: true,
        completedAt: true,
        sourceWarehouse: { select: { id: true, code: true } },
        destWarehouse: { select: { id: true, code: true } },
        createdBy: { select: { name: true } },
        items: { select: { quantity: true } },
      },
    }),
  ]);
  return {
    items: items.map((t) => ({ ...t, lineCount: t.items.length, units: t.items.reduce((s, i) => s + i.quantity, 0) })),
    total,
    page,
    pageSize: TRANSFER_PAGE_SIZE,
    pageCount: Math.max(1, Math.ceil(total / TRANSFER_PAGE_SIZE)),
  };
}

export async function getTransfer(id: string) {
  return prisma.transfer.findUnique({
    where: { id },
    include: {
      sourceWarehouse: { select: { id: true, code: true, name: true } },
      destWarehouse: { select: { id: true, code: true, name: true } },
      createdBy: { select: { name: true } },
      completedBy: { select: { name: true } },
      items: {
        include: {
          variant: { select: { id: true, sku: true, name: true, product: { select: { name: true, owner: { select: { businessName: true } } } } } },
          sourceLocation: { select: { id: true, label: true } },
          destLocation: { select: { id: true, label: true } },
        },
      },
    },
  });
}
