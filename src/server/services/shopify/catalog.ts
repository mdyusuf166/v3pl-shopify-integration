import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { storeGraphql } from "./api";
import { computeMatches, normalizeSku, summarizeDecisions, type MatchRow } from "./catalog-match";
import { ShopifyApiError, firstUserError, shopifyFetch } from "./client";
import {
  BULK_RUN_MUTATION,
  BULK_STATUS_QUERY,
  BULK_VARIANTS_DOCUMENT,
  PRODUCT_VARIANTS_COUNT_QUERY,
  PRODUCT_VARIANTS_QUERY,
  PRODUCT_WITH_VARIANTS_QUERY,
  type BulkRunPayload,
  type BulkStatusPayload,
  type ProductVariantsCount,
  type ProductVariantsPage,
  type ProductWithVariants,
  type VariantNode,
} from "./queries";
import { describeError, logSync } from "./sync-log";

/**
 * Catalog sync (Step 2, shopify-integration.md §9): pull every Shopify variant of a store into
 * ShopifyVariantMapping (snapshots only — never inventory), then match by exact SKU.
 * Nothing is created in V3PL here; see catalog-import.ts for the explicit import flow.
 */

export class CatalogError extends Error {
  constructor(
    public readonly code: "NOT_CONNECTED" | "BULK_FAILED" | "TIMEOUT",
    message: string,
  ) {
    super(message);
  }
}

export type SyncMode = "auto" | "paged" | "bulk";
export const BULK_THRESHOLD = 2000;
const PAGE_SIZE = 250;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type CatalogVariant = {
  shopifyVariantId: string;
  shopifyProductId: string;
  shopifyInventoryItemId: string | null;
  shopifySku: string | null;
  shopifyProductTitle: string;
  shopifyVariantTitle: string | null;
  productStatus: string;
};

