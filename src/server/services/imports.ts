import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { importOptionsSchema, type ImportOptions } from "@/lib/validation/orders";
import { productImportOptionsSchema, type ProductImportOptions } from "@/lib/validation/products";
import { recordAudit } from "@/server/services/audit";
import { executeOrderImport, failedRowsCsv, previewOrderCsv, type ImportOutcome, type ImportPreview } from "@/server/services/order-csv";
import { executeProductImport, failedProductRowsCsv, previewProductCsv, type ProductImportOutcome, type ProductImportPreview } from "@/server/services/product-csv";

/**
 * Import jobs (spec §23/§46/§53): Upload → Preview (stored) → Confirm → Results.
 * The validated preview is persisted so confirm never re-reads the file, and the job
 * row is the import history with a downloadable failed-row report. Job types: ORDERS
 * (order-csv.ts) and PRODUCTS (product-csv.ts, D-053).
 */

export class ImportServiceError extends Error {
  constructor(
    public readonly code: "NOT_FOUND" | "BAD_STATUS" | "EMPTY" | "TOO_LARGE",
    message: string,
  ) {
    super(message);
  }
}

const MAX_ROWS = 5000;

export async function createOrderImportPreview(fileName: string, text: string, options: ImportOptions, actorId: string) {
  if (!text.trim()) throw new ImportServiceError("EMPTY", "The file is empty.");
  const preview = await previewOrderCsv(text);
  if (preview.rows.length > MAX_ROWS) throw new ImportServiceError("TOO_LARGE", `Files are limited to ${MAX_ROWS} rows; split the file.`);
  const job = await prisma.importJob.create({
    data: {
      type: "ORDERS",
      status: "PREVIEW",
      fileName,
      detectedFormat: preview.format,
      totalRows: preview.summary.totalRows,
      totalOrders: preview.summary.totalOrders,
      failedCount: preview.summary.failedOrders,
      duplicateCount: preview.summary.duplicateOrders,
      payload: preview as unknown as Prisma.InputJsonValue,
      options: options as unknown as Prisma.InputJsonValue,
      createdById: actorId,
    },
    select: { id: true },
  });
  return { jobId: job.id, preview };
}

export async function createProductImportPreview(fileName: string, text: string, options: ProductImportOptions, actorId: string) {
  if (!text.trim()) throw new ImportServiceError("EMPTY", "The file is empty.");
  const preview = await previewProductCsv(text, options);
  if (preview.rows.length > MAX_ROWS) throw new ImportServiceError("TOO_LARGE", `Files are limited to ${MAX_ROWS} rows; split the file.`);
  const job = await prisma.importJob.create({
    data: {
      type: "PRODUCTS",
      status: "PREVIEW",
      fileName,
      detectedFormat: preview.format,
      totalRows: preview.summary.totalRows,
      totalOrders: preview.summary.totalProducts,
      failedCount: preview.summary.failedProducts,
      duplicateCount: preview.summary.existingSkus,
      payload: preview as unknown as Prisma.InputJsonValue,
      options: options as unknown as Prisma.InputJsonValue,
      createdById: actorId,
    },
    select: { id: true },
  });
  return { jobId: job.id, preview };
}

export async function getImportJob(id: string) {
  return prisma.importJob.findUnique({ where: { id }, include: { createdBy: { select: { name: true } } } });
}

export function jobPreview(job: { type: string; payload: unknown }): ImportPreview | null {
  return job.type === "ORDERS" ? ((job.payload as ImportPreview | null) ?? null) : null;
}

export function jobProductPreview(job: { type: string; payload: unknown }): ProductImportPreview | null {
  return job.type === "PRODUCTS" ? ((job.payload as ProductImportPreview | null) ?? null) : null;
}

