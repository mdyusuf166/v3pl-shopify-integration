"use server";

import { revalidatePath } from "next/cache";
import { addStoreSchema, importConfirmSchema, importPreviewSchema, importSinceSchema, mapVariantSchema, storeSettingsSchema, type AddStoreInput, type ImportConfirmInput, type ImportPreviewInput, type ImportSinceInput, type MapVariantInput, type StoreSettingsInput } from "@/lib/validation/shopify";
import { fail, ok, zodFieldErrors, type ActionResult } from "@/server/actions/action-result";
import { requireRole } from "@/server/auth/guards";
import "@/server/services/shopify/register";
import { searchVariants } from "@/server/services/products";
import { CatalogError, syncCatalog, type CatalogSyncResult } from "@/server/services/shopify/catalog";
import { confirmImport, previewImport, type ImportPreview, type ImportResult } from "@/server/services/shopify/catalog-import";
import { ShopifyApiError } from "@/server/services/shopify/client";
import { CustomerSyncError, syncCustomers, type CustomerSyncResult } from "@/server/services/shopify/customers-sync";
import { MappingError, listMappings, mapManually, setIgnored, unmap } from "@/server/services/shopify/mapping";
import { importOrdersSince, reconcileOrders, syncShopifyOrder, type OrderSyncOutcome, type ReconcileSummary } from "@/server/services/shopify/orders-in";
import { PublishError, enqueuePublishAll, publishVariant, type PublishOutcome } from "@/server/services/shopify/inventory-publish";
import { retryJobNow } from "@/server/services/shopify/jobs";
import { drainPending } from "@/server/services/shopify/maintenance";
import { ShopifyOAuthError, beginInstall } from "@/server/services/shopify/oauth";
import { ShopifyStoreError, disconnectStore, getStore, removePendingStore, testConnection, updateStoreSettings } from "@/server/services/shopify/stores";
import { retryWebhookEventNow } from "@/server/services/shopify/webhooks";

const BASE = "/admin/settings/shopify";

function handleError(err: unknown): ActionResult<never> {
  if (err instanceof ShopifyOAuthError || err instanceof ShopifyStoreError || err instanceof MappingError || err instanceof CatalogError || err instanceof PublishError || err instanceof CustomerSyncError) return fail(err.message);
  if (err instanceof ShopifyApiError) {
    if (err.code === "UNAUTHORIZED") return fail("Shopify rejected the store's access. Use Reconnect.");
    if (err.code === "NETWORK") return fail("Could not reach Shopify. Check the connection and try again.");
    return fail(err.message);
  }
  if (err instanceof Error && err.message.startsWith("Shopify environment is not configured")) {
    return fail("Shopify is not configured on this server yet. See docs/shopify-setup.md Part E.");
  }
  console.error("[shopify action]", err);
  return fail("Something went wrong. Please try again.");
}

/** Starts the OAuth grant; the browser is then sent to Shopify's authorization page. */
export async function beginInstallAction(input: AddStoreInput): Promise<ActionResult<{ url: string; storeId: string }>> {
  const actor = await requireRole("ADMIN");
  const parsed = addStoreSchema.safeParse(input);
  if (!parsed.success) return fail("Please fix the highlighted fields.", zodFieldErrors(parsed.error.issues));
  try {
    const r = await beginInstall({ shopDomain: parsed.data.shopDomain, name: parsed.data.name ?? null }, actor.id);
    revalidatePath(BASE);
    return ok({ url: r.authorizeUrl, storeId: r.storeId });
  } catch (err) {
    if (err instanceof ShopifyOAuthError && err.code === "INVALID_SHOP") return fail(err.message, { shopDomain: err.message });
    return handleError(err);
  }
}

/** Reconnect an existing store (same grant flow, same row). */
export async function reconnectStoreAction(id: string): Promise<ActionResult<{ url: string }>> {
  const actor = await requireRole("ADMIN");
  try {
    const store = await getStore(id);
    if (!store) return fail("Store not found.");
    const r = await beginInstall({ shopDomain: store.shopDomain }, actor.id);
    return ok({ url: r.authorizeUrl });
  } catch (err) {
    return handleError(err);
  }
}

