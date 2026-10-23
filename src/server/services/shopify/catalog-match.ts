import type { ShopifyMappingStatus, ShopifyMatchedBy } from "@/generated/prisma/client";

/**
 * Pure SKU-matching logic for Shopify variant mappings (no database, no network).
 * Rules (approved 2026-09-07):
 *  - SKU is the ONLY automatic key. Normalisation = trim + upper-case, nothing else. Titles are never used.
 *  - MATCHED (SKU_EXACT) when exactly one ACTIVE internal variant carries the normalised SKU.
 *  - CONFLICT when the same normalised SKU appears on 2+ Shopify variants of the store, or when the
 *    internal variant is already mapped MANUALLY to a different Shopify variant of the store.
 *  - UNMATCHED when there is no SKU, no internal match, or the only internal match is ARCHIVED.
 *  - MANUAL mappings are never changed here. IGNORED is sticky until the Shopify SKU changes.
 */

export function normalizeSku(sku: string | null | undefined): string {
  return (sku ?? "").trim().toUpperCase();
}

export type MatchRow = {
  id: string;
  shopifyVariantId: string;
  /** Current Shopify SKU snapshot (raw). */
  shopifySku: string | null;
  /** SKU snapshot at the time the row was last evaluated (raw). "" = existed without a SKU; null = brand-new row. */
  previousSku: string | null;
  status: ShopifyMappingStatus;
  matchedBy: ShopifyMatchedBy | null;
  variantId: string | null;
};

export type InternalVariant = { id: string; sku: string; status: "ACTIVE" | "ARCHIVED"; productStatus: "ACTIVE" | "ARCHIVED" };

export type MatchDecision = {
  id: string;
  status: ShopifyMappingStatus;
  matchedBy: ShopifyMatchedBy | null;
  variantId: string | null;
  reason: string;
  changed: boolean;
};

export function computeMatches(rows: MatchRow[], internal: InternalVariant[]): MatchDecision[] {
  const bySku = new Map<string, InternalVariant>();
  for (const v of internal) bySku.set(normalizeSku(v.sku), v);

  const groups = new Map<string, MatchRow[]>();
  for (const r of rows) {
    const k = normalizeSku(r.shopifySku);
    if (!k) continue;
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }
  const manualByVariant = new Map<string, MatchRow>();
  for (const r of rows) if (r.matchedBy === "MANUAL" && r.variantId) manualByVariant.set(r.variantId, r);

  const out: MatchDecision[] = [];
  for (const r of rows) {
    const decide = (status: ShopifyMappingStatus, matchedBy: ShopifyMatchedBy | null, variantId: string | null, reason: string) => {
      out.push({ id: r.id, status, matchedBy, variantId, reason, changed: status !== r.status || matchedBy !== r.matchedBy || variantId !== r.variantId });
    };
    if (r.matchedBy === "MANUAL" && r.variantId) {
      decide("MATCHED", "MANUAL", r.variantId, "Mapped manually — preserved");
      continue;
    }
    const key = normalizeSku(r.shopifySku);
    // IGNORED is sticky (Admin decision) until the Shopify SKU itself changes — including for
    // variants without a SKU and for duplicates the Admin chose to ignore.
    const skuChanged = r.previousSku !== null && normalizeSku(r.previousSku) !== key;
    if (r.status === "IGNORED" && !skuChanged) {
      decide("IGNORED", null, null, "Ignored by Admin");
      continue;
    }
    if (!key) {
      decide("UNMATCHED", null, null, "Shopify variant has no SKU");
      continue;
    }
    const group = groups.get(key) ?? [];
    if (group.length > 1) {
      decide("CONFLICT", null, null, `SKU ${key} appears on ${group.length} Shopify variants in this store`);
      continue;
    }
    const iv = bySku.get(key);
    if (!iv) {
      decide("UNMATCHED", null, null, `No V3PL SKU ${key}`);
      continue;
    }
    if (iv.status !== "ACTIVE" || iv.productStatus !== "ACTIVE") {
      decide("UNMATCHED", null, null, `V3PL SKU ${key} is archived`);
      continue;
    }
    const manual = manualByVariant.get(iv.id);
    if (manual && manual.shopifyVariantId !== r.shopifyVariantId) {
      decide("CONFLICT", null, null, `V3PL SKU ${key} is already mapped manually to another Shopify variant`);
      continue;
    }
    decide("MATCHED", "SKU_EXACT", iv.id, `SKU ${key} matched`);
  }
  return out;
}

export function summarizeDecisions(decisions: MatchDecision[]): Record<ShopifyMappingStatus, number> {
  const s: Record<ShopifyMappingStatus, number> = { MATCHED: 0, UNMATCHED: 0, CONFLICT: 0, IGNORED: 0 };
  for (const d of decisions) s[d.status]++;
  return s;
}
