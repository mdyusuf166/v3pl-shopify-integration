import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/server/services/audit";
import { addEvent } from "@/server/services/orders";

/**
 * Manual V3PL order → Shopify order, CORE side (D-061, docs/shopify-order-request.md).
 *
 * Core owns: store resolution from the authoritative variant mappings, eligibility validation of every
 * line, the outbound contract (`ShopifyOrderRequest`), idempotent job creation and the result contracts
 * (`recordShopifyOrderReference` / `markShopifyOrderFailed`). The Shopify session owns the ORDER_CREATE
 * runner that reads the contract and calls the Admin API. Core never calls Shopify.
 *
 * Idempotency: one `ShopifyOutboundJob` per order (dedupeKey `order:{orderId}`, type ORDER_CREATE) and
 * the existing UNIQUE(shopifyStoreId, shopifyOrderId) on Order. A DONE job / recorded reference is
 * never re-armed, so a V3PL order can create at most one Shopify order; the inbound `orders/create`
 * webhook for that Shopify order then matches the same V3PL order through the recorded reference.
 */

export type ShopifyOrderRequestErrorCode = "NOT_FOUND" | "NOT_ELIGIBLE" | "NO_MAPPING" | "AMBIGUOUS_MAPPING" | "MIXED_STORES" | "ALREADY_CREATED" | "INVALID_REFERENCE" | "BAD_STATUS";

