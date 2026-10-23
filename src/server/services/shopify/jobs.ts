import type { Prisma, PrismaClient, ShopifyJobStatus, ShopifyJobType, ShopifyOutboundJob } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { describeError, logSync } from "./sync-log";
import { computeBackoff } from "./webhooks";

/**
 * Outbound work queue (platform → Shopify), shopify-integration.md §5.1 / §13.
 * Jobs are enqueued INSIDE core transactions by the hooks (register.ts) and executed
 * afterwards (after the HTTP response, by the piggyback drain, or by the daily cron).
 * `dedupeKey` makes enqueueing idempotent; runners are idempotent by contract.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export type JobInput = { storeId: string; type: ShopifyJobType; targetType: string; targetId: string; dedupeKey: string };

export const MAX_JOB_ATTEMPTS = 5;
const STALE_LOCK_MS = 15 * 60_000;

/**
 * Insert or revive a job. A FULFILLMENT_CREATE / ORDER_CREATE job that is DONE stays done (one Shopify
 * fulfillment per shipment, one Shopify order per V3PL order); other job types are re-armed so the latest state is pushed.
 * A RUNNING job is left alone — runners read the current state when they execute.
 */
export async function enqueueJob(db: Db, input: JobInput): Promise<void> {
  const existing = await db.shopifyOutboundJob.findUnique({ where: { dedupeKey: input.dedupeKey }, select: { id: true, status: true, type: true } });
  if (!existing) {
    await db.shopifyOutboundJob.create({ data: { ...input, status: "PENDING" } });
    return;
  }
  if (existing.status === "RUNNING" || existing.status === "PENDING") return;
  if ((existing.type === "FULFILLMENT_CREATE" || existing.type === "ORDER_CREATE") && existing.status === "DONE") return;
  await db.shopifyOutboundJob.update({ where: { id: existing.id }, data: { status: "PENDING", attempts: 0, nextRetryAt: null, lastError: null, lockedAt: null } });
}

export type JobRunResult = { result?: Prisma.InputJsonValue; message?: string } | void;

/** Thrown by a runner for a business condition that retrying cannot fix → job goes straight to NEEDS_ATTENTION. */
export class NonRetryableJobError extends Error {
  constructor(
    message: string,
    public readonly detail?: string,
  ) {
    super(message);
  }
}
export type JobRunner = (job: ShopifyOutboundJob) => Promise<JobRunResult>;

const RUNNERS: Partial<Record<ShopifyJobType, JobRunner>> = {};

export function registerJobRunner(type: ShopifyJobType, runner: JobRunner): void {
  RUNNERS[type] = runner;
}

export function runnableJobTypes(): ShopifyJobType[] {
  return Object.keys(RUNNERS) as ShopifyJobType[];
}

/**
 * Make sure THIS module instance has its runners. The registry above is module state; Next/Turbopack
 * emits separate instances of this module for instrumentation, route handlers, server actions and the
 * cron route, so registration done at boot by instrumentation is invisible to the instance that
 * actually drains. Dynamic import at call time is cycle-safe (runners → *-out → jobs).
 */
let ensured: Promise<void> | null = null;
export function ensureRunnersRegistered(): Promise<void> {
  if (!ensured) {
    ensured = import("./runners")
      .then((m) => m.registerShopifyRunners())
      .catch((err) => {
        ensured = null;
        throw err;
      });
  }
  return ensured;
}

function entityFor(type: ShopifyJobType) {
  return type === "INVENTORY_PUBLISH" ? ("INVENTORY" as const) : type === "ORDER_CREATE" ? ("ORDER" as const) : ("FULFILLMENT" as const);
}

