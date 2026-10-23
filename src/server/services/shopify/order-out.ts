import type { ShopifyOutboundJob } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { ShopifyOrderRequestError, buildShopifyOrderRequest, markShopifyOrderFailed, recordShopifyOrderReference, type ShopifyOrderRequest } from "@/server/services/shopify-order-request";
import { storeGraphql } from "./api";
import { ShopifyApiError, gidToId } from "./client";
import { NonRetryableJobError, type JobRunResult } from "./jobs";
import { ORDERS_BY_TAG_QUERY, ORDER_CREATE_MUTATION, type OrderCreatePayload, type OrdersByTagPayload } from "./queries";
import { logSync } from "./sync-log";

/**
 * Manual V3PL order → Shopify order, SHOPIFY side (D-061 contract, D-062 decisions).
 *
 * ORDER_CREATE runner: consumes `buildShopifyOrderRequest` (core resolves the store and the Shopify
 * variant ids — no SKU lookup here), creates the order with `orderCreate` and records the result
 * through the core contracts only (`recordShopifyOrderReference` / `markShopifyOrderFailed`).
 *
 * Inventory: `inventoryBehaviour: BYPASS` — Shopify neither claims nor decrements stock for the
 * order. V3PL's reservation (made when the manual order was created) is the only stock effect;
 * Shopify quantities keep coming from V3PL publishing (one-way), and the inbound `orders/create`
 * webhook for this order links instead of importing (orders-in.ts), so nothing is reserved twice.
 *
 * Idempotency (same pattern as FULFILLMENT_CREATE): the V3PL order's recorded reference wins
 * first; then the id remembered on the job from an earlier attempt; then adoption of an order
 * Shopify already holds for this V3PL order (marker tag + `v3pl_idempotency_key` attribute); only
 * then `orderCreate`. The id is persisted on the job *before* the core link call, so a crash or a
 * `BAD_STATUS` between the two never leads to a second `orderCreate`.
 */

export const V3PL_TAG = "V3PL";
export const V3PL_ATTRIBUTE_KEY = "v3pl_idempotency_key";
export const V3PL_ORDER_ATTRIBUTE_KEY = "V3PL order";

/** Marker tags: a constant `V3PL` plus one per order (`V3PL-<orderNumber>`, used for the adoption search). */
export function v3plTags(orderNumber: string): string[] {
  return [V3PL_TAG, `${V3PL_TAG}-${orderNumber}`];
}

/** Shopify note wording (the V3PL notes, when any, follow on a new paragraph). */
export function v3plNote(orderNumber: string, notes: string | null): string {
  const head = `Created from V3PL order ${orderNumber}.`;
  return notes?.trim() ? `${head}\n\n${notes.trim()}` : head;
}

/** V3PL order id carried by a Shopify order's `v3pl_idempotency_key` attribute (`order:<id>`), or null. */
export function v3plOrderIdFromAttributes(attrs: { key: string; value: string | null }[] | null | undefined): string | null {
  const v = attrs?.find((a) => a.key === V3PL_ATTRIBUTE_KEY)?.value?.trim();
  if (!v || !v.startsWith("order:")) return null;
  const id = v.slice("order:".length).trim();
  return id || null;
}

function splitName(name: string | null): { firstName?: string; lastName?: string } {
  const n = name?.trim();
  if (!n) return {};
  const i = n.indexOf(" ");
  return i < 0 ? { lastName: n } : { firstName: n.slice(0, i), lastName: n.slice(i + 1).trim() };
}

type Addr = ShopifyOrderRequest["shippingAddress"] | NonNullable<ShopifyOrderRequest["billingAddress"]>;

/** MailingAddressInput (2026-07): codes when the V3PL value is a code, otherwise the deprecated text fields. */
export function mailingAddressInput(a: Addr | null): Record<string, string> | undefined {
  if (!a || !(a.address1 || a.city || a.zip || a.name)) return undefined;
  const out: Record<string, string> = {};
  Object.assign(out, splitName(a.name));
  if (a.company) out.company = a.company;
  if (a.address1) out.address1 = a.address1;
  if (a.address2) out.address2 = a.address2;
  if (a.city) out.city = a.city;
  if (a.zip) out.zip = a.zip;
  if (a.province) {
    if (a.province.trim().length <= 3) out.provinceCode = a.province.trim().toUpperCase();
    else out.province = a.province.trim();
  }
  if (a.country) {
    if (a.country.trim().length === 2) out.countryCode = a.country.trim().toUpperCase();
    else out.country = a.country.trim();
  }
  if ("phone" in a && a.phone) out.phone = a.phone;
  return out;
}