export async function updateStoreSettingsAction(id: string, input: StoreSettingsInput): Promise<ActionResult<undefined>> {
  const actor = await requireRole("ADMIN");
  const parsed = storeSettingsSchema.safeParse(input);
  if (!parsed.success) return fail("Please fix the highlighted fields.", zodFieldErrors(parsed.error.issues));
  const v = parsed.data;
  const ordered = v.defaultWarehouseId && v.warehouseIds.includes(v.defaultWarehouseId) ? [v.defaultWarehouseId, ...v.warehouseIds.filter((w) => w !== v.defaultWarehouseId)] : v.warehouseIds;
  try {
    const before = await getStore(id);
    await updateStoreSettings(
      id,
      { name: v.name, ordersImportEnabled: v.ordersImportEnabled, importTestOrders: v.importTestOrders, ordersImportSince: v.ordersImportSince ? new Date(v.ordersImportSince) : null, publishEnabled: v.publishEnabled, publishLocationId: v.publishLocationId ?? null, fulfilLocationId: v.fulfilLocationId ?? null, warehouseIds: ordered },
      actor.id,
    );
    // Decision #6: switching publishing on performs the initial publish of every matched SKU (compare-and-set).
    if (before && !before.publishEnabled && v.publishEnabled) {
      await enqueuePublishAll(id);
      await drainPending(id, 25_000);
    }
    revalidatePath(BASE);
    revalidatePath(`${BASE}/${id}`);
    return ok(undefined);
  } catch (err) {
    if (err instanceof ShopifyStoreError) {
      if (err.code === "PUBLISH_REQUIRES_LOCATION") return fail(err.message, { publishEnabled: err.message });
      if (err.code === "INVALID_LOCATION") return fail(err.message, { publishLocationId: err.message });
    }
    return handleError(err);
  }
}

export async function disconnectStoreAction(id: string): Promise<ActionResult<undefined>> {
  const actor = await requireRole("ADMIN");
  try {
    await disconnectStore(id, actor.id);
    revalidatePath(BASE);
    revalidatePath(`${BASE}/${id}`);
    return ok(undefined);
  } catch (err) {
    return handleError(err);
  }
}

export async function removePendingStoreAction(id: string): Promise<ActionResult<undefined>> {
  const actor = await requireRole("ADMIN");
  try {
    await removePendingStore(id, actor.id);
    revalidatePath(BASE);
    return ok(undefined);
  } catch (err) {
    return handleError(err);
  }
}

export async function testConnectionAction(id: string): Promise<ActionResult<{ shopName: string; locations: number }>> {
  const actor = await requireRole("ADMIN");
  try {
    const r = await testConnection(id, actor.id);
    revalidatePath(`${BASE}/${id}`);
    return ok({ shopName: r.shopName, locations: r.locations.length });
  } catch (err) {
    revalidatePath(`${BASE}/${id}`);
    return handleError(err);
  }
}

export async function retryWebhookEventAction(eventId: string, storeId: string): Promise<ActionResult<{ status: string | null }>> {
  await requireRole("ADMIN");
  try {
    const status = await retryWebhookEventNow(eventId);
    revalidatePath(`${BASE}/${storeId}`);
    return ok({ status });
  } catch (err) {
    return handleError(err);
  }
}

export async function retryJobAction(jobId: string, storeId: string): Promise<ActionResult<{ status: string | null }>> {
  await requireRole("ADMIN");
  try {
    const status = await retryJobNow(jobId);
    revalidatePath(`${BASE}/${storeId}`);
    return ok({ status });
  } catch (err) {
    return handleError(err);
  }
}

/** “Run pending now”: the same bounded drain the webhook receiver runs after each delivery. */
export async function runPendingAction(storeId: string): Promise<ActionResult<{ events: number; jobs: number }>> {
  await requireRole("ADMIN");
  try {
    const r = await drainPending(storeId, 20_000);
    revalidatePath(`${BASE}/${storeId}`);
    return ok(r);
  } catch (err) {
    return handleError(err);
  }
}

// ---------------------------------------------------------------------------
// Step 2 — catalog sync + variant mapping
// ---------------------------------------------------------------------------

export type CatalogSyncSummary = Pick<CatalogSyncResult, "mode" | "full" | "seen" | "created" | "removed" | "summary" | "durationMs">;

