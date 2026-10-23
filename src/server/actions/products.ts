"use server";

import { revalidatePath } from "next/cache";
import type { ProductStatus } from "@/generated/prisma/client";
import { destroyImage, signedUploadParams } from "@/lib/cloudinary";
import { isCloudinaryConfigured } from "@/lib/env";
import { initialStockSchema, productFormSchema, productImageSchema, type InitialStockInput, type ProductFormInput, type ProductImageInput } from "@/lib/validation/products";
import { variantSearchScope } from "@/lib/variant-search-scope";
import { getCurrentUser } from "@/server/auth/current-user";
import { requireRole } from "@/server/auth/guards";
import {
  ProductServiceError,
  addProductImage,
  createProduct,
  createProductWithInitialStock,
  deleteProduct,
  describeSkuStoreConflicts,
  removeProductImage,
  skuStoreConflicts,
  searchVariants,
  setProductStatus,
  updateProduct,
} from "@/server/services/products";
import { InventoryError } from "@/server/services/inventory";
import { ReceivingServiceError } from "@/server/services/receiving";
import { fail, ok, zodFieldErrors, type ActionResult } from "@/server/actions/action-result";

function handleError(err: unknown): ActionResult<never> {
  if (err instanceof ProductServiceError) return err.field ? fail(err.message, { [err.field]: err.message }) : fail(err.message);
  console.error("[products action]", err);
  return fail("Something went wrong. Please try again.");
}

const BASE = "/admin/products";

/**
 * Create a product; `initialStock` (warehouse + location) is required only when at least one variant
 * carries an `initialQuantity` > 0 (D-058). Stock is received through the receiving service.
 */
export async function createProductAction(input: ProductFormInput, initialStock?: InitialStockInput | null): Promise<ActionResult<{ id: string; stock: { units: number; lines: number } | null }>> {
  const actor = await requireRole("ADMIN");
  const parsed = productFormSchema.safeParse(input);
  if (!parsed.success) return fail("Please fix the highlighted fields.", zodFieldErrors(parsed.error.issues));
  const wantsStock = parsed.data.variants.some((v) => (v.initialQuantity ?? 0) > 0);
  let stock: ReturnType<typeof initialStockSchema.parse> | null = null;
  if (wantsStock) {
    const parsedStock = initialStockSchema.safeParse(initialStock ?? {});
    if (!parsedStock.success) return fail("Choose where the initial stock is received.", Object.fromEntries(Object.entries(zodFieldErrors(parsedStock.error.issues)).map(([k, v]) => [`initialStock.${k}`, v])));
    stock = parsedStock.data;
  }
  try {
    const { product, stock: received } = wantsStock ? await createProductWithInitialStock(parsed.data, stock, actor.id) : { product: await createProduct(parsed.data, actor.id), stock: null };
    revalidatePath(BASE);
    revalidatePath("/admin/inventory");
    revalidatePath("/admin/receiving");
    return ok({ id: product.id, stock: received ? { units: received.units, lines: received.lines } : null });
  } catch (err) {
    if (err instanceof ReceivingServiceError || err instanceof InventoryError) return fail(err.message, err instanceof ReceivingServiceError && err.field ? { [`initialStock.${err.field}`]: err.message } : undefined);
    return handleError(err);
  }
}

export async function updateProductAction(id: string, input: ProductFormInput): Promise<ActionResult<{ id: string }>> {
  const actor = await requireRole("ADMIN");
  const parsed = productFormSchema.safeParse(input);
  if (!parsed.success) return fail("Please fix the highlighted fields.", zodFieldErrors(parsed.error.issues));
  try {
    await updateProduct(id, parsed.data, actor.id);
    revalidatePath(BASE);
    revalidatePath(`${BASE}/${id}`);
    return ok({ id });
  } catch (err) {
    return handleError(err);
  }
}

export async function setProductStatusAction(id: string, status: ProductStatus): Promise<ActionResult<{ status: ProductStatus }>> {
  const actor = await requireRole("ADMIN");
  try {
    const p = await setProductStatus(id, status, actor.id);
    revalidatePath(BASE);
    revalidatePath(`${BASE}/${id}`);
    return ok({ status: p.status });
  } catch (err) {
    return handleError(err);
  }
}

/** Warnings when a SKU already exists in a connected Shopify store (D-057, QA SKU-03). Read-only; never changes mappings. */
export async function checkSkuStoreConflictsAction(skus: string[], productId?: string): Promise<ActionResult<Record<string, string[]>>> {
  await requireRole("ADMIN");
  try {
    return ok(describeSkuStoreConflicts(await skuStoreConflicts(skus.slice(0, 200), productId)));
  } catch (err) {
    return handleError(err);
  }
}

/** Hard delete (D-054): only products with no history; the service refuses otherwise. */
export async function deleteProductAction(id: string): Promise<ActionResult<{ name: string }>> {
  const actor = await requireRole("ADMIN");
  try {
    const { name, imagePublicIds } = await deleteProduct(id, actor.id);
    if (isCloudinaryConfigured()) for (const publicId of imagePublicIds) void destroyImage(publicId);
    revalidatePath(BASE);
    return ok({ name });
  } catch (err) {
    return handleError(err);
  }
}

/**
 * Variant picker used by order, receiving, adjustment and transfer forms. Staff may search any owner
 * (optionally filtered); portal users are always scoped to their own owner, whatever the client sent.
 * Never redirects: a redirect from a server action navigates the browser away from the form the user is
 * filling in (QA UI-06), so authorization failures come back as an ActionResult instead.
 */
export async function searchVariantsAction(q: string, ownerId?: string): Promise<ActionResult<Awaited<ReturnType<typeof searchVariants>>>> {
  const scope = variantSearchScope(await getCurrentUser(), ownerId);
  if (!scope.ok) return fail(scope.reason === "unauthenticated" ? "Your session has expired — sign in again." : "You are not allowed to search the catalogue.");
  try {
    return ok(await searchVariants(q, { ownerId: scope.ownerId, limit: 20 }));
  } catch (err) {
    return handleError(err);
  }
}

// --- Images (Cloudinary) ----------------------------------------------------

export async function getUploadSignatureAction(): Promise<ActionResult<ReturnType<typeof signedUploadParams>>> {
  await requireRole("ADMIN");
  if (!isCloudinaryConfigured()) return fail("Image uploads are not configured (Cloudinary variables missing).");
  try {
    return ok(signedUploadParams());
  } catch (err) {
    return handleError(err);
  }
}

export async function addProductImageAction(input: ProductImageInput): Promise<ActionResult<{ id: string }>> {
  const actor = await requireRole("ADMIN");
  const parsed = productImageSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid image data.", zodFieldErrors(parsed.error.issues));
  try {
    const image = await addProductImage(parsed.data, actor.id);
    revalidatePath(`${BASE}/${parsed.data.productId}`);
    return ok({ id: image.id });
  } catch (err) {
    return handleError(err);
  }
}

export async function removeProductImageAction(imageId: string): Promise<ActionResult<undefined>> {
  const actor = await requireRole("ADMIN");
  try {
    const image = await removeProductImage(imageId, actor.id);
    if (isCloudinaryConfigured()) void destroyImage(image.cloudinaryPublicId);
    revalidatePath(`${BASE}/${image.productId}`);
    return ok(undefined);
  } catch (err) {
    return handleError(err);
  }
}
