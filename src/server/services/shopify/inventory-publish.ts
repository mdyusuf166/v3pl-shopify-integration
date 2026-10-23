import { randomUUID } from "node:crypto";
import type { ShopifyOutboundJob } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { availableForVariants } from "@/server/services/inventory";
import { storeGraphql } from "./api";
import { firstUserError } from "./client";
import { NonRetryableJobError, enqueueJob, type JobRunResult } from "./jobs";
import { INVENTORY_ACTIVATE_MUTATION, INVENTORY_LEVEL_QUERY, INVENTORY_SET_QUANTITIES_MUTATION, type InventoryActivatePayload, type InventoryLevelPayload, type InventorySetPayload } from "./queries";
import { describeError, logSync } from "./sync-log";

/**
 * Step 4 inventory publishing — one-way V3PL → Shopify (D-024, shopify-integration.md §11).
 * published = Σ available across the store's warehouses (rule ALL_AVAILABLE), written to the store's
 * publish location with compare-and-set: the expected Shopify value is what we published last
 * (first time: Shopify's current value). A mismatch is never overwritten silently → attention +
 * Force publish. Shopify quantities are never read INTO V3PL.
 */

export class PublishError extends Error {
  constructor(
    public readonly code: "DISABLED" | "NO_MAPPING" | "NOT_CONNECTED" | "CONFLICT" | "SHOPIFY",
    message: string,
    public readonly detail?: string,
  ) {
    super(message);
  }
}

export type PublishOutcome = { action: "published" | "skipped_equal" | "skipped_disabled" | "skipped_no_mapping" | "conflict"; sku: string | null; available: number | null; shopifyBefore: number | null; lastPublished: number | null; message: string };

/**
 * Idempotency keys for Shopify's `@idempotent` directive (required on inventory mutations since
 * Admin API 2026-04). One fresh UUID per mutation execution, scoped to (store, inventory item,
 * location) and to the exact intent of the write. A job remembers the key + intent in `job.result.idem`
 * *before* calling Shopify; a retry of the same attempt with the same intent reuses the key, so Shopify
 * replays the stored result instead of applying a second mutation. Any change of intent (different
 * quantity / compare / force / location) gets a new key, and a completed job clears its keys.
 */
export type ActivateIntent = { itemId: string; locationId: string };
export type SetIntent = { itemId: string; locationId: string; quantity: number; compare: number | null; force: boolean };
export type IdemState = { activate?: ActivateIntent & { key: string }; set?: SetIntent & { key: string } };
export type IdemOptions = { prior: IdemState | null | undefined; save: (state: IdemState) => Promise<void> };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function sameIntent<T extends object>(a: T | undefined, b: T): boolean {
  if (!a) return false;
  return (Object.keys(b) as (keyof T)[]).every((k) => a[k] === b[k]);
}

/**
 * `InventorySetQuantitiesInput` as of Admin API 2026-07: the compare-and-set expectation is
 * `changeFromQuantity` on each quantity (null = skip the check → Force publish). The pre-2026-07
 * `compareQuantity` / `ignoreCompareQuantity` fields no longer exist and are rejected by the API.
 */
export function buildSetQuantitiesInput(p: { storeId: string; variantId: string } & SetIntent) {
  return {
    name: "available",
    reason: "correction",
    referenceDocumentUri: `v3pl://publish/${p.storeId}/${p.variantId}`,
    quantities: [{ inventoryItemId: p.itemId, locationId: p.locationId, quantity: p.quantity, changeFromQuantity: p.force ? null : p.compare }],
  };
}

/** Compare-and-set rejected (2026-07 `CHANGE_FROM_QUANTITY_STALE`; older `COMPARE_QUANTITY_STALE`). */
export function isCompareStale(err: { code?: string | null; message: string }): boolean {
  return /STALE/i.test(err.code ?? "") || /does not match persisted|changeFromQuantity|compareQuantity/i.test(err.message);
}

/** Reuse the remembered key when the intent is identical (retry of the same write); otherwise a new UUID. */
export function chooseIdempotencyKey<T extends object>(prior: (T & { key: string }) | undefined, intent: T): string {
  if (prior && UUID_RE.test(prior.key) && sameIntent(prior, intent)) return prior.key;
  return randomUUID();
}

async function readShopifyAvailable(storeId: string, inventoryItemId: string, locationId: string): Promise<{ level: number | null; tracked: boolean; exists: boolean }> {
  const d = await storeGraphql<InventoryLevelPayload>(storeId, INVENTORY_LEVEL_QUERY, { itemId: inventoryItemId, locationId });
  if (!d.inventoryItem) return { level: null, tracked: false, exists: false };
  const q = d.inventoryItem.inventoryLevel?.quantities.find((x) => x.name === "available")?.quantity;
  return { level: d.inventoryItem.inventoryLevel ? (q ?? 0) : null, tracked: d.inventoryItem.tracked, exists: true };
}

