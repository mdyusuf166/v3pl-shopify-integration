import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import type { ReceivingFormValues } from "@/lib/validation/inventory";
import { recordAudit } from "@/server/services/audit";
import { receiveStock } from "@/server/services/inventory";

/**
 * Receiving (spec §16). A receiving record is posted immediately: the record, its
 * lines and the RECEIVE ledger rows are written in one transaction.
 */

export class ReceivingServiceError extends Error {
  constructor(
    public readonly code: "OWNER_INVALID" | "WAREHOUSE_INVALID" | "SKU_OWNER_MISMATCH" | "NOT_FOUND",
    message: string,
    public readonly field?: string,
  ) {
    super(message);
  }
}

export const RECEIVING_PAGE_SIZE = 25;

export async function createReceiving(values: ReceivingFormValues, actorId: string) {
  const [owner, warehouse] = await Promise.all([
    prisma.owner.findUnique({ where: { id: values.ownerId }, select: { id: true, status: true, businessName: true } }),
    prisma.warehouse.findUnique({ where: { id: values.warehouseId }, select: { id: true, status: true, code: true } }),
  ]);
  if (!owner || owner.status !== "ACTIVE") throw new ReceivingServiceError("OWNER_INVALID", "Choose an active vendor / 3PL client.", "ownerId");
  if (!warehouse || warehouse.status !== "ACTIVE") throw new ReceivingServiceError("WAREHOUSE_INVALID", "Choose an active warehouse.", "warehouseId");

  // Every SKU on the receipt must belong to the receipt's owner (spec §5 ownership rule).
  const variants = await prisma.productVariant.findMany({
    where: { id: { in: values.lines.map((l) => l.variantId) } },
    select: { id: true, sku: true, product: { select: { ownerId: true } } },
  });
  const foreign = variants.filter((v) => v.product.ownerId !== values.ownerId);
  if (foreign.length > 0) {
    throw new ReceivingServiceError("SKU_OWNER_MISMATCH", `SKU ${foreign.map((v) => v.sku).join(", ")} does not belong to ${owner.businessName}.`, "lines");
  }
  if (variants.length !== new Set(values.lines.map((l) => l.variantId)).size) throw new ReceivingServiceError("NOT_FOUND", "One of the SKUs no longer exists.", "lines");

  return prisma.$transaction(
    async (tx) => {
      const record = await tx.receivingRecord.create({
        data: {
          ownerId: values.ownerId,
          warehouseId: values.warehouseId,
          reference: values.reference ?? null,
          notes: values.notes ?? null,
          receivedAt: values.receivedAt ?? new Date(),
          userId: actorId,
          items: { create: values.lines.map((l) => ({ variantId: l.variantId, locationId: l.locationId, quantity: l.quantity })) },
        },
        select: { id: true, reference: true },
      });
      await receiveStock({ userId: actorId, warehouseId: values.warehouseId, receivingId: record.id, reference: record.reference, lines: values.lines }, tx);
      await recordAudit(
        { userId: actorId, action: "inventory.received", entityType: "ReceivingRecord", entityId: record.id, newValues: { ownerId: values.ownerId, warehouseId: values.warehouseId, reference: values.reference ?? null, lines: values.lines.length, units: values.lines.reduce((s, l) => s + l.quantity, 0) } },
        tx,
      );
      return record;
    },
    { timeout: 30_000, maxWait: 10_000 },
  );
}

export type ReceivingListParams = { ownerId?: string; warehouseId?: string; q?: string; page?: number };

export async function listReceivings(params: ReceivingListParams) {
  const page = Math.max(1, params.page ?? 1);
  const where: Prisma.ReceivingRecordWhereInput = {
    ...(params.ownerId ? { ownerId: params.ownerId } : {}),
    ...(params.warehouseId ? { warehouseId: params.warehouseId } : {}),
    ...(params.q ? { OR: [{ reference: { contains: params.q, mode: "insensitive" } }, { items: { some: { variant: { sku: { contains: params.q, mode: "insensitive" } } } } }] } : {}),
  };
  const [total, items] = await prisma.$transaction([
    prisma.receivingRecord.count({ where }),
    prisma.receivingRecord.findMany({
      where,
      orderBy: { receivedAt: "desc" },
      skip: (page - 1) * RECEIVING_PAGE_SIZE,
      take: RECEIVING_PAGE_SIZE,
      select: {
        id: true,
        reference: true,
        receivedAt: true,
        notes: true,
        owner: { select: { id: true, code: true, businessName: true } },
        warehouse: { select: { id: true, code: true } },
        user: { select: { name: true } },
        items: { select: { quantity: true } },
      },
    }),
  ]);
  return {
    items: items.map((r) => ({ ...r, lineCount: r.items.length, units: r.items.reduce((s, i) => s + i.quantity, 0) })),
    total,
    page,
    pageSize: RECEIVING_PAGE_SIZE,
    pageCount: Math.max(1, Math.ceil(total / RECEIVING_PAGE_SIZE)),
  };
}

export async function getReceiving(id: string, ownerId?: string) {
  return prisma.receivingRecord.findFirst({
    where: { id, ...(ownerId ? { ownerId } : {}) },
    include: {
      owner: { select: { id: true, code: true, businessName: true, type: true } },
      warehouse: { select: { id: true, code: true, name: true } },
      user: { select: { name: true } },
      items: { include: { variant: { select: { id: true, sku: true, name: true, product: { select: { id: true, name: true } } } }, location: { select: { label: true } } } },
    },
  });
}