/** Claim + execute one job. Returns the resulting status, or null when it was not claimable. */
export async function runJob(id: string): Promise<ShopifyJobStatus | null> {
  await ensureRunnersRegistered();
  const claimed = await prisma.shopifyOutboundJob.updateMany({
    where: { id, status: { in: ["PENDING", "FAILED"] } },
    data: { status: "RUNNING", lockedAt: new Date(), attempts: { increment: 1 } },
  });
  if (claimed.count === 0) return null;
  const job = await prisma.shopifyOutboundJob.findUniqueOrThrow({ where: { id } });
  const runner = RUNNERS[job.type];
  if (!runner) {
    // Not implemented in this deployment yet: put it back untouched.
    await prisma.shopifyOutboundJob.update({ where: { id }, data: { status: "PENDING", lockedAt: null, attempts: { decrement: 1 } } });
    return null;
  }
  try {
    const out = await runner(job);
    await prisma.shopifyOutboundJob.update({ where: { id }, data: { status: "DONE", lockedAt: null, lastError: null, nextRetryAt: null, result: out?.result ?? undefined } });
    return "DONE";
  } catch (err) {
    const detail = describeError(err);
    const nonRetryable = err instanceof NonRetryableJobError;
    const exhausted = nonRetryable || job.attempts >= MAX_JOB_ATTEMPTS;
    const status: ShopifyJobStatus = exhausted ? "NEEDS_ATTENTION" : "FAILED";
    await prisma.shopifyOutboundJob.update({ where: { id }, data: { status, lockedAt: null, lastError: detail, nextRetryAt: exhausted ? null : computeBackoff(job.attempts) } });
    await logSync({
      storeId: job.storeId,
      direction: "OUTBOUND",
      entityType: entityFor(job.type),
      operation: job.type.toLowerCase(),
      status: exhausted ? "NEEDS_ATTENTION" : "FAILED",
      message: nonRetryable ? err.message : exhausted ? `${job.type.replace("_", " ").toLowerCase()} failed ${job.attempts} times and needs attention` : `${job.type.replace("_", " ").toLowerCase()} failed (attempt ${job.attempts}) — will retry automatically`,
      errorDetail: nonRetryable ? (err.detail ?? null) : detail,
      internalId: job.targetId,
      retryCount: job.attempts,
    });
    return status;
  }
}

/** Run due jobs for connected stores (only types with a registered runner). */
export async function runDueJobs(opts: { storeId?: string; limit?: number; deadline?: number } = {}): Promise<number> {
  await ensureRunnersRegistered();
  const types = runnableJobTypes();
  if (types.length === 0) return 0;
  const now = new Date();
  await prisma.shopifyOutboundJob.updateMany({
    where: { status: "RUNNING", lockedAt: { lt: new Date(now.getTime() - STALE_LOCK_MS) }, ...(opts.storeId ? { storeId: opts.storeId } : {}) },
    data: { status: "FAILED", lockedAt: null, lastError: "Job was interrupted", nextRetryAt: now },
  });
  const due = await prisma.shopifyOutboundJob.findMany({
    where: {
      type: { in: types },
      storeId: opts.storeId,
      store: { status: "CONNECTED" },
      OR: [{ status: "PENDING", nextRetryAt: null }, { status: "PENDING", nextRetryAt: { lte: now } }, { status: "FAILED", nextRetryAt: { lte: now } }],
    },
    orderBy: { createdAt: "asc" },
    take: opts.limit ?? 50,
    select: { id: true },
  });
  let ran = 0;
  for (const j of due) {
    if (opts.deadline && Date.now() > opts.deadline) break;
    if ((await runJob(j.id)) !== null) ran++;
  }
  return ran;
}

/** Admin “Retry now” for a job that is FAILED or NEEDS_ATTENTION. */
export async function retryJobNow(id: string): Promise<ShopifyJobStatus | null> {
  await prisma.shopifyOutboundJob.updateMany({ where: { id, status: { in: ["FAILED", "NEEDS_ATTENTION"] } }, data: { status: "FAILED", nextRetryAt: null } });
  return runJob(id);
}

export async function listJobs(params: { storeId?: string; status?: ShopifyJobStatus; page?: number; pageSize?: number }) {
  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.min(200, params.pageSize ?? 50);
  const where: Prisma.ShopifyOutboundJobWhereInput = { storeId: params.storeId, status: params.status };
  const [total, rows] = await Promise.all([
    prisma.shopifyOutboundJob.count({ where }),
    prisma.shopifyOutboundJob.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize }),
  ]);
  return { rows, total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) };
}
