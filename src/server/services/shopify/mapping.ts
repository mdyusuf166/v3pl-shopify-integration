import type { Prisma, ShopifyMappingStatus } from "@/generated/prisma/client";
import { toCsv } from "@/lib/csv";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/server/services/audit";
import { normalizeSku } from "./catalog-match";
import { logSync } from "./sync-log";

/**
 * Admin operations on Shopify variant mappings (Step 2): list/filter, manual map, unmap,
 * ignore, unmatched export. Manual mappings are protected from automatic re-matching and by
 * the unique (storeId, variantId) constraint.
 */

export class MappingError extends Error {
  constructor(
    public readonly code: "NOT_FOUND" | "VARIANT_INVALID" | "ALREADY_MAPPED" | "BAD_STATUS",
    message: string,
  ) {
    super(message);
  }
}

export const MAPPING_PAGE_SIZE = 50;

export type MappingListParams = { storeId: string; status?: ShopifyMappingStatus; q?: string; page?: number; pageSize?: number };

export const mappingSelect = {
  id: true,
  shopifyProductId: true,
  shopifyVariantId: true,
  shopifyInventoryItemId: true,
  shopifySku: true,
  shopifyProductTitle: true,
  shopifyVariantTitle: true,
  status: true,
  matchedBy: true,
  variantId: true,
  lastSeenAt: true,
  updatedAt: true,
  variant: { select: { id: true, sku: true, name: true, status: true, product: { select: { id: true, name: true, status: true, owner: { select: { id: true, code: true, businessName: true, type: true } } } } } },
} satisfies Prisma.ShopifyVariantMappingSelect;

export type MappingRow = Prisma.ShopifyVariantMappingGetPayload<{ select: typeof mappingSelect }>;

export async function listMappings(params: MappingListParams) {
  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.min(200, params.pageSize ?? MAPPING_PAGE_SIZE);
  const q = params.q?.trim();
  const where: Prisma.ShopifyVariantMappingWhereInput = {
    storeId: params.storeId,
    status: params.status,
    ...(q
      ? {
          OR: [
            { shopifySku: { contains: q, mode: "insensitive" } },
            { shopifyProductTitle: { contains: q, mode: "insensitive" } },
            { shopifyVariantTitle: { contains: q, mode: "insensitive" } },
            { variant: { sku: { contains: q, mode: "insensitive" } } },
          ],
        }
      : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.shopifyVariantMapping.count({ where }),
    prisma.shopifyVariantMapping.findMany({ where, orderBy: [{ status: "asc" }, { shopifyProductTitle: "asc" }, { shopifySku: "asc" }], skip: (page - 1) * pageSize, take: pageSize, select: mappingSelect }),
  ]);
  return { rows, total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) };
}

async function loadRow(storeId: string, mappingId: string) {
  const row = await prisma.shopifyVariantMapping.findFirst({ where: { id: mappingId, storeId }, select: mappingSelect });
  if (!row) throw new MappingError("NOT_FOUND", "Mapping not found.");
  return row;
}

/** Admin maps a Shopify variant to an internal SKU. The internal variant must be active and free in this store. */
export async function mapManually(storeId: string, mappingId: string, variantId: string, actorId: string) {
  const row = await loadRow(storeId, mappingId);
  const variant = await prisma.productVariant.findUnique({ where: { id: variantId }, select: { id: true, sku: true, status: true, product: { select: { status: true, name: true, owner: { select: { businessName: true } } } } } });
  if (!variant || variant.status !== "ACTIVE" || variant.product.status !== "ACTIVE") throw new MappingError("VARIANT_INVALID", "Choose an active V3PL SKU.");
  const taken = await prisma.shopifyVariantMapping.findFirst({ where: { storeId, variantId, NOT: { id: mappingId } }, select: { shopifySku: true, shopifyProductTitle: true } });
  if (taken) throw new MappingError("ALREADY_MAPPED", `V3PL SKU ${variant.sku} is already mapped to “${taken.shopifyProductTitle ?? taken.shopifySku}” in this store.`);
  try {
    await prisma.$transaction(async (tx) => {
      await tx.shopifyVariantMapping.update({ where: { id: mappingId }, data: { status: "MATCHED", matchedBy: "MANUAL", variantId } });
      await recordAudit({ userId: actorId, action: "shopify_mapping.mapped", entityType: "ShopifyVariantMapping", entityId: mappingId, oldValues: { status: row.status, variantId: row.variantId }, newValues: { status: "MATCHED", matchedBy: "MANUAL", variantId, sku: variant.sku } }, tx);
      await logSync({ storeId, direction: "INBOUND", entityType: "PRODUCT", operation: "map_manual", status: "SUCCESS", message: `Shopify “${row.shopifyProductTitle ?? row.shopifySku}”${row.shopifyVariantTitle ? ` / ${row.shopifyVariantTitle}` : ""} mapped manually to V3PL SKU ${variant.sku} (${variant.product.owner.businessName})`, externalId: row.shopifyVariantId, internalId: variantId }, tx);
    });
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") throw new MappingError("ALREADY_MAPPED", `V3PL SKU ${variant.sku} is already mapped in this store.`);
    throw err;
  }
}