export class ShopifyOrderRequestError extends Error {
  constructor(
    public readonly code: ShopifyOrderRequestErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const ORDER_CREATE_DEDUPE_KEY = (orderId: string) => `order:${orderId}`;

// ---------------------------------------------------------------------------
// Store resolution (authoritative, server-side)
// ---------------------------------------------------------------------------

export type ResolvedLine = { variantId: string; sku: string; storeId: string; shopifyVariantId: string; shopifyProductId: string; shopifyInventoryItemId: string | null };

export type StoreResolution =
  | { ok: true; storeId: string; storeName: string; shopDomain: string; lines: ResolvedLine[] }
  | { ok: false; code: "NO_MAPPING" | "AMBIGUOUS_MAPPING" | "MIXED_STORES"; message: string; details: Record<string, unknown> };

/**
 * Which connected Shopify store (if any) can receive an order for these variants:
 * - every variant needs exactly one MATCHED mapping in a CONNECTED store (missing → NO_MAPPING);
 * - a variant matched in several connected stores is never guessed (AMBIGUOUS_MAPPING);
 * - all variants must resolve to the same store (MIXED_STORES) — one V3PL order = one Shopify order.
 */
export async function resolveShopifyStoreForVariants(variantIds: string[]): Promise<StoreResolution> {
  const ids = [...new Set(variantIds)];
  if (ids.length === 0) return { ok: false, code: "NO_MAPPING", message: "The order has no lines to send.", details: {} };
  const variants = await prisma.productVariant.findMany({ where: { id: { in: ids } }, select: { id: true, sku: true } });
  const mappings = await prisma.shopifyVariantMapping.findMany({
    where: { variantId: { in: ids }, status: "MATCHED", store: { status: "CONNECTED" } },
    select: { variantId: true, shopifyVariantId: true, shopifyProductId: true, shopifyInventoryItemId: true, store: { select: { id: true, name: true, shopDomain: true } } },
  });
  const byVariant = new Map<string, typeof mappings>();
  for (const m of mappings) (byVariant.get(m.variantId!) ?? byVariant.set(m.variantId!, []).get(m.variantId!)!).push(m);
  const missing = variants.filter((v) => !(byVariant.get(v.id)?.length));
  if (missing.length) return { ok: false, code: "NO_MAPPING", message: `${missing.map((v) => v.sku).join(", ")} ${missing.length === 1 ? "is" : "are"} not mapped to any connected Shopify store. Map the SKU in Settings → Shopify stores first.`, details: { skus: missing.map((v) => v.sku) } };
  const ambiguous = variants.filter((v) => (byVariant.get(v.id)?.length ?? 0) > 1);
  if (ambiguous.length) {
    return { ok: false, code: "AMBIGUOUS_MAPPING", message: `${ambiguous.map((v) => `${v.sku} (${byVariant.get(v.id)!.map((m) => m.store.name).join(", ")})`).join("; ")} ${ambiguous.length === 1 ? "is" : "are"} mapped in more than one connected store — V3PL will not guess. Keep one SKU mapped to one store, or choose the store explicitly when that option exists.`, details: { skus: ambiguous.map((v) => ({ sku: v.sku, stores: byVariant.get(v.id)!.map((m) => m.store.name) })) } };
  }
  const lines: ResolvedLine[] = variants.map((v) => {
    const m = byVariant.get(v.id)![0];
    return { variantId: v.id, sku: v.sku, storeId: m.store.id, shopifyVariantId: m.shopifyVariantId, shopifyProductId: m.shopifyProductId, shopifyInventoryItemId: m.shopifyInventoryItemId };
  });
  const stores = new Map(mappings.map((m) => [m.store.id, m.store]));
  const storeIds = [...new Set(lines.map((l) => l.storeId))];
  if (storeIds.length > 1) {
    return { ok: false, code: "MIXED_STORES", message: `The lines belong to different Shopify stores (${storeIds.map((id) => `${stores.get(id)!.name}: ${lines.filter((l) => l.storeId === id).map((l) => l.sku).join(", ")}`).join("; ")}). One V3PL order can only be sent to one store — split the order.`, details: { stores: storeIds.map((id) => ({ storeId: id, storeName: stores.get(id)!.name, skus: lines.filter((l) => l.storeId === id).map((l) => l.sku) })) } };
  }
  const store = stores.get(storeIds[0])!;
  return { ok: true, storeId: store.id, storeName: store.name, shopDomain: store.shopDomain, lines };
}

// ---------------------------------------------------------------------------
// Eligibility + contract
// ---------------------------------------------------------------------------

const orderSelect = {
  id: true,
  orderNumber: true,
  source: true,
  status: true,
  placedAt: true,
  currency: true,
  subtotal: true,
  discountTotal: true,
  taxTotal: true,
  shippingTotal: true,
  total: true,
  shippingMethod: true,
  notes: true,
  tags: true,
  customerId: true,
  customerName: true,
  customerEmail: true,
  customerPhone: true,
  shipName: true,
  shipCompany: true,
  shipAddress1: true,
  shipAddress2: true,
  shipCity: true,
  shipProvince: true,
  shipZip: true,
  shipCountry: true,
  shipPhone: true,
  shopifyStoreId: true,
  shopifyOrderId: true,
  shopifyOrderName: true,
  shopifyOutboundStatus: true,
  shopifyOutboundError: true,
  items: { orderBy: { position: "asc" as const }, select: { id: true, variantId: true, sku: true, title: true, variantTitle: true, quantity: true, cancelledQty: true, unitPrice: true, currency: true, requiresShipping: true } },
  customer: { select: { id: true, billName: true, billCompany: true, billAddress1: true, billAddress2: true, billCity: true, billProvince: true, billZip: true, billCountry: true } },
} satisfies Prisma.OrderSelect;

type OrderRow = Prisma.OrderGetPayload<{ select: typeof orderSelect }>;

/** Sources that may be pushed to Shopify. Shopify-originated orders never are; portal orders are a later decision. */
const OUTBOUND_SOURCES = new Set(["MANUAL"]);

export type OutboundState = "NOT_SENT" | "PENDING" | "CREATED" | "FAILED" | "RETRYABLE";

export type Eligibility =
  | { ok: true; storeId: string; storeName: string; shopDomain: string; lines: ResolvedLine[]; state: OutboundState }
  | { ok: false; code: ShopifyOrderRequestErrorCode; message: string; details?: Record<string, unknown>; state: OutboundState };

async function loadOrder(orderId: string): Promise<OrderRow> {
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: orderSelect });
  if (!order) throw new ShopifyOrderRequestError("NOT_FOUND", "Order not found.");
  return order;
}