/**
 * Publish one variant to one store. `force` overwrites without compare (Admin “Force publish”).
 * Throws PublishError("CONFLICT") on a compare mismatch so callers/jobs can surface it.
 */
export async function publishVariant(storeId: string, variantId: string, opts: { force?: boolean; verify?: boolean; actorId?: string | null; idem?: IdemOptions } = {}): Promise<PublishOutcome> {
  const idem: IdemState = { ...(opts.idem?.prior ?? {}) };
  const remember = async (patch: IdemState) => {
    Object.assign(idem, patch);
    if (opts.idem) await opts.idem.save({ ...idem });
  };
  const store = await prisma.shopifyStore.findUnique({ where: { id: storeId }, select: { status: true, publishEnabled: true, publishLocationId: true, publishLocationName: true, warehouses: { select: { warehouseId: true } } } });
  if (!store || store.status !== "CONNECTED") throw new PublishError("NOT_CONNECTED", "Store is not connected.");
  const mapping = await prisma.shopifyVariantMapping.findFirst({ where: { storeId, variantId, status: "MATCHED" }, select: { id: true, shopifyInventoryItemId: true, shopifySku: true, lastPublishedAvailable: true, variant: { select: { sku: true } } } });
  const sku = mapping?.variant?.sku ?? mapping?.shopifySku ?? null;
  if (!mapping || !mapping.shopifyInventoryItemId) return { action: "skipped_no_mapping", sku, available: null, shopifyBefore: null, lastPublished: null, message: "No matched Shopify variant with an inventory item" };
  if (!store.publishEnabled || !store.publishLocationId || store.warehouses.length === 0) return { action: "skipped_disabled", sku, available: null, shopifyBefore: null, lastPublished: mapping.lastPublishedAvailable, message: "Publishing is off for this store" };

  const available = (await availableForVariants([variantId], store.warehouses.map((w) => w.warehouseId))).get(variantId) ?? 0;
  const last = mapping.lastPublishedAvailable;
  // Fast path (hooks/jobs): V3PL unchanged since the last publish → no Shopify call. The daily sweep passes
  // `verify` to skip this and read Shopify anyway, so manual edits in Shopify surface as conflicts.
  if (!opts.force && !opts.verify && last !== null && last === available) return { action: "skipped_equal", sku, available, shopifyBefore: null, lastPublished: last, message: `${sku}: already published as ${available}` };

  let shopify = await readShopifyAvailable(storeId, mapping.shopifyInventoryItemId, store.publishLocationId);
  if (!shopify.exists) throw new PublishError("SHOPIFY", `${sku}: the Shopify inventory item no longer exists`);
  if (shopify.level === null) {
    // Not stocked at the publish location yet: activate it there (approved decision #5), then it starts at 0.
    const activateIntent: ActivateIntent = { itemId: mapping.shopifyInventoryItemId, locationId: store.publishLocationId };
    const activateKey = chooseIdempotencyKey(idem.activate, activateIntent);
    await remember({ activate: { ...activateIntent, key: activateKey } });
    const act = await storeGraphql<InventoryActivatePayload>(storeId, INVENTORY_ACTIVATE_MUTATION, { inventoryItemId: mapping.shopifyInventoryItemId, locationId: store.publishLocationId, idempotencyKey: activateKey });
    const err = firstUserError(act.inventoryActivate);
    if (err) throw new PublishError("SHOPIFY", `${sku}: could not activate inventory at “${store.publishLocationName ?? "location"}”: ${err}`);
    shopify = { level: act.inventoryActivate.inventoryLevel?.quantities.find((x) => x.name === "available")?.quantity ?? 0, tracked: shopify.tracked, exists: true };
    await logSync({ storeId, direction: "OUTBOUND", entityType: "INVENTORY", operation: "inventory_activate", status: "SUCCESS", message: `${sku}: inventory activated at Shopify location “${store.publishLocationName ?? store.publishLocationId}”`, internalId: variantId, externalId: mapping.shopifyInventoryItemId });
  }
  const before = shopify.level ?? 0;

  // Shopify already shows what V3PL would publish → in sync, whatever we published last. This is the normal
  // state after a Shopify-originated sale (Shopify decremented at checkout, V3PL reserved the same quantity on
  // import) and after a publish whose response was lost — neither is a manual edit, so neither is a conflict.
  // The baseline is re-anchored so the next compare-and-set starts from the value both sides agree on.
  if (before === available && !opts.force) {
    if (last !== available) await prisma.shopifyVariantMapping.update({ where: { id: mapping.id }, data: { lastPublishedAvailable: available, lastPublishedAt: new Date() } });
    return { action: "skipped_equal", sku, available, shopifyBefore: before, lastPublished: available, message: `${sku}: Shopify already at ${available}` };
  }
  // Shopify differs from BOTH what we last published and what V3PL holds → changed in Shopify for a reason V3PL
  // does not know (manual edit, unimported sale, other app). Never overwritten silently.
  if (!opts.force && last !== null && before !== last) {
    const message = `${sku}: Shopify shows ${before} but V3PL last published ${last} — changed in Shopify by hand? Not overwritten. Use Force publish to set ${available}.`;
    await logSync({ storeId, direction: "OUTBOUND", entityType: "INVENTORY", operation: "inventory_publish", status: "NEEDS_ATTENTION", message, internalId: variantId, externalId: mapping.shopifyInventoryItemId, previousValue: String(before), newValue: String(available) });
    throw new PublishError("CONFLICT", message);
  }

  // Force publish = no compare-and-set (changeFromQuantity null, 2026-07); otherwise expect our last published value.
  const compare: number | null = opts.force ? null : (last ?? before);
  const setIntent: SetIntent = { itemId: mapping.shopifyInventoryItemId, locationId: store.publishLocationId, quantity: available, compare, force: !!opts.force };
  let setKey = chooseIdempotencyKey(idem.set, setIntent);
  let set: InventorySetPayload | undefined;
  for (let attempt = 0; attempt < 2 && !set; attempt++) {
    await remember({ set: { ...setIntent, key: setKey } });
    const res = await storeGraphql<InventorySetPayload>(storeId, INVENTORY_SET_QUANTITIES_MUTATION, { input: buildSetQuantitiesInput({ storeId, variantId, ...setIntent }), idempotencyKey: setKey });
    const code = res.inventorySetQuantities.userErrors[0]?.code ?? "";
    // The remembered key is unusable (Shopify recorded a failed attempt, or parameters differ) → one more try with a new key.
    if (attempt === 0 && (code === "IDEMPOTENCY_PREVIOUS_ATTEMPT_FAILED" || code === "IDEMPOTENCY_KEY_PARAMETER_MISMATCH")) {
      setKey = randomUUID();
      continue;
    }
    set = res;
  }
  const err = set!.inventorySetQuantities.userErrors[0];
  if (err) {
    if (isCompareStale(err)) {
      const message = `${sku}: Shopify quantity changed while publishing (expected ${compare}). Not overwritten. Use Force publish to set ${available}.`;
      await logSync({ storeId, direction: "OUTBOUND", entityType: "INVENTORY", operation: "inventory_publish", status: "NEEDS_ATTENTION", message, internalId: variantId, externalId: mapping.shopifyInventoryItemId, previousValue: String(before), newValue: String(available) });
      throw new PublishError("CONFLICT", message);
    }
    // In-flight duplicate on Shopify's side: plain (retryable) error so the job backs off and tries again.
    if (err.code === "IDEMPOTENCY_CONCURRENT_REQUEST") throw new Error(`${sku}: Shopify is still processing the previous publish — will retry`);
    throw new PublishError("SHOPIFY", `${sku}: Shopify refused the quantity update: ${err.message}`, err.code ?? undefined);
  }
  await prisma.shopifyVariantMapping.update({ where: { id: mapping.id }, data: { lastPublishedAvailable: available, lastPublishedAt: new Date() } });
  await logSync({ storeId, direction: "OUTBOUND", entityType: "INVENTORY", operation: opts.force ? "inventory_force_publish" : "inventory_publish", status: "SUCCESS", message: `${sku}: published ${before} → ${available} at “${store.publishLocationName ?? "location"}”${opts.force ? " (forced)" : ""}`, internalId: variantId, externalId: mapping.shopifyInventoryItemId, previousValue: String(before), newValue: String(available) });
  return { action: "published", sku, available, shopifyBefore: before, lastPublished: available, message: `${sku}: ${before} → ${available}` };
}