/** Removes the link. The next sync may re-match automatically when the SKUs are equal. */
export async function unmap(storeId: string, mappingId: string, actorId: string) {
  const row = await loadRow(storeId, mappingId);
  if (row.status !== "MATCHED") throw new MappingError("BAD_STATUS", "This Shopify variant is not mapped.");
  await prisma.$transaction(async (tx) => {
    await tx.shopifyVariantMapping.update({ where: { id: mappingId }, data: { status: "UNMATCHED", matchedBy: null, variantId: null } });
    await recordAudit({ userId: actorId, action: "shopify_mapping.unmapped", entityType: "ShopifyVariantMapping", entityId: mappingId, oldValues: { variantId: row.variantId, matchedBy: row.matchedBy } }, tx);
    await logSync({ storeId, direction: "INBOUND", entityType: "PRODUCT", operation: "unmap", status: "SUCCESS", message: `Mapping removed: Shopify “${row.shopifyProductTitle ?? row.shopifySku}” ↔ V3PL SKU ${row.variant?.sku ?? "?"}`, externalId: row.shopifyVariantId, internalId: row.variantId }, tx);
  });
}

export async function setIgnored(storeId: string, mappingId: string, ignored: boolean, actorId: string) {
  const row = await loadRow(storeId, mappingId);
  if (ignored && row.status === "MATCHED") throw new MappingError("BAD_STATUS", "Unmap the variant before ignoring it.");
  if (!ignored && row.status !== "IGNORED") return;
  await prisma.$transaction(async (tx) => {
    await tx.shopifyVariantMapping.update({ where: { id: mappingId }, data: { status: ignored ? "IGNORED" : "UNMATCHED", matchedBy: null, variantId: null } });
    await recordAudit({ userId: actorId, action: ignored ? "shopify_mapping.ignored" : "shopify_mapping.unignored", entityType: "ShopifyVariantMapping", entityId: mappingId, oldValues: { status: row.status } }, tx);
  });
}

/** Downloadable list of Shopify variants without a V3PL SKU (UNMATCHED + CONFLICT). */
export async function unmatchedCsv(storeId: string): Promise<string> {
  const rows = await prisma.shopifyVariantMapping.findMany({
    where: { storeId, status: { in: ["UNMATCHED", "CONFLICT"] } },
    orderBy: [{ shopifyProductTitle: "asc" }, { shopifySku: "asc" }],
    select: { shopifyProductTitle: true, shopifyVariantTitle: true, shopifySku: true, status: true, shopifyProductId: true, shopifyVariantId: true, lastSeenAt: true },
  });
  const headers = ["Shopify Product", "Shopify Variant", "Shopify SKU", "Normalized SKU", "Status", "Shopify Product ID", "Shopify Variant ID", "Last Seen"];
  return toCsv(
    headers,
    rows.map((r) => ({
      "Shopify Product": r.shopifyProductTitle ?? "",
      "Shopify Variant": r.shopifyVariantTitle ?? "",
      "Shopify SKU": r.shopifySku ?? "",
      "Normalized SKU": normalizeSku(r.shopifySku),
      Status: r.status === "CONFLICT" ? "Conflict" : "Unmatched",
      "Shopify Product ID": r.shopifyProductId.split("/").pop() ?? r.shopifyProductId,
      "Shopify Variant ID": r.shopifyVariantId.split("/").pop() ?? r.shopifyVariantId,
      "Last Seen": r.lastSeenAt.toISOString(),
    })),
  );
}