async function jobFor(orderId: string) {
  return prisma.shopifyOutboundJob.findUnique({ where: { dedupeKey: ORDER_CREATE_DEDUPE_KEY(orderId) }, select: { id: true, status: true, attempts: true, lastError: true, nextRetryAt: true, storeId: true, result: true, updatedAt: true } });
}

/** Derived outbound state: order columns are the truth for CREATED, the job for pending/retry detail. */
export function deriveOutboundState(order: Pick<OrderRow, "shopifyOrderId" | "shopifyOutboundStatus">, job: { status: string } | null): OutboundState {
  if (order.shopifyOrderId && order.shopifyOutboundStatus === "CREATED") return "CREATED";
  if (!job && !order.shopifyOutboundStatus) return "NOT_SENT";
  if (job?.status === "PENDING" || job?.status === "RUNNING") return "PENDING";
  if (job?.status === "FAILED") return "RETRYABLE";
  if (job?.status === "NEEDS_ATTENTION") return "FAILED";
  if (job?.status === "DONE") return order.shopifyOrderId ? "CREATED" : "FAILED";
  return order.shopifyOutboundStatus === "PENDING" ? "PENDING" : order.shopifyOutboundStatus === "FAILED" ? "FAILED" : "NOT_SENT";
}

function activeLines(order: OrderRow) {
  return order.items.filter((i) => i.quantity - i.cancelledQty > 0 && i.requiresShipping !== false);
}

/** Can this order be (or has it been) sent to Shopify? Never creates anything. */
export async function shopifyOrderEligibility(orderId: string): Promise<Eligibility> {
  const order = await loadOrder(orderId);
  const job = await jobFor(orderId);
  const state = deriveOutboundState(order, job);
  if (state === "CREATED") return { ok: false, code: "ALREADY_CREATED", message: `Already created in Shopify as ${order.shopifyOrderName ?? order.shopifyOrderId}.`, state };
  if (!OUTBOUND_SOURCES.has(order.source)) return { ok: false, code: "NOT_ELIGIBLE", message: `Only manual V3PL orders can be sent to Shopify (this order came from ${order.source.toLowerCase().replace("_", " ")}).`, state };
  if (order.status === "CANCELLED") return { ok: false, code: "NOT_ELIGIBLE", message: "Cancelled orders are not sent to Shopify.", state };
  const lines = activeLines(order);
  if (lines.length === 0) return { ok: false, code: "NOT_ELIGIBLE", message: "The order has no shippable lines to send.", state };
  const res = await resolveShopifyStoreForVariants(lines.map((l) => l.variantId));
  if (!res.ok) return { ok: false, code: res.code, message: res.message, details: res.details, state };
  if (order.shopifyStoreId && order.shopifyStoreId !== res.storeId) return { ok: false, code: "MIXED_STORES", message: "The order is already linked to a different Shopify store.", state };
  return { ok: true, storeId: res.storeId, storeName: res.storeName, shopDomain: res.shopDomain, lines: res.lines, state };
}

/** The outbound contract consumed by the Shopify session's ORDER_CREATE runner (docs/shopify-order-request.md). */
export type ShopifyOrderRequest = {
  version: 1;
  /** Equals the job dedupeKey; use it as the Shopify-side idempotency reference too. */
  idempotencyKey: string;
  origin: "V3PL_MANUAL";
  order: { id: string; orderNumber: string; source: string; placedAt: string; currency: string; shippingMethod: string | null; notes: string | null; tags: string | null; subtotal: string | null; discountTotal: string | null; taxTotal: string | null; shippingTotal: string | null; total: string | null };
  store: { id: string; shopDomain: string; name: string };
  customer: { customerId: string | null; name: string | null; email: string | null; phone: string | null };
  shippingAddress: { name: string | null; company: string | null; address1: string | null; address2: string | null; city: string | null; province: string | null; zip: string | null; country: string | null; phone: string | null };
  billingAddress: { name: string | null; company: string | null; address1: string | null; address2: string | null; city: string | null; province: string | null; zip: string | null; country: string | null } | null;
  lines: { orderItemId: string; variantId: string; sku: string; title: string; variantTitle: string | null; quantity: number; unitPrice: string | null; shopifyVariantId: string; shopifyProductId: string; shopifyInventoryItemId: string | null }[];
};