/** INVENTORY_PUBLISH runner (targetId = internal variant id). */
export async function runInventoryPublishJob(job: ShopifyOutboundJob): Promise<JobRunResult> {
  try {
    // Idempotency keys live in job.result.idem while an attempt is in flight (retries reuse them);
    // a successful run returns a result without them so a later re-arm starts with fresh keys.
    const priorResult = (job.result ?? {}) as { idem?: IdemState };
    const r = await publishVariant(job.storeId, job.targetId, {
      idem: {
        prior: priorResult.idem ?? null,
        save: async (idem) => {
          await prisma.shopifyOutboundJob.update({ where: { id: job.id }, data: { result: { ...priorResult, idem } } });
        },
      },
    });
    return { message: r.message, result: { action: r.action, available: r.available, shopifyBefore: r.shopifyBefore } };
  } catch (err) {
    if (err instanceof PublishError && err.code === "CONFLICT") throw new NonRetryableJobError(err.message);
    if (err instanceof PublishError && (err.code === "NOT_CONNECTED" || err.code === "SHOPIFY")) throw new NonRetryableJobError(err.message, err.detail);
    throw err;
  }
}

/** Enqueue a publish job for every MATCHED mapping of a store (initial publish when enabling, “Publish all now”). */
export async function enqueuePublishAll(storeId: string): Promise<number> {
  const mappings = await prisma.shopifyVariantMapping.findMany({ where: { storeId, status: "MATCHED", variantId: { not: null }, shopifyInventoryItemId: { not: null } }, select: { variantId: true } });
  for (const m of mappings) await enqueueJob(prisma, { storeId, type: "INVENTORY_PUBLISH", targetType: "ProductVariant", targetId: m.variantId!, dedupeKey: `publish:${storeId}:${m.variantId}` });
  return mappings.length;
}

