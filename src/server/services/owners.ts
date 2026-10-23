import type { OwnerStatus, OwnerType, Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import type { OwnerFormValues } from "@/lib/validation/owners";
import { recordAudit } from "@/server/services/audit";

/**
 * Owner service — vendors and 3PL clients (D-003).
 * Owners are never hard-deleted; they are set INACTIVE.
 * All mutations are audited in the same transaction.
 */

export class OwnerServiceError extends Error {
  constructor(
    public readonly code: "CODE_TAKEN" | "NOT_FOUND",
    message: string,
  ) {
    super(message);
  }
}

export const OWNER_PAGE_SIZE = 25;

export type OwnerListParams = {
  type: OwnerType;
  q?: string;
  status?: OwnerStatus | "ALL";
  page?: number;
};

export async function listOwners(params: OwnerListParams) {
  const page = Math.max(1, params.page ?? 1);
  const where: Prisma.OwnerWhereInput = {
    type: params.type,
    ...(params.status && params.status !== "ALL" ? { status: params.status } : {}),
    ...(params.q
      ? {
          OR: [
            { businessName: { contains: params.q, mode: "insensitive" } },
            { code: { contains: params.q, mode: "insensitive" } },
            { contactName: { contains: params.q, mode: "insensitive" } },
            { email: { contains: params.q, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const [total, items] = await prisma.$transaction([
    prisma.owner.count({ where }),
    prisma.owner.findMany({
      where,
      orderBy: [{ status: "asc" }, { businessName: "asc" }],
      skip: (page - 1) * OWNER_PAGE_SIZE,
      take: OWNER_PAGE_SIZE,
      include: { _count: { select: { users: { where: { status: { not: "DELETED" } } } } } },
    }),
  ]);

  return { items, total, page, pageSize: OWNER_PAGE_SIZE, pageCount: Math.max(1, Math.ceil(total / OWNER_PAGE_SIZE)) };
}

export async function getOwner(id: string, type?: OwnerType) {
  const owner = await prisma.owner.findFirst({ where: { id, ...(type ? { type } : {}) } });
  return owner;
}

export async function getOwnerWithUsers(id: string, type: OwnerType) {
  return prisma.owner.findFirst({
    where: { id, type },
    include: {
      users: {
        where: { status: { not: "DELETED" } },
        orderBy: [{ status: "asc" }, { name: "asc" }],
        select: { id: true, name: true, email: true, phone: true, status: true, role: true, lastLoginAt: true, createdAt: true },
      },
    },
  });
}

/** Lightweight list for select inputs (active owners of a type). */
export async function listOwnerOptions(type: OwnerType) {
  return prisma.owner.findMany({
    where: { type, status: "ACTIVE" },
    orderBy: { businessName: "asc" },
    select: { id: true, code: true, businessName: true },
  });
}

export async function createOwner(type: OwnerType, values: OwnerFormValues, actorId: string) {
  const existing = await prisma.owner.findUnique({ where: { code: values.code }, select: { id: true } });
  if (existing) throw new OwnerServiceError("CODE_TAKEN", `Code "${values.code}" is already used by another vendor or 3PL client.`);

  return prisma.$transaction(async (tx) => {
    const owner = await tx.owner.create({ data: { type, ...values } });
    await recordAudit(
      { userId: actorId, action: "owner.created", entityType: "Owner", entityId: owner.id, newValues: { type, ...values } },
      tx,
    );
    return owner;
  });
}

export async function updateOwner(id: string, type: OwnerType, values: OwnerFormValues, actorId: string) {
  const current = await prisma.owner.findFirst({ where: { id, type } });
  if (!current) throw new OwnerServiceError("NOT_FOUND", "Record not found.");

  if (values.code !== current.code) {
    const clash = await prisma.owner.findUnique({ where: { code: values.code }, select: { id: true } });
    if (clash && clash.id !== id) {
      throw new OwnerServiceError("CODE_TAKEN", `Code "${values.code}" is already used by another vendor or 3PL client.`);
    }
  }

  const changed = diffValues(current, values);

  return prisma.$transaction(async (tx) => {
    const owner = await tx.owner.update({ where: { id }, data: values });
    if (Object.keys(changed.newValues).length > 0) {
      await recordAudit(
        { userId: actorId, action: "owner.updated", entityType: "Owner", entityId: id, oldValues: changed.oldValues, newValues: changed.newValues },
        tx,
      );
    }
    return owner;
  });
}

export async function setOwnerStatus(id: string, type: OwnerType, status: OwnerStatus, actorId: string) {
  const current = await prisma.owner.findFirst({ where: { id, type }, select: { id: true, status: true } });
  if (!current) throw new OwnerServiceError("NOT_FOUND", "Record not found.");
  if (current.status === status) return current;

  return prisma.$transaction(async (tx) => {
    const owner = await tx.owner.update({ where: { id }, data: { status } });
    await recordAudit(
      {
        userId: actorId,
        action: status === "ACTIVE" ? "owner.reactivated" : "owner.deactivated",
        entityType: "Owner",
        entityId: id,
        oldValues: { status: current.status },
        newValues: { status },
      },
      tx,
    );
    return owner;
  });
}

function diffValues<T extends Record<string, unknown>>(current: T, next: Partial<T>) {
  const oldValues: Record<string, unknown> = {};
  const newValues: Record<string, unknown> = {};
  for (const key of Object.keys(next) as (keyof T)[]) {
    const before = current[key] ?? null;
    const after = next[key] ?? null;
    if (before !== after) {
      oldValues[key as string] = before;
      newValues[key as string] = after;
    }
  }
  return { oldValues, newValues };
}