/** Build the contract fresh from the order + mappings (the job row carries only ids). Throws when not eligible. */
export async function buildShopifyOrderRequest(orderId: string): Promise<ShopifyOrderRequest> {
  const order = await loadOrder(orderId);
  const lines = activeLines(order);
  const res = await resolveShopifyStoreForVariants(lines.map((l) => l.variantId));
  if (!res.ok) throw new ShopifyOrderRequestError(res.code, res.message, res.details);
  if (!OUTBOUND_SOURCES.has(order.source)) throw new ShopifyOrderRequestError("NOT_ELIGIBLE", "Only manual V3PL orders can be sent to Shopify.");
  const byVariant = new Map(res.lines.map((l) => [l.variantId, l]));
  const c = order.customer;
  const billing = c && (c.billAddress1 || c.billCity || c.billName) ? { name: c.billName, company: c.billCompany, address1: c.billAddress1, address2: c.billAddress2, city: c.billCity, province: c.billProvince, zip: c.billZip, country: c.billCountry } : null;
  const dec = (v: { toString(): string } | null) => (v === null ? null : v.toString());
  return {
    version: 1,
    idempotencyKey: ORDER_CREATE_DEDUPE_KEY(order.id),
    origin: "V3PL_MANUAL",
    order: { id: order.id, orderNumber: order.orderNumber, source: order.source, placedAt: order.placedAt.toISOString(), currency: order.currency, shippingMethod: order.shippingMethod, notes: order.notes, tags: order.tags, subtotal: dec(order.subtotal), discountTotal: dec(order.discountTotal), taxTotal: dec(order.taxTotal), shippingTotal: dec(order.shippingTotal), total: dec(order.total) },
    store: { id: res.storeId, shopDomain: res.shopDomain, name: res.storeName },
    customer: { customerId: order.customerId, name: order.customerName ?? order.shipName, email: order.customerEmail, phone: order.customerPhone ?? order.shipPhone },
    shippingAddress: { name: order.shipName, company: order.shipCompany, address1: order.shipAddress1, address2: order.shipAddress2, city: order.shipCity, province: order.shipProvince, zip: order.shipZip, country: order.shipCountry, phone: order.shipPhone },
    billingAddress: billing,
    lines: lines.map((l) => {
      const m = byVariant.get(l.variantId)!;
      return { orderItemId: l.id, variantId: l.variantId, sku: l.sku, title: l.title, variantTitle: l.variantTitle, quantity: l.quantity - l.cancelledQty, unitPrice: dec(l.unitPrice), shopifyVariantId: m.shopifyVariantId, shopifyProductId: m.shopifyProductId, shopifyInventoryItemId: m.shopifyInventoryItemId };
    }),
  };
}

// ---------------------------------------------------------------------------
// Request (idempotent) and result contracts
// ---------------------------------------------------------------------------

export type RequestResult = { jobId: string; state: OutboundState; reused: boolean; storeId: string; storeName: string };

/**
 * Ask for the order to be created in Shopify: validates everything, then creates (or reuses) the single
 * ORDER_CREATE job for this order. Never partially requests; never creates a second job or re-arms a DONE
 * one; never touches inventory. The V3PL order itself is untouched apart from its outbound state.
 */