export async function syncCatalogAction(storeId: string): Promise<ActionResult<CatalogSyncSummary>> {
  const actor = await requireRole("ADMIN");
  try {
    const r = await syncCatalog(storeId, { mode: "auto", budgetMs: 120_000, actorId: actor.id });
    revalidatePath(`${BASE}/${storeId}`);
    return ok({ mode: r.mode, full: r.full, seen: r.seen, created: r.created, removed: r.removed, summary: r.summary, durationMs: r.durationMs });
  } catch (err) {
    revalidatePath(`${BASE}/${storeId}`);
    return handleError(err);
  }
}

// ---------------------------------------------------------------------------
// Customer directory sync (D-065)
// ---------------------------------------------------------------------------

export async function syncCustomersAction(storeId: string): Promise<ActionResult<CustomerSyncResult>> {
  const actor = await requireRole("ADMIN");
  try {
    const r = await syncCustomers(storeId, { budgetMs: 120_000, actorId: actor.id });
    revalidatePath(`${BASE}/${storeId}`);
    revalidatePath("/admin/customers");
    return ok(r);
  } catch (err) {
    revalidatePath(`${BASE}/${storeId}`);
    return handleError(err);
  }
}

export async function mapVariantAction(storeId: string, input: MapVariantInput): Promise<ActionResult<undefined>> {
  const actor = await requireRole("ADMIN");
  const parsed = mapVariantSchema.safeParse(input);
  if (!parsed.success) return fail("Choose a V3PL SKU.", zodFieldErrors(parsed.error.issues));
  try {
    await mapManually(storeId, parsed.data.mappingId, parsed.data.variantId, actor.id);
    revalidatePath(`${BASE}/${storeId}`);
    return ok(undefined);
  } catch (err) {
    return handleError(err);
  }
}

export async function unmapAction(storeId: string, mappingId: string): Promise<ActionResult<undefined>> {
  const actor = await requireRole("ADMIN");
  try {
    await unmap(storeId, mappingId, actor.id);
    revalidatePath(`${BASE}/${storeId}`);
    return ok(undefined);
  } catch (err) {
    return handleError(err);
  }
}

export async function setIgnoredAction(storeId: string, mappingId: string, ignored: boolean): Promise<ActionResult<undefined>> {
  const actor = await requireRole("ADMIN");
  try {
    await setIgnored(storeId, mappingId, ignored, actor.id);
    revalidatePath(`${BASE}/${storeId}`);
    return ok(undefined);
  } catch (err) {
    return handleError(err);
  }
}

export type InternalVariantOption = { id: string; sku: string; name: string | null; productName: string; ownerLabel: string };

/** Picker for manual mapping: active V3PL SKUs matching the search text (SKU, barcode or product name). */
export async function searchInternalVariantsAction(q: string): Promise<ActionResult<InternalVariantOption[]>> {
  await requireRole("ADMIN");
  const term = q.trim();
  if (term.length < 2) return ok([]);
  const rows = await searchVariants(term, { limit: 15 });
  return ok(rows.map((r) => ({ id: r.id, sku: r.sku, name: r.name, productName: r.product.name, ownerLabel: `${r.product.owner.businessName} (${r.product.owner.code})` })));
}

export type UnmatchedOption = { id: string; shopifyProductId: string; productTitle: string; variantTitle: string | null; sku: string | null };

export async function listUnmatchedForImportAction(storeId: string, q: string): Promise<ActionResult<UnmatchedOption[]>> {
  await requireRole("ADMIN");
  const r = await listMappings({ storeId, status: "UNMATCHED", q: q.trim() || undefined, pageSize: 200 });
  return ok(r.rows.map((m) => ({ id: m.id, shopifyProductId: m.shopifyProductId, productTitle: m.shopifyProductTitle ?? "Untitled product", variantTitle: m.shopifyVariantTitle, sku: m.shopifySku })));
}

export async function previewImportAction(storeId: string, input: ImportPreviewInput): Promise<ActionResult<ImportPreview>> {
  await requireRole("ADMIN");
  const parsed = importPreviewSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid selection.", zodFieldErrors(parsed.error.issues));
  try {
    return ok(await previewImport(storeId, parsed.data.mappingIds, parsed.data.ownerId, parsed.data.ownerOverrides));
  } catch (err) {
    return handleError(err);
  }
}