export function toCatalogVariant(n: VariantNode): CatalogVariant {
  return {
    shopifyVariantId: n.id,
    shopifyProductId: n.product.id,
    shopifyInventoryItemId: n.inventoryItem?.id ?? null,
    shopifySku: n.sku && n.sku.trim() ? n.sku : null,
    shopifyProductTitle: n.product.title,
    shopifyVariantTitle: n.title && n.title !== "Default Title" ? n.title : null,
    productStatus: n.product.status,
  };
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

export async function fetchVariantCount(storeId: string): Promise<number | null> {
  const d = await storeGraphql<ProductVariantsCount>(storeId, PRODUCT_VARIANTS_COUNT_QUERY);
  return d.productVariantsCount?.count ?? null;
}

async function fetchPaged(storeId: string, deadline: number): Promise<{ variants: CatalogVariant[]; full: boolean }> {
  const out: CatalogVariant[] = [];
  let after: string | null = null;
  for (;;) {
    if (Date.now() > deadline) return { variants: out, full: false };
    const page: ProductVariantsPage = await storeGraphql<ProductVariantsPage>(storeId, PRODUCT_VARIANTS_QUERY, { first: PAGE_SIZE, after });
    out.push(...page.productVariants.nodes.map(toCatalogVariant));
    if (!page.productVariants.pageInfo.hasNextPage) return { variants: out, full: true };
    after = page.productVariants.pageInfo.endCursor;
  }
}

async function fetchBulk(storeId: string, deadline: number): Promise<{ variants: CatalogVariant[]; full: boolean }> {
  const run = await storeGraphql<BulkRunPayload>(storeId, BULK_RUN_MUTATION, { query: BULK_VARIANTS_DOCUMENT });
  const err = firstUserError(run.bulkOperationRunQuery);
  if (err || !run.bulkOperationRunQuery.bulkOperation) throw new CatalogError("BULK_FAILED", `Shopify refused the bulk catalog export: ${err ?? "no operation returned"}`);
  const id = run.bulkOperationRunQuery.bulkOperation.id;
  for (;;) {
    if (Date.now() > deadline) throw new CatalogError("TIMEOUT", "The bulk catalog export did not finish in time; it will be retried by the next sync.");
    await sleep(2000);
    const st = await storeGraphql<BulkStatusPayload>(storeId, BULK_STATUS_QUERY, { id });
    const op = st.node;
    if (!op) throw new CatalogError("BULK_FAILED", "Bulk operation disappeared.");
    if (op.status === "COMPLETED") {
      if (!op.url) return { variants: [], full: true };
      const res = await shopifyFetch()(op.url, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new CatalogError("BULK_FAILED", `Could not download the bulk result (HTTP ${res.status}).`);
      const text = await res.text();
      const variants: CatalogVariant[] = [];
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        const node = JSON.parse(line) as VariantNode;
        if (node.id?.includes("/ProductVariant/") && node.product) variants.push(toCatalogVariant(node));
      }
      return { variants, full: true };
    }
    if (op.status === "FAILED" || op.status === "CANCELED" || op.status === "EXPIRED") {
      throw new CatalogError("BULK_FAILED", `Bulk catalog export ${op.status.toLowerCase()}${op.errorCode ? ` (${op.errorCode})` : ""}.`);
    }
  }
}

export async function fetchCatalog(storeId: string, mode: SyncMode, deadline: number): Promise<{ variants: CatalogVariant[]; full: boolean; mode: "paged" | "bulk" }> {
  let chosen: "paged" | "bulk" = mode === "bulk" ? "bulk" : "paged";
  if (mode === "auto") {
    const count = await fetchVariantCount(storeId).catch(() => null);
    chosen = count !== null && count > BULK_THRESHOLD ? "bulk" : "paged";
  }
  const r = chosen === "bulk" ? await fetchBulk(storeId, deadline) : await fetchPaged(storeId, deadline);
  return { ...r, mode: chosen };
}

// ---------------------------------------------------------------------------
// Snapshots + matching (database only)
// ---------------------------------------------------------------------------

type Db = Prisma.TransactionClient | typeof prisma;

/** Upsert snapshot rows for the given variants. Returns ids of rows touched and the previous SKU per row. */
export async function upsertSnapshots(storeId: string, variants: CatalogVariant[], seenAt: Date, db: Db = prisma): Promise<{ created: number; updated: number; previousSku: Map<string, string | null> }> {
  const ids = variants.map((v) => v.shopifyVariantId);
  const existing = await db.shopifyVariantMapping.findMany({ where: { storeId, shopifyVariantId: { in: ids } }, select: { id: true, shopifyVariantId: true, shopifySku: true } });
  const byShopifyId = new Map(existing.map((e) => [e.shopifyVariantId, e]));
  const previousSku = new Map<string, string | null>();
  let created = 0;
  let updated = 0;
  for (const v of variants) {
    const data = {
      shopifyProductId: v.shopifyProductId,
      shopifyInventoryItemId: v.shopifyInventoryItemId,
      shopifySku: v.shopifySku,
      shopifyProductTitle: v.shopifyProductTitle,
      shopifyVariantTitle: v.shopifyVariantTitle,
      lastSeenAt: seenAt,
    };
    const ex = byShopifyId.get(v.shopifyVariantId);
    if (ex) {
      // "" = existed without a SKU (distinct from null = brand-new row) so a later SKU counts as a change.
      previousSku.set(ex.id, ex.shopifySku ?? "");
      await db.shopifyVariantMapping.update({ where: { id: ex.id }, data });
      updated++;
    } else {
      try {
        const row = await db.shopifyVariantMapping.create({ data: { storeId, shopifyVariantId: v.shopifyVariantId, ...data, status: "UNMATCHED" }, select: { id: true } });
        previousSku.set(row.id, null);
        created++;
      } catch (err) {
        if ((err as { code?: string }).code !== "P2002") throw err;
        const row = await db.shopifyVariantMapping.update({ where: { storeId_shopifyVariantId: { storeId, shopifyVariantId: v.shopifyVariantId } }, data, select: { id: true, shopifySku: true } });
        previousSku.set(row.id, row.shopifySku ?? "");
        updated++;
      }
    }
  }
  return { created, updated, previousSku };
}

/**
 * Re-evaluate every mapping row of a store against the current V3PL catalogue and apply the
 * decisions. `previousSku` (from the upsert) lets IGNORED rows become UNMATCHED when the SKU changed.
 */
export async function rematchStore(storeId: string, previousSku: Map<string, string | null> = new Map(), db: Db = prisma) {
  const rows = await db.shopifyVariantMapping.findMany({ where: { storeId }, select: { id: true, shopifyVariantId: true, shopifySku: true, status: true, matchedBy: true, variantId: true } });
  const skus = [...new Set(rows.map((r) => normalizeSku(r.shopifySku)).filter(Boolean))];
  const internal = skus.length
    ? await db.productVariant.findMany({ where: { sku: { in: skus } }, select: { id: true, sku: true, status: true, product: { select: { status: true } } } })
    : [];
  const matchRows: MatchRow[] = rows.map((r) => ({ ...r, previousSku: previousSku.has(r.id) ? (previousSku.get(r.id) ?? null) : (r.shopifySku ?? "") }));
  const decisions = computeMatches(
    matchRows,
    internal.map((v) => ({ id: v.id, sku: v.sku, status: v.status, productStatus: v.product.status })),
  );
  let changed = 0;
  for (const d of decisions) {
    if (!d.changed) continue;
    try {
      await db.shopifyVariantMapping.update({ where: { id: d.id }, data: { status: d.status, matchedBy: d.matchedBy, variantId: d.variantId } });
      changed++;
    } catch (err) {
      // Unique (storeId, variantId) guard: the internal variant is already mapped in this store.
      if ((err as { code?: string }).code !== "P2002") throw err;
      await db.shopifyVariantMapping.update({ where: { id: d.id }, data: { status: "CONFLICT", matchedBy: null, variantId: null } });
      changed++;
    }
  }
  return { decisions, changed, summary: summarizeDecisions(decisions) };
}

/** Rows not seen in a completed full sync: non-manual rows are removed; manual ones are kept and flagged once. */
async function pruneVanished(storeId: string, runStartedAt: Date, previousSyncAt: Date | null): Promise<{ removed: number; flagged: number }> {
  const vanished = await prisma.shopifyVariantMapping.findMany({
    where: { storeId, lastSeenAt: { lt: runStartedAt } },
    select: { id: true, shopifySku: true, status: true, matchedBy: true, lastSeenAt: true, variant: { select: { sku: true } } },
  });
  let removed = 0;
  let flagged = 0;
  for (const v of vanished) {
    if (v.matchedBy === "MANUAL") {
      if (!previousSyncAt || v.lastSeenAt >= previousSyncAt) {
        await logSync({ storeId, direction: "INBOUND", entityType: "PRODUCT", operation: "catalog_sync", status: "NEEDS_ATTENTION", message: `Shopify variant mapped manually to V3PL SKU ${v.variant?.sku ?? "?"} no longer exists in the store. Unmap it or remap when the product returns.`, internalId: v.id });
        flagged++;
      }
      continue;
    }
    if (v.status === "MATCHED") {
      await logSync({ storeId, direction: "INBOUND", entityType: "PRODUCT", operation: "catalog_sync", status: "NEEDS_ATTENTION", message: `Shopify variant with SKU ${normalizeSku(v.shopifySku)} was removed from the store; its automatic mapping was dropped (it returns automatically if the variant reappears).`, externalId: v.shopifySku });
      flagged++;
    }
    await prisma.shopifyVariantMapping.delete({ where: { id: v.id } });
    removed++;
  }
  return { removed, flagged };
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export type CatalogSyncResult = {
  storeId: string;
  mode: "paged" | "bulk";
  full: boolean;
  seen: number;
  created: number;
  updated: number;
  removed: number;
  flagged: number;
  summary: Record<"MATCHED" | "UNMATCHED" | "CONFLICT" | "IGNORED", number>;
  durationMs: number;
};

export async function syncCatalog(storeId: string, opts: { mode?: SyncMode; budgetMs?: number; actorId?: string | null } = {}): Promise<CatalogSyncResult> {
  const started = Date.now();
  const runStartedAt = new Date(started);
  const deadline = started + (opts.budgetMs ?? 120_000);
  const store = await prisma.shopifyStore.findUnique({ where: { id: storeId }, select: { status: true, lastCatalogSyncAt: true } });
  if (!store || store.status !== "CONNECTED") throw new CatalogError("NOT_CONNECTED", "Store is not connected.");
  try {
    const { variants, full, mode } = await fetchCatalog(storeId, opts.mode ?? "auto", deadline);
    const up = await upsertSnapshots(storeId, variants, runStartedAt);
    const match = await rematchStore(storeId, up.previousSku);
    const prune = full ? await pruneVanished(storeId, runStartedAt, store.lastCatalogSyncAt) : { removed: 0, flagged: 0 };
    if (full) await prisma.shopifyStore.update({ where: { id: storeId }, data: { lastCatalogSyncAt: runStartedAt } });
    const counts = await mappingCounts(storeId);
    const result: CatalogSyncResult = { storeId, mode, full, seen: variants.length, created: up.created, updated: up.updated, removed: prune.removed, flagged: prune.flagged, summary: counts, durationMs: Date.now() - started };
    await logSync({
      storeId,
      direction: "INBOUND",
      entityType: "PRODUCT",
      operation: "catalog_sync",
      status: full ? "SUCCESS" : "NEEDS_ATTENTION",
      message: `${full ? "Catalog synced" : "Catalog partially synced (time limit)"}: ${variants.length} Shopify variants — ${counts.MATCHED} matched, ${counts.UNMATCHED} unmatched, ${counts.CONFLICT} conflicts, ${counts.IGNORED} ignored${prune.removed ? `, ${prune.removed} removed` : ""}`,
      newValue: String(variants.length),
    });
    void match;
    return result;
  } catch (err) {
    const detail = describeError(err);
    await logSync({ storeId, direction: "INBOUND", entityType: "PRODUCT", operation: "catalog_sync", status: "FAILED", message: err instanceof CatalogError || err instanceof ShopifyApiError ? err.message : "Catalog sync failed", errorDetail: detail });
    throw err;
  }
}

/** Refresh the variants of one Shopify product (products/update webhook). Returns null when the product no longer exists. */
export async function syncProduct(storeId: string, productGid: string): Promise<{ variants: number; removed: number; summary: Record<string, number> } | null> {
  const seenAt = new Date();
  const data = await storeGraphql<ProductWithVariants>(storeId, PRODUCT_WITH_VARIANTS_QUERY, { id: productGid });
  const existing = await prisma.shopifyVariantMapping.findMany({ where: { storeId, shopifyProductId: productGid }, select: { id: true, shopifyVariantId: true, matchedBy: true, status: true, shopifySku: true, variant: { select: { sku: true } } } });
  if (!data.product) {
    for (const row of existing) {
      if (row.matchedBy === "MANUAL") {
        await logSync({ storeId, direction: "INBOUND", entityType: "PRODUCT", operation: "products/update", status: "NEEDS_ATTENTION", message: `Shopify product was deleted but one of its variants is mapped manually to V3PL SKU ${row.variant?.sku ?? "?"}. Unmap it.`, externalId: productGid, internalId: row.id });
        continue;
      }
      await prisma.shopifyVariantMapping.delete({ where: { id: row.id } });
    }
    return null;
  }
  const variants = data.product.variants.nodes.map(toCatalogVariant);
  const up = await upsertSnapshots(storeId, variants, seenAt);
  const present = new Set(variants.map((v) => v.shopifyVariantId));
  let removed = 0;
  for (const row of existing) {
    if (present.has(row.shopifyVariantId)) continue;
    if (row.matchedBy === "MANUAL") {
      await logSync({ storeId, direction: "INBOUND", entityType: "PRODUCT", operation: "products/update", status: "NEEDS_ATTENTION", message: `A Shopify variant mapped manually to V3PL SKU ${row.variant?.sku ?? "?"} was removed from its product. Unmap it.`, externalId: row.shopifyVariantId, internalId: row.id });
      continue;
    }
    await prisma.shopifyVariantMapping.delete({ where: { id: row.id } });
    removed++;
  }
  const match = await rematchStore(storeId, up.previousSku);
  return { variants: variants.length, removed, summary: match.summary };
}

export async function mappingCounts(storeId: string): Promise<Record<"MATCHED" | "UNMATCHED" | "CONFLICT" | "IGNORED", number> & { total: number }> {
  const rows = await prisma.shopifyVariantMapping.groupBy({ by: ["status"], where: { storeId }, _count: { _all: true } });
  const out = { MATCHED: 0, UNMATCHED: 0, CONFLICT: 0, IGNORED: 0, total: 0 };
  for (const r of rows) {
    out[r.status] = r._count._all;
    out.total += r._count._all;
  }
  return out;
}
