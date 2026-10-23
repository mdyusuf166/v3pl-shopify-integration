import type { Prisma, PrismaClient, ShopifySyncDirection, ShopifySyncEntity, ShopifySyncStatus } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * ShopifySyncLog — Admin-readable synchronisation history (spec §44, shopify-integration.md §5.1).
 * Append-only. `message` must be understandable without technical context; `errorDetail`
 * carries the technical text for support.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export type SyncLogInput = {
  storeId: string;
  direction: ShopifySyncDirection;
  entityType: ShopifySyncEntity;
  operation: string;
  status: ShopifySyncStatus;
  message: string;
  externalId?: string | null;
  internalId?: string | null;
  previousValue?: string | null;
  newValue?: string | null;
  errorDetail?: string | null;
  webhookEventId?: string | null;
  orderId?: string | null;
  retryCount?: number;
};

export async function logSync(input: SyncLogInput, db: Db = prisma): Promise<void> {
  await db.shopifySyncLog.create({
    data: {
      storeId: input.storeId,
      direction: input.direction,
      entityType: input.entityType,
      operation: input.operation,
      status: input.status,
      message: input.message.slice(0, 1000),
      externalId: input.externalId ?? null,
      internalId: input.internalId ?? null,
      previousValue: input.previousValue ?? null,
      newValue: input.newValue ?? null,
      errorDetail: input.errorDetail ? input.errorDetail.slice(0, 4000) : null,
      webhookEventId: input.webhookEventId ?? null,
      orderId: input.orderId ?? null,
      retryCount: input.retryCount ?? 0,
    },
  });
}

export const SYNC_LOG_PAGE_SIZE = 50;

export type SyncLogListParams = {
  storeId?: string;
  status?: ShopifySyncStatus;
  entityType?: ShopifySyncEntity;
  direction?: ShopifySyncDirection;
  q?: string;
  page?: number;
  pageSize?: number;
};

export async function listSyncLogs(params: SyncLogListParams) {
  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.min(200, params.pageSize ?? SYNC_LOG_PAGE_SIZE);
  const where: Prisma.ShopifySyncLogWhereInput = {
    storeId: params.storeId,
    status: params.status,
    entityType: params.entityType,
    direction: params.direction,
    ...(params.q
      ? {
          OR: [
            { message: { contains: params.q, mode: "insensitive" } },
            { externalId: { contains: params.q, mode: "insensitive" } },
            { internalId: { contains: params.q, mode: "insensitive" } },
            { operation: { contains: params.q, mode: "insensitive" } },
          ],
        }
      : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.shopifySyncLog.count({ where }),
    prisma.shopifySyncLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { store: { select: { id: true, name: true, shopDomain: true } }, order: { select: { id: true, orderNumber: true } } },
    }),
  ]);
  return { rows, total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) };
}

/** Open problems for the dashboard / store cards: FAILED + NEEDS_ATTENTION rows in the last 7 days, per store. */
export async function attentionCountsByStore(days = 7): Promise<Map<string, number>> {
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await prisma.shopifySyncLog.groupBy({
    by: ["storeId"],
    where: { status: { in: ["FAILED", "NEEDS_ATTENTION"] }, createdAt: { gte: since } },
    _count: { _all: true },
  });
  return new Map(rows.map((r) => [r.storeId, r._count._all]));
}

/** Compact, human-readable error text for logs and Admin messages (never secrets). */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return `${typeof code === "string" ? `[${code}] ` : ""}${err.message}`.slice(0, 1000);
  }
  return String(err).slice(0, 1000);
}