export async function confirmImportAction(storeId: string, input: ImportConfirmInput): Promise<ActionResult<ImportResult>> {
  const actor = await requireRole("ADMIN");
  const parsed = importConfirmSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid selection.");
  try {
    const r = await confirmImport(storeId, parsed.data.items, actor.id, parsed.data.destination ?? null);
    revalidatePath(`${BASE}/${storeId}`);
    revalidatePath("/admin/products");
    return ok(r);
  } catch (err) {
    return handleError(err);
  }
}

// ---------------------------------------------------------------------------
// Step 3 — inbound orders
// ---------------------------------------------------------------------------

/** “Sync orders now”: bounded reconciliation of orders updated since the store checkpoint. */
export async function reconcileOrdersAction(storeId: string): Promise<ActionResult<ReconcileSummary>> {
  const actor = await requireRole("ADMIN");
  try {
    const r = await reconcileOrders(storeId, { budgetMs: 60_000, actorId: actor.id });
    revalidatePath(`${BASE}/${storeId}`);
    revalidatePath("/admin/orders");
    return ok(r);
  } catch (err) {
    return handleError(err);
  }
}

/** Backfill: import orders created since a date (within Shopify's 60-day window). */
export async function importOrdersSinceAction(storeId: string, input: ImportSinceInput): Promise<ActionResult<ReconcileSummary>> {
  const actor = await requireRole("ADMIN");
  const parsed = importSinceSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Enter a valid date.");
  try {
    const r = await importOrdersSince(storeId, new Date(parsed.data.since), { budgetMs: 90_000, actorId: actor.id });
    revalidatePath(`${BASE}/${storeId}`);
    revalidatePath("/admin/orders");
    return ok(r);
  } catch (err) {
    return handleError(err);
  }
}

/** Retry one Shopify order (e.g. after fixing a product mapping). */
export async function retryOrderImportAction(storeId: string, shopifyOrderId: string): Promise<ActionResult<OrderSyncOutcome>> {
  const actor = await requireRole("ADMIN");
  try {
    const r = await syncShopifyOrder(storeId, shopifyOrderId, { cause: "manual", eventId: `manual:${shopifyOrderId}:${Date.now()}`, actorId: actor.id, force: true });
    revalidatePath(`${BASE}/${storeId}`);
    revalidatePath("/admin/orders");
    return ok(r);
  } catch (err) {
    return handleError(err);
  }
}

// ---------------------------------------------------------------------------
// Step 4 — inventory publishing
// ---------------------------------------------------------------------------

/** “Publish all now”: enqueue every matched SKU and run what fits in the request budget (compare-and-set). */
export async function publishAllAction(storeId: string): Promise<ActionResult<{ queued: number; ran: number }>> {
  await requireRole("ADMIN");
  try {
    const queued = await enqueuePublishAll(storeId);
    const r = await drainPending(storeId, 25_000);
    revalidatePath(`${BASE}/${storeId}`);
    return ok({ queued, ran: r.jobs });
  } catch (err) {
    return handleError(err);
  }
}

/** “Force publish” one SKU: overwrite Shopify's quantity with V3PL available, ignoring the compare check. */
export async function forcePublishAction(storeId: string, variantId: string): Promise<ActionResult<PublishOutcome>> {
  const actor = await requireRole("ADMIN");
  try {
    const r = await publishVariant(storeId, variantId, { force: true, actorId: actor.id });
    revalidatePath(`${BASE}/${storeId}`);
    return ok(r);
  } catch (err) {
    return handleError(err);
  }
}

/** “Force publish all”: overwrite every matched SKU (Admin-confirmed). */
export async function forcePublishAllAction(storeId: string): Promise<ActionResult<{ published: number; skipped: number; failed: number }>> {
  const actor = await requireRole("ADMIN");
  try {
    const { prisma } = await import("@/lib/prisma");
    const mappings = await prisma.shopifyVariantMapping.findMany({ where: { storeId, status: "MATCHED", variantId: { not: null } }, select: { variantId: true } });
    const out = { published: 0, skipped: 0, failed: 0 };
    const deadline = Date.now() + 25_000;
    for (const m of mappings) {
      if (Date.now() > deadline) break;
      try {
        const r = await publishVariant(storeId, m.variantId!, { force: true, actorId: actor.id });
        if (r.action === "published") out.published++;
        else out.skipped++;
      } catch {
        out.failed++;
      }
    }
    revalidatePath(`${BASE}/${storeId}`);
    return ok(out);
  } catch (err) {
    return handleError(err);
  }
}