/** Pure mapping of the core contract onto `orderCreate` variables (unit-tested). */
export function buildOrderCreateInput(req: ShopifyOrderRequest): { order: Record<string, unknown>; options: Record<string, unknown> } {
  const currency = req.order.currency;
  const extraTags = (req.order.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  const tags = [...new Set([...v3plTags(req.order.orderNumber), ...extraTags])];
  const order: Record<string, unknown> = {
    currency,
    // No payment is known to V3PL: the order is unpaid/pending until the merchant records payment in Shopify.
    financialStatus: "PENDING",
    processedAt: req.order.placedAt,
    note: v3plNote(req.order.orderNumber, req.order.notes),
    tags,
    customAttributes: [
      { key: V3PL_ORDER_ATTRIBUTE_KEY, value: req.order.orderNumber },
      { key: V3PL_ATTRIBUTE_KEY, value: req.idempotencyKey },
    ],
    lineItems: req.lines.map((l) => ({
      variantId: l.shopifyVariantId,
      quantity: l.quantity,
      requiresShipping: true,
      // The V3PL retail price is the price of record; Shopify's catalog price is only used when V3PL has none.
      ...(l.unitPrice !== null ? { priceSet: { shopMoney: { amount: l.unitPrice, currencyCode: currency } } } : {}),
    })),
  };
  if (req.customer.email) order.email = req.customer.email;
  if (req.customer.phone) order.phone = req.customer.phone;
  const ship = mailingAddressInput(req.shippingAddress);
  if (ship) order.shippingAddress = ship;
  const bill = mailingAddressInput(req.billingAddress);
  if (bill) order.billingAddress = bill;
  if (req.order.shippingMethod || (req.order.shippingTotal !== null && Number(req.order.shippingTotal) > 0)) {
    order.shippingLines = [{ title: req.order.shippingMethod ?? "Shipping", priceSet: { shopMoney: { amount: req.order.shippingTotal ?? "0.00", currencyCode: currency } } }];
  }
  return {
    order,
    // BYPASS: V3PL already reserved the stock; Shopify must not claim or decrement it again (D-062).
    options: { inventoryBehaviour: "BYPASS", sendReceipt: false, sendFulfillmentReceipt: false },
  };
}

type Remembered = { shopifyOrderId?: string; shopifyOrderName?: string | null } | null;

async function remember(jobId: string, ref: { shopifyOrderId: string; shopifyOrderName: string | null }, extra: Record<string, unknown> = {}): Promise<void> {
  await prisma.shopifyOutboundJob.update({ where: { id: jobId }, data: { result: { ...ref, ...extra } } });
}

/** Record the reference through the core contract; `{ updated: false }` = already recorded (idempotent replay). */
async function link(job: ShopifyOutboundJob, orderId: string, ref: { shopifyOrderId: string; shopifyOrderName: string | null }, how: string, extra: Record<string, unknown> = {}): Promise<JobRunResult> {
  try {
    const r = await recordShopifyOrderReference(orderId, { shopifyStoreId: job.storeId, ...ref }, null);
    await logSync({ storeId: job.storeId, direction: "OUTBOUND", entityType: "ORDER", operation: "order_create", status: "SUCCESS", message: `V3PL order sent to Shopify as ${ref.shopifyOrderName ?? ref.shopifyOrderId} (${how}${r.updated ? "" : "; reference was already recorded"})`, internalId: orderId, externalId: ref.shopifyOrderId, orderId });
    return { message: r.updated ? `Created in Shopify as ${ref.shopifyOrderName ?? ref.shopifyOrderId}` : "Reference already recorded", result: { ...ref, ...extra, how } };
  } catch (err) {
    if (err instanceof ShopifyOrderRequestError) {
      // The Shopify order exists (id kept on the job) but V3PL refuses the link: never create another one —
      // surface it for an explicit reconciliation (cancel the extra Shopify order, or fix the V3PL link).
      throw new NonRetryableJobError(`Shopify order ${ref.shopifyOrderName ?? ref.shopifyOrderId} exists but V3PL could not record it: ${err.message} Reconcile by hand — nothing will be created twice.`, `${err.code} ${ref.shopifyOrderId}`);
    }
    throw err;
  }
}

/** Search Shopify for an order this V3PL order already produced (retry after a lost response / index catch-up). */
async function findExistingShopifyOrder(storeId: string, req: ShopifyOrderRequest): Promise<{ shopifyOrderId: string; shopifyOrderName: string | null } | null> {
  const tag = v3plTags(req.order.orderNumber)[1];
  const r = await storeGraphql<OrdersByTagPayload>(storeId, ORDERS_BY_TAG_QUERY, { query: `tag:'${tag}' status:any` });
  const hit = r.orders.nodes.find((o) => !o.cancelledAt && o.customAttributes.some((a) => a.key === V3PL_ATTRIBUTE_KEY && a.value === req.idempotencyKey));
  return hit ? { shopifyOrderId: gidToId(hit.id), shopifyOrderName: hit.name } : null;
}

/** ORDER_CREATE runner (targetId = V3PL order id). */
export async function runOrderCreateJob(job: ShopifyOutboundJob): Promise<JobRunResult> {
  const orderId = job.targetId;
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { id: true, orderNumber: true, shopifyStoreId: true, shopifyOrderId: true, shopifyOrderName: true } });
  if (!order) throw new NonRetryableJobError("V3PL order no longer exists.");

  // 1. A reference already recorded (this runner earlier, or the inbound orders/create webhook) wins.
  if (order.shopifyOrderId) {
    if (order.shopifyStoreId && order.shopifyStoreId !== job.storeId) throw new NonRetryableJobError(`V3PL order ${order.orderNumber} is linked to a Shopify order in a different store.`);
    return { message: `Already created in Shopify as ${order.shopifyOrderName ?? order.shopifyOrderId}`, result: { shopifyOrderId: order.shopifyOrderId, shopifyOrderName: order.shopifyOrderName, how: "already linked" } };
  }

  try {
    // 2. Contract (validated fresh by the core; typed errors mean the order is no longer eligible → attention).
    let req: ShopifyOrderRequest;
    try {
      req = await buildShopifyOrderRequest(orderId);
    } catch (err) {
      if (err instanceof ShopifyOrderRequestError) throw new NonRetryableJobError(err.message, err.code);
      throw err;
    }
    if (req.store.id !== job.storeId) throw new NonRetryableJobError(`V3PL order ${order.orderNumber} now resolves to store ${req.store.name}, not the store it was queued for. Request it again.`);

    // 3. Store + scope: write_orders must have been granted (new app version + reconnect, D-062).
    const store = await prisma.shopifyStore.findUnique({ where: { id: job.storeId }, select: { status: true, name: true, grantedScopes: true } });
    if (!store) throw new NonRetryableJobError("Shopify store no longer exists.");
    if (store.status !== "CONNECTED") throw new NonRetryableJobError(`Store ${store.name} is ${store.status.toLowerCase().replace("_", " ")} — reconnect it, then Retry.`);
    const granted = (store.grantedScopes ?? "").split(",").map((s) => s.trim());
    if (store.grantedScopes && !granted.includes("write_orders")) throw new NonRetryableJobError(`Store ${store.name} has not granted write_orders. Reconnect the store (Settings → Shopify Stores → Reconnect) to approve the new permission, then Retry.`, "SCOPE_MISSING write_orders");

    // 4. An id remembered from an earlier attempt (created, but the link never happened).
    const remembered = job.result as Remembered;
    if (remembered?.shopifyOrderId) return link(job, orderId, { shopifyOrderId: remembered.shopifyOrderId, shopifyOrderName: remembered.shopifyOrderName ?? null }, "created on an earlier attempt");

    // 5. Adoption: Shopify already holds an order for this V3PL order (lost response before we could remember it).
    const existing = await findExistingShopifyOrder(job.storeId, req);
    if (existing) {
      await remember(job.id, existing, { adopted: true });
      return link(job, orderId, existing, "adopted existing Shopify order", { adopted: true });
    }

    // 6. Create.
    const vars = buildOrderCreateInput(req);
    const res = await storeGraphql<OrderCreatePayload>(job.storeId, ORDER_CREATE_MUTATION, vars);
    const errs = res.orderCreate.userErrors;
    if (errs.length || !res.orderCreate.order) {
      const text = errs.length ? errs.map((e) => `${e.field?.filter(Boolean).join(".") ?? ""}${e.field?.length ? ": " : ""}${e.message}${e.code ? ` (${e.code})` : ""}`).join("; ") : "Shopify returned no order";
      throw new NonRetryableJobError(`Shopify refused the order for V3PL order ${order.orderNumber}: ${text}`, errs.map((e) => e.code ?? "").filter(Boolean).join(",") || undefined);
    }
    const ref = { shopifyOrderId: gidToId(res.orderCreate.order.id), shopifyOrderName: res.orderCreate.order.name };
    await remember(job.id, ref); // before the link: a crash here is recovered by step 4, never by a second create
    return link(job, orderId, ref, `${req.lines.length} line${req.lines.length === 1 ? "" : "s"}, ${req.lines.reduce((s, l) => s + l.quantity, 0)} unit(s), unpaid`);
  } catch (err) {
    // Auth failures are already flagged NEEDS_REAUTH by api.ts; retrying cannot fix them → attention.
    const final = err instanceof ShopifyApiError && (err.code === "UNAUTHORIZED" || err.code === "NOT_CONNECTED" || err.code === "NOT_CONFIGURED") ? new NonRetryableJobError(err.message, err.code) : err;
    const message = final instanceof Error ? final.message : String(final);
    await markShopifyOrderFailed(orderId, message, null).catch(() => undefined); // no-op once a reference exists
    throw final;
  }
}