/** ORDERS jobs return an ImportOutcome, PRODUCTS jobs a ProductImportOutcome (`"updated" in outcome`). */
export async function confirmImportJob(id: string, actorId: string): Promise<ImportOutcome | ProductImportOutcome> {
  const job = await prisma.importJob.findUnique({ where: { id } });
  if (!job) throw new ImportServiceError("NOT_FOUND", "Import not found.");
  if (job.status !== "PREVIEW") throw new ImportServiceError("BAD_STATUS", `This import was already ${job.status.toLowerCase()}.`);
  const { toCsv } = await import("@/lib/csv");

  if (job.type === "PRODUCTS") {
    const stored = jobProductPreview(job);
    if (!stored) throw new ImportServiceError("BAD_STATUS", "Preview data is missing; upload the file again.");
    const options = productImportOptionsSchema.parse(job.options ?? {});
    // Re-validate against the current catalogue (SKUs may have been created since the preview).
    const fresh = await previewProductCsv(toCsv(stored.headers, stored.rows.map((r) => r.raw)), options);
    const outcome = await executeProductImport(fresh, options, actorId, `CSV import ${job.fileName}`);
    await prisma.importJob.update({
      where: { id },
      data: {
        status: "COMPLETED",
        successCount: outcome.created.length + outcome.updated.length,
        failedCount: outcome.failed.length,
        duplicateCount: outcome.updated.length,
        result: outcome as unknown as Prisma.InputJsonValue,
        payload: fresh as unknown as Prisma.InputJsonValue,
        completedAt: new Date(),
      },
    });
    await recordAudit({ userId: actorId, action: "import.completed", entityType: "ImportJob", entityId: id, newValues: { type: "PRODUCTS", created: outcome.created.length, updated: outcome.updated.length, failed: outcome.failed.length } });
    return outcome;
  }

  const preview = jobPreview(job);
  const options = importOptionsSchema.parse(job.options ?? {});
  if (!preview) throw new ImportServiceError("BAD_STATUS", "Preview data is missing; upload the file again.");
  // Re-run duplicate detection at confirm time (another import may have happened since preview).
  const fresh = await previewOrderCsv(toCsv(preview.headers, preview.rows.map((r) => r.raw)));
  const outcome = await executeOrderImport(fresh, options, actorId);
  await prisma.importJob.update({
    where: { id },
    data: {
      status: "COMPLETED",
      successCount: outcome.created.length,
      failedCount: outcome.failed.length,
      duplicateCount: outcome.duplicates.length,
      result: outcome as unknown as Prisma.InputJsonValue,
      payload: fresh as unknown as Prisma.InputJsonValue,
      completedAt: new Date(),
    },
  });
  await recordAudit({ userId: actorId, action: "import.completed", entityType: "ImportJob", entityId: id, newValues: { created: outcome.created.length, failed: outcome.failed.length, duplicates: outcome.duplicates.length } });
  return outcome;
}

export async function discardImportJob(id: string, actorId: string) {
  const job = await prisma.importJob.findUnique({ where: { id }, select: { status: true } });
  if (!job) throw new ImportServiceError("NOT_FOUND", "Import not found.");
  if (job.status !== "PREVIEW") return;
  await prisma.importJob.update({ where: { id }, data: { status: "DISCARDED", payload: Prisma.DbNull } });
  await recordAudit({ userId: actorId, action: "import.discarded", entityType: "ImportJob", entityId: id });
}

export async function failedRowsCsvForJob(id: string): Promise<{ fileName: string; csv: string } | null> {
  const job = await prisma.importJob.findUnique({ where: { id } });
  if (!job) return null;
  const fileName = job.fileName.replace(/\.csv$/i, "") + "-failed-rows.csv";
  if (job.type === "PRODUCTS") {
    const preview = jobProductPreview(job);
    if (!preview) return null;
    return { fileName, csv: failedProductRowsCsv(preview, (job.result as ProductImportOutcome | null) ?? undefined) };
  }
  const preview = jobPreview(job);
  if (!preview) return null;
  const outcome = (job.result as ImportOutcome | null) ?? undefined;
  return { fileName, csv: failedRowsCsv(preview, outcome) };
}

export async function listImportJobs(page = 1, pageSize = 25) {
  const [total, items] = await prisma.$transaction([
    prisma.importJob.count(),
    prisma.importJob.findMany({ orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize, select: { id: true, type: true, status: true, fileName: true, detectedFormat: true, totalRows: true, totalOrders: true, successCount: true, failedCount: true, duplicateCount: true, createdAt: true, completedAt: true, createdBy: { select: { name: true } } } }),
  ]);
  return { items, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}