export async function requestShopifyOrder(orderId: string, actorId: string | null): Promise<RequestResult> {
  const eligibility = await shopifyOrderEligibility(orderId);
  const existing = await jobFor(orderId);
  if (!eligibility.ok) {
    if (eligibility.code === "ALREADY_CREATED" && existing) {
      const order = await loadOrder(orderId);
      return { jobId: existing.id, state: "CREATED", reused: true, storeId: existing.storeId, storeName: (await prisma.shopifyStore.findUnique({ where: { id: existing.storeId }, select: { name: true } }))?.name ?? "", ...(order.shopifyStoreId ? {} : {}) };
    }
    throw new ShopifyOrderRequestError(eligibility.code, eligibility.message, eligibility.details);
  }
  if (existing) {
    // Same request again: PENDING/RUNNING → reused as is; FAILED/NEEDS_ATTENTION → re-armed (safe: the runner
    // adopts by idempotency key / recorded reference before creating anything); DONE → never re-armed.
    if (existing.status === "FAILED" || existing.status === "NEEDS_ATTENTION") {
      await prisma.$transaction(async (tx) => {
        await tx.shopifyOutboundJob.update({ where: { id: existing.id }, data: { status: "PENDING", nextRetryAt: null, lockedAt: null } });
        await tx.order.update({ where: { id: orderId }, data: { shopifyOutboundStatus: "PENDING", shopifyOutboundError: null } });
        await addEvent(tx, orderId, "shopify_order_retry", `Shopify order creation retried (${eligibility.storeName})`, actorId, { jobId: existing.id, storeId: eligibility.storeId });
      });
      return { jobId: existing.id, state: "PENDING", reused: true, storeId: eligibility.storeId, storeName: eligibility.storeName };
    }
    return { jobId: existing.id, state: deriveOutboundState(await loadOrder(orderId), existing), reused: true, storeId: eligibility.storeId, storeName: eligibility.storeName };
  }
  try {
    const job = await prisma.$transaction(async (tx) => {
      const created = await tx.shopifyOutboundJob.create({ data: { storeId: eligibility.storeId, type: "ORDER_CREATE", targetType: "Order", targetId: orderId, dedupeKey: ORDER_CREATE_DEDUPE_KEY(orderId), status: "PENDING" }, select: { id: true } });
      await tx.order.update({ where: { id: orderId }, data: { shopifyStoreId: eligibility.storeId, shopifyOutboundStatus: "PENDING", shopifyOutboundError: null } });
      await addEvent(tx, orderId, "shopify_order_requested", `Order queued for creation in Shopify store ${eligibility.storeName}`, actorId, { jobId: created.id, storeId: eligibility.storeId, lines: eligibility.lines.map((l) => ({ sku: l.sku, shopifyVariantId: l.shopifyVariantId })) });
      await recordAudit({ userId: actorId, action: "order.shopify_requested", entityType: "Order", entityId: orderId, newValues: { storeId: eligibility.storeId, jobId: created.id } }, tx);
      return created;
    });
    return { jobId: job.id, state: "PENDING", reused: false, storeId: eligibility.storeId, storeName: eligibility.storeName };
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") {
      const raced = await jobFor(orderId); // concurrent request won the unique dedupeKey
      if (raced) return { jobId: raced.id, state: deriveOutboundState(await loadOrder(orderId), raced), reused: true, storeId: eligibility.storeId, storeName: eligibility.storeName };
    }
    throw err;
  }
}

/**
 * Result contract for the runner: record the Shopify order the store created. Idempotent (same reference →
 * `{ updated: false }`); a different reference for an order that already has one is refused, and the
 * UNIQUE(shopifyStoreId, shopifyOrderId) makes sure one Shopify order maps to exactly one V3PL order.
 */
