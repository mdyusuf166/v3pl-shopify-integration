"use server";

import { revalidatePath } from "next/cache";
import { importOptionsSchema } from "@/lib/validation/orders";
import { productImportOptionsSchema } from "@/lib/validation/products";
import { requireRole } from "@/server/auth/guards";
import { ImportServiceError, confirmImportJob, createOrderImportPreview, createProductImportPreview, discardImportJob } from "@/server/services/imports";
import { fail, ok, zodFieldErrors, type ActionResult } from "@/server/actions/action-result";

const MAX_BYTES = 5 * 1024 * 1024;

function handleError(err: unknown): ActionResult<never> {
  if (err instanceof ImportServiceError) return fail(err.message);
  console.error("[imports action]", err);
  return fail("Something went wrong. Please try again.");
}

function csvFile(formData: FormData): File | ActionResult<never> {
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return fail("Choose a CSV file.", { file: "Required" });
  if (file.size > MAX_BYTES) return fail("File is larger than 5 MB.", { file: "Too large" });
  if (!/\.csv$/i.test(file.name) && file.type !== "text/csv") return fail("Only .csv files are supported.", { file: "Not a CSV" });
  return file;
}

/** Upload + validate orders. FormData: file, defaultWarehouseId, reserve ("true"/"false"). */
export async function previewOrderImportAction(formData: FormData): Promise<ActionResult<{ jobId: string }>> {
  const actor = await requireRole("ADMIN", "SALES");
  const file = csvFile(formData);
  if (!(file instanceof File)) return file;
  const options = importOptionsSchema.safeParse({ defaultWarehouseId: formData.get("defaultWarehouseId"), reserve: formData.get("reserve") !== "false" });
  if (!options.success) return fail("Choose the default warehouse.", zodFieldErrors(options.error.issues));
  try {
    const text = await file.text();
    const { jobId } = await createOrderImportPreview(file.name, text, options.data, actor.id);
    revalidatePath("/admin/imports");
    return ok({ jobId });
  } catch (err) {
    return handleError(err);
  }
}

/** Upload + validate products (Shopify product export or V3PL product export). FormData: file, ownerId, stockWarehouseId. */
export async function previewProductImportAction(formData: FormData): Promise<ActionResult<{ jobId: string }>> {
  const actor = await requireRole("ADMIN");
  const file = csvFile(formData);
  if (!(file instanceof File)) return file;
  const options = productImportOptionsSchema.safeParse({ ownerId: (formData.get("ownerId") as string) || null, stockWarehouseId: (formData.get("stockWarehouseId") as string) || null });
  if (!options.success) return fail("Check the import options.", zodFieldErrors(options.error.issues));
  try {
    const text = await file.text();
    const { jobId } = await createProductImportPreview(file.name, text, options.data, actor.id);
    revalidatePath("/admin/imports");
    return ok({ jobId });
  } catch (err) {
    return handleError(err);
  }
}

export async function confirmImportAction(jobId: string): Promise<ActionResult<{ created: number; updated: number; failed: number; duplicates: number }>> {
  const actor = await requireRole("ADMIN", "SALES");
  try {
    const outcome = await confirmImportJob(jobId, actor.id);
    revalidatePath("/admin/imports");
    revalidatePath(`/admin/imports/${jobId}`);
    revalidatePath("/admin/orders");
    revalidatePath("/admin/products");
    revalidatePath("/admin/inventory");
    if ("updated" in outcome) return ok({ created: outcome.created.length, updated: outcome.updated.length, failed: outcome.failed.length, duplicates: 0 });
    return ok({ created: outcome.created.length, updated: 0, failed: outcome.failed.length, duplicates: outcome.duplicates.length });
  } catch (err) {
    return handleError(err);
  }
}

export async function discardImportAction(jobId: string): Promise<ActionResult<undefined>> {
  const actor = await requireRole("ADMIN", "SALES");
  try {
    await discardImportJob(jobId, actor.id);
    revalidatePath("/admin/imports");
    return ok(undefined);
  } catch (err) {
    return handleError(err);
  }
}
