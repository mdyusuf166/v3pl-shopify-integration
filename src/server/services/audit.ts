// No `server-only` import: shared with CLI scripts. Never import from client components.
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * Audit log foundation (spec §51). Append-only: this module exposes no update
 * or delete. Later phases add actions to AuditAction as they are implemented.
 */
/** Dotted "entity.verb" keys, e.g. "user.created", "inventory.received", "transfer.completed". */
export type AuditAction = `${string}.${string}`;

export type AuditInput = {
  /** Acting user id; null for system/bootstrap actions. */
  userId: string | null;
  action: AuditAction;
  entityType: string;
  entityId?: string | null;
  oldValues?: Record<string, unknown> | null;
  newValues?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
};

type DbClient = PrismaClient | Prisma.TransactionClient;

/**
 * Writes one audit row. Pass the transaction client (`tx`) when the audited
 * change happens inside a transaction so the audit row commits atomically with it.
 */
export async function recordAudit(input: AuditInput, db: DbClient = prisma): Promise<void> {
  await db.auditLog.create({
    data: {
      userId: input.userId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      oldValues: (input.oldValues ?? undefined) as Prisma.InputJsonValue | undefined,
      newValues: (input.newValues ?? undefined) as Prisma.InputJsonValue | undefined,
      metadata: (input.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });
}