export type SweepSummary = { checked: number; published: number; equal: number; conflicts: number; errors: number; complete: boolean };

/** Daily drift sweep for a publish-enabled store: reads Shopify for every matched SKU, republishes drift, flags manual edits as conflicts. */
export async function publishSweep(storeId: string, opts: { deadline?: number } = {}): Promise<SweepSummary> {
  const summary: SweepSummary = { checked: 0, published: 0, equal: 0, conflicts: 0, errors: 0, complete: true };
  const store = await prisma.shopifyStore.findUnique({ where: { id: storeId }, select: { status: true, publishEnabled: true, publishLocationId: true } });
  if (!store || store.status !== "CONNECTED" || !store.publishEnabled || !store.publishLocationId) return summary;
  const mappings = await prisma.shopifyVariantMapping.findMany({ where: { storeId, status: "MATCHED", variantId: { not: null }, shopifyInventoryItemId: { not: null } }, select: { variantId: true } });
  for (const m of mappings) {
    if (opts.deadline && Date.now() > opts.deadline) {
      summary.complete = false;
      break;
    }
    summary.checked++;
    try {
      const r = await publishVariant(storeId, m.variantId!, { verify: true });
      if (r.action === "published") summary.published++;
      else if (r.action === "skipped_equal") summary.equal++;
    } catch (err) {
      if (err instanceof PublishError && err.code === "CONFLICT") summary.conflicts++;
      else {
        summary.errors++;
        await logSync({ storeId, direction: "OUTBOUND", entityType: "INVENTORY", operation: "inventory_sweep", status: "FAILED", message: `Publish sweep error for variant ${m.variantId}`, errorDetail: describeError(err), internalId: m.variantId });
      }
    }
  }
  await prisma.shopifyStore.update({ where: { id: storeId }, data: { lastPublishSweepAt: new Date() } });
  if (summary.checked > 0) await logSync({ storeId, direction: "OUTBOUND", entityType: "INVENTORY", operation: "inventory_sweep", status: summary.conflicts || summary.errors ? "NEEDS_ATTENTION" : "SUCCESS", message: `Publish sweep: ${summary.checked} SKUs checked — ${summary.published} republished, ${summary.equal} unchanged, ${summary.conflicts} conflicts, ${summary.errors} errors${summary.complete ? "" : " (time limit)"}` });
  return summary;
}

/** Live view for the Publishing tab: matched SKUs with V3PL available vs last published. */
export async function publishingOverview(storeId: string) {
  const store = await prisma.shopifyStore.findUniqueOrThrow({ where: { id: storeId }, select: { publishEnabled: true, publishLocationName: true, warehouses: { select: { warehouseId: true } } } });
  const mappings = await prisma.shopifyVariantMapping.findMany({ where: { storeId, status: "MATCHED", variantId: { not: null } }, orderBy: [{ shopifyProductTitle: "asc" }, { shopifySku: "asc" }], select: { id: true, variantId: true, shopifyProductTitle: true, shopifyVariantTitle: true, shopifySku: true, shopifyInventoryItemId: true, lastPublishedAvailable: true, lastPublishedAt: true, variant: { select: { sku: true } } } });
  const avail = await availableForVariants(mappings.map((m) => m.variantId!), store.warehouses.map((w) => w.warehouseId));
  return {
    publishEnabled: store.publishEnabled,
    locationName: store.publishLocationName,
    rows: mappings.map((m) => ({ ...m, available: avail.get(m.variantId!) ?? 0, drift: m.lastPublishedAvailable === null ? null : (avail.get(m.variantId!) ?? 0) - m.lastPublishedAvailable, publishable: !!m.shopifyInventoryItemId })),
  };
}