export async function recordShopifyOrderReference(orderId: string, ref: { shopifyStoreId: string; shopifyOrderId: string; shopifyOrderName?: string | null }, actorId: string | null): Promise<{ updated: boolean }> {
  const storeId = ref?.shopifyStoreId?.trim();
  const shopifyOrderId = ref?.shopifyOrderId?.trim();
  if (!orderId?.trim() || !storeId || !shopifyOrderId) throw new ShopifyOrderRequestError("INVALID_REFERENCE", "Order id, store id and Shopify order id are all required.");
  try {
    return await prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({ where: { id: orderId }, select: { id: true, orderNumber: true, shopifyStoreId: true, shopifyOrderId: true, shopifyOutboundStatus: true } });
      if (!order) throw new ShopifyOrderRequestError("NOT_FOUND", "Order not found.");
      if (order.shopifyOrderId === shopifyOrderId && order.shopifyStoreId === storeId) return { updated: false };
      if (order.shopifyOrderId) throw new ShopifyOrderRequestError("BAD_STATUS", `Order ${order.orderNumber} is already linked to Shopify order ${order.shopifyOrderId}.`);
      if (order.shopifyStoreId && order.shopifyStoreId !== storeId) throw new ShopifyOrderRequestError("BAD_STATUS", "The Shopify order belongs to a different store than the one this order was queued for.");
      await tx.order.update({ where: { id: orderId }, data: { shopifyStoreId: storeId, shopifyOrderId, shopifyOrderName: ref.shopifyOrderName ?? null, shopifyOutboundStatus: "CREATED", shopifyOutboundError: null } });
      await tx.shopifyOutboundJob.updateMany({ where: { dedupeKey: ORDER_CREATE_DEDUPE_KEY(orderId) }, data: { result: { shopifyOrderId, shopifyOrderName: ref.shopifyOrderName ?? null } } });
      await addEvent(tx, orderId, "shopify_order_created", `Created in Shopify as ${ref.shopifyOrderName ?? shopifyOrderId}`, actorId, { shopifyStoreId: storeId, shopifyOrderId, shopifyOrderName: ref.shopifyOrderName ?? null });
      await recordAudit({ userId: actorId, action: "order.shopify_created", entityType: "Order", entityId: orderId, newValues: { shopifyStoreId: storeId, shopifyOrderId, shopifyOrderName: ref.shopifyOrderName ?? null } }, tx);
      return { updated: true };
    });
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") throw new ShopifyOrderRequestError("BAD_STATUS", "That Shopify order is already linked to another V3PL order.");
    throw err;
  }
}

/** Result contract for the runner: the attempt failed. The job row keeps retry/attention detail; the order stays intact. */
export async function markShopifyOrderFailed(orderId: string, message: string, actorId: string | null): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId }, select: { id: true, shopifyOrderId: true } });
    if (!order) throw new ShopifyOrderRequestError("NOT_FOUND", "Order not found.");
    if (order.shopifyOrderId) return; // already created — a late failure report changes nothing
    await tx.order.update({ where: { id: orderId }, data: { shopifyOutboundStatus: "FAILED", shopifyOutboundError: message.slice(0, 1000) } });
    await addEvent(tx, orderId, "shopify_order_failed", `Shopify order creation failed: ${message.slice(0, 300)}`, actorId, { message });
  });
}

/** For the order page: current outbound state with the reason / reference to show. */
export async function shopifyOutboundSummary(orderId: string): Promise<{ state: OutboundState; storeName: string | null; shopifyOrderName: string | null; shopifyOrderId: string | null; error: string | null; eligibility: Eligibility | null }> {
  const order = await loadOrder(orderId);
  const job = await jobFor(orderId);
  const state = deriveOutboundState(order, job);
  const store = order.shopifyStoreId ? await prisma.shopifyStore.findUnique({ where: { id: order.shopifyStoreId }, select: { name: true } }) : null;
  const eligibility = state === "NOT_SENT" || state === "RETRYABLE" || state === "FAILED" ? await shopifyOrderEligibility(orderId) : null;
  return { state, storeName: store?.name ?? (eligibility?.ok ? eligibility.storeName : null), shopifyOrderName: order.shopifyOrderName, shopifyOrderId: order.shopifyOrderId, error: order.shopifyOutboundError ?? job?.lastError ?? null, eligibility };
}
