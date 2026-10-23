import { prisma } from "@/lib/prisma";
import { OrderServiceError, addOrderNote, adjustLineQuantity, cancelOrder, createExternal, ensureActor, flagAttention, syncExternalUpdate, type CreateOrderInput, type CreateOrderLine } from "@/server/services/orders";
import { ShopifyOrderRequestError, recordShopifyOrderReference } from "@/server/services/shopify-order-request";
import { storeGraphql } from "./api";
import { normalizeSku } from "./catalog-match";
import { gidToId, toGid } from "./client";
import { resolveShopifyOrderCustomer } from "./customers-sync";
import { v3plOrderIdFromAttributes } from "./order-out";
import { ORDERS_QUERY, ORDER_QUERY, type OrderLineNode, type OrderNode, type OrderPayload, type OrdersPage } from "./queries";
import { describeError, logSync } from "./sync-log";

/**
 * Step 3 — inbound Shopify orders (shopify-integration.md §8, decisions of 2026-09-07).
 *
 * One function, syncShopifyOrder(), serves every path (five webhook topics, reconciliation,
 * backfill, manual Retry). It always re-fetches the order from the Admin API and then calls the
 * CORE order contracts only: createExternal, syncExternalUpdate, adjustLineQuantity, cancelOrder,
 * flagAttention, addOrderNote. No inventory, order, fulfilment or shipment table is written here.
 *
 * Rules:
 *  - Lines resolve by Shopify variant mapping or exact SKU (trim + upper-case). Never by title.
 *  - Any unresolved SHIPPABLE line → no V3PL order (attention + Retry).
 *  - requiresShipping=false lines are never passed to the core: no reservation, no fulfilment;
 *    they are recorded on the order as a note and in the sync log. A SKU-less non-shipping line
 *    never fails the import. An all-non-shipping order creates no V3PL order (v1 limitation —
 *    the core needs ≥ 1 line; see core follow-up request).
 *  - Reservation regardless of payment state (D-028) at the store's default warehouse; no
 *    warehouse → order created unreserved + attention.
 *  - Updates are state-based (Shopify currentQuantity is the target), so replays change nothing.
 *  - Refund after shipment / line added in Shopify → attention only; stock moves via V3PL returns.
 */

export type SyncCause = "orders/create" | "orders/updated" | "orders/edited" | "orders/cancelled" | "refunds/create" | "reconcile" | "backfill" | "manual";

export type OrderSyncOutcome = {
  action: "created" | "updated" | "cancelled" | "unresolved" | "skipped" | "not_found";
  orderId?: string | null;
  orderNumber?: string | null;
  message: string;
  stale?: boolean;
  unresolved?: string[];
  short?: { sku: string; requested: number; available: number }[];
  nonShipping?: string[];
};

export type SyncContext = {
  cause: SyncCause;
  /** Shopify event id (or webhook id) — becomes the idempotency key on core writes. */
  eventId?: string | null;
  webhookEventId?: string | null;
  actorId?: string | null;
  /** Backfill: ignore the store's ordersImportSince cut-off. */
  force?: boolean;
  /** Already-fetched order (reconciliation) — skips the per-order query. */
  prefetched?: OrderNode | null;
};

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

const money = (m: { shopMoney: { amount: string } } | null | undefined): string | null => (m?.shopMoney?.amount != null ? String(m.shopMoney.amount) : null);

export function lineTax(line: OrderLineNode): string | null {
  if (!line.taxLines?.length) return null;
  const sum = line.taxLines.reduce((s, t) => s + Number(t.priceSet?.shopMoney?.amount ?? 0), 0);
  return sum.toFixed(2);
}

/** Splits live lines (currentQuantity > 0) into warehouse lines and non-shipping lines. */
export function splitLines(nodes: OrderLineNode[]): { shippable: OrderLineNode[]; nonShipping: OrderLineNode[] } {
  const live = nodes.filter((l) => l.currentQuantity > 0);
  return { shippable: live.filter((l) => l.requiresShipping), nonShipping: live.filter((l) => !l.requiresShipping) };
}

export function describeLine(l: OrderLineNode): string {
  return `${l.title}${l.variantTitle && l.variantTitle !== "Default Title" ? ` / ${l.variantTitle}` : ""} ×${l.currentQuantity}${l.sku?.trim() ? ` (SKU ${normalizeSku(l.sku)})` : ""}`;
}

export function shipToFields(order: OrderNode) {
  const a = order.shippingAddress;
  const name = a?.name ?? [a?.firstName, a?.lastName].filter(Boolean).join(" ") ?? null;
  return {
    customerName: name || null,
    customerEmail: order.email ?? null,
    customerPhone: order.phone ?? a?.phone ?? null,
    shipName: name || null,
    shipCompany: a?.company ?? null,
    shipAddress1: a?.address1 ?? null,
    shipAddress2: a?.address2 || null,
    shipCity: a?.city ?? null,
    shipProvince: a?.provinceCode ?? a?.province ?? null,
    shipZip: a?.zip ?? null,
    shipCountry: a?.countryCodeV2 ?? a?.country ?? null,
    shipPhone: a?.phone ?? null,
  };
}

export type ResolvedLine = { line: OrderLineNode; variantId: string };

export function buildCreateInput(args: { storeId: string; shopDomain: string; order: OrderNode; resolved: ResolvedLine[]; warehouseId: string | null; eventId?: string | null }): CreateOrderInput {
  const { order } = args;
  const lines: CreateOrderLine[] = args.resolved.map(({ line, variantId }) => ({
    variantId,
    quantity: line.currentQuantity,
    unitPrice: money(line.originalUnitPriceSet),
    discount: money(line.totalDiscountSet),
    tax: lineTax(line),
    title: line.title,
    variantTitle: line.variantTitle && line.variantTitle !== "Default Title" ? line.variantTitle : null,
    requiresShipping: true,
    externalLineId: line.id,
    shopifyVariantId: line.variant?.id ?? null,
  }));
  return {
    source: "SHOPIFY",
    sourceRef: `${args.shopDomain} ${order.name}`,
    shopify: {
      storeId: args.storeId,
      orderId: gidToId(order.id),
      orderName: order.name,
      financialStatus: order.displayFinancialStatus ?? null,
      fulfillmentStatus: order.displayFulfillmentStatus ?? null,
      updatedAt: new Date(order.updatedAt),
      cancelledAt: order.cancelledAt ? new Date(order.cancelledAt) : null,
    },
    currency: order.currencyCode,
    subtotal: money(order.currentSubtotalPriceSet),
    discountTotal: money(order.currentTotalDiscountsSet),
    taxTotal: money(order.currentTotalTaxSet),
    shippingTotal: money(order.totalShippingPriceSet),
    total: money(order.currentTotalPriceSet),
    shippingMethod: order.shippingLines?.nodes?.[0]?.title ?? null,
    notes: order.note || null,
    tags: order.tags?.length ? order.tags.join(", ") : null,
    placedAt: new Date(order.createdAt),
    warehouseId: args.warehouseId,
    reserve: !!args.warehouseId && !order.cancelledAt,
    lines,
    externalEventId: args.eventId ? `${args.eventId}:create` : null,
    ...shipToFields(order),
  };
}

// ---------------------------------------------------------------------------
// Line resolution (SKU only)
// ---------------------------------------------------------------------------

type Resolution = { resolved: ResolvedLine[]; failures: string[] };

/** Variant mapping first, then exact normalised SKU against ACTIVE internal variants. Never titles. */
export async function resolveShippableLines(storeId: string, lines: OrderLineNode[]): Promise<Resolution> {
  const resolved: ResolvedLine[] = [];
  const failures: string[] = [];
  const variantIds = lines.map((l) => l.variant?.id).filter((x): x is string => !!x);
  const mappings = variantIds.length
    ? await prisma.shopifyVariantMapping.findMany({ where: { storeId, shopifyVariantId: { in: variantIds } }, select: { shopifyVariantId: true, status: true, variantId: true, variant: { select: { status: true, product: { select: { status: true } } } } } })
    : [];
  const byShopifyVariant = new Map(mappings.map((m) => [m.shopifyVariantId, m]));
  const skus = [...new Set(lines.map((l) => normalizeSku(l.sku)).filter(Boolean))];
  const internal = skus.length ? await prisma.productVariant.findMany({ where: { sku: { in: skus } }, select: { id: true, sku: true, status: true, product: { select: { status: true } } } }) : [];
  const bySku = new Map(internal.map((v) => [v.sku, v]));

  for (const line of lines) {
    const label = describeLine(line);
    const m = line.variant?.id ? byShopifyVariant.get(line.variant.id) : undefined;
    if (m?.status === "MATCHED" && m.variantId) {
      if (m.variant && (m.variant.status !== "ACTIVE" || m.variant.product.status !== "ACTIVE")) {
        failures.push(`${label}: mapped V3PL SKU is archived`);
        continue;
      }
      resolved.push({ line, variantId: m.variantId });
      continue;
    }
    if (m?.status === "CONFLICT") {
      failures.push(`${label}: SKU conflict in the product mapping`);
      continue;
    }
    const key = normalizeSku(line.sku);
    if (!key) {
      failures.push(`${label}: Shopify line has no SKU`);
      continue;
    }
    const v = bySku.get(key);
    if (!v) {
      failures.push(`${label}: unknown SKU ${key}`);
      continue;
    }
    if (v.status !== "ACTIVE" || v.product.status !== "ACTIVE") {
      failures.push(`${label}: SKU ${key} is archived in V3PL`);
      continue;
    }
    // Remember the match for next time (idempotent; a taken internal variant means a conflict).
    if (line.variant?.id && line.product?.id) {
      try {
        await prisma.shopifyVariantMapping.upsert({
          where: { storeId_shopifyVariantId: { storeId, shopifyVariantId: line.variant.id } },
          create: { storeId, shopifyVariantId: line.variant.id, shopifyProductId: line.product.id, shopifySku: line.sku, shopifyVariantTitle: line.variantTitle, shopifyProductTitle: line.title, status: "MATCHED", matchedBy: "SKU_EXACT", variantId: v.id },
          update: { status: "MATCHED", matchedBy: "SKU_EXACT", variantId: v.id, shopifySku: line.sku },
        });
      } catch (err) {
        if ((err as { code?: string }).code !== "P2002") throw err;
        // Either a concurrent delivery wrote the same mapping a moment ago (fine) or the internal
        // variant is already mapped to a different Shopify variant of this store (real conflict).
        const taken = await prisma.shopifyVariantMapping.findFirst({ where: { storeId, variantId: v.id }, select: { shopifyVariantId: true } });
        if (taken && taken.shopifyVariantId !== line.variant.id) {
          failures.push(`${label}: SKU ${key} is already mapped to a different Shopify variant in this store`);
          continue;
        }
      }
    }
    resolved.push({ line, variantId: v.id });
  }
  return { resolved, failures };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const storeSelect = { id: true, name: true, shopDomain: true, status: true, grantedScopes: true, ordersImportEnabled: true, importTestOrders: true, ordersImportSince: true, warehouses: { orderBy: { priority: "asc" as const }, take: 1, select: { warehouseId: true } } };

export async function syncShopifyOrder(storeId: string, shopifyOrderId: string, ctx: SyncContext): Promise<OrderSyncOutcome> {
  const store = await prisma.shopifyStore.findUnique({ where: { id: storeId }, select: storeSelect });
  if (!store) return { action: "skipped", message: "Store not found" };
  if (store.status !== "CONNECTED") return { action: "skipped", message: `Store is ${store.status.toLowerCase().replace("_", " ")} — order not synchronised` };
  const numericId = gidToId(shopifyOrderId);
  const gid = toGid("Order", numericId);
  const log = (status: "SUCCESS" | "FAILED" | "NEEDS_ATTENTION" | "SKIPPED", operation: string, message: string, extra: { orderId?: string | null; internalId?: string | null; errorDetail?: string | null } = {}) =>
    logSync({ storeId, direction: "INBOUND", entityType: "ORDER", operation, status, message, externalId: numericId, webhookEventId: ctx.webhookEventId ?? null, orderId: extra.orderId ?? null, internalId: extra.internalId ?? extra.orderId ?? null, errorDetail: extra.errorDetail ?? null });

  let order: OrderNode | null;
  try {
    order = ctx.prefetched ?? (await storeGraphql<OrderPayload>(storeId, ORDER_QUERY, { id: gid })).order;
  } catch (err) {
    await log("FAILED", `order_${ctx.cause}`, `Could not read Shopify order ${numericId}`, { errorDetail: describeError(err) });
    throw err;
  }
  if (!order) {
    await log("SKIPPED", `order_${ctx.cause}`, `Shopify order ${numericId} no longer exists`);
    return { action: "not_found", message: "Shopify order not found" };
  }

  const existing = await prisma.order.findUnique({
    where: { shopifyStoreId_shopifyOrderId: { shopifyStoreId: storeId, shopifyOrderId: numericId } },
    select: existingSelect,
  });
  if (!existing) {
    // A Shopify order V3PL itself created (D-062) is linked to its manual order, never imported — whichever of the
    // ORDER_CREATE runner and this webhook arrives first records the same reference; the other sees it recorded.
    const linked = await linkV3plOriginOrder(store, order, numericId, ctx, log);
    if (linked) return linked;
    return importNew(store, order, numericId, ctx, log);
  }
  return updateExisting(store, order, existing, numericId, ctx, log);
}

const existingSelect = { id: true, orderNumber: true, status: true, cancelledAt: true, shopifyUpdatedAt: true, items: { select: { id: true, sku: true, variantId: true, quantity: true, shippedQty: true, cancelledQty: true, reservedQty: true, shopifyLineItemId: true } } };

async function linkV3plOriginOrder(store: StoreRow, order: OrderNode, numericId: string, ctx: SyncContext, log: Logger): Promise<OrderSyncOutcome | null> {
  const v3plOrderId = v3plOrderIdFromAttributes(order.customAttributes);
  if (!v3plOrderId) return null;
  const target = await prisma.order.findUnique({ where: { id: v3plOrderId }, select: { id: true, orderNumber: true, source: true, shopifyStoreId: true, shopifyOrderId: true, shopifyOrderName: true } });
  if (!target || target.source === "SHOPIFY") return null; // marker from another system / deleted order → normal import
  if (target.shopifyOrderId && target.shopifyOrderId !== numericId) {
    // Two Shopify orders for one V3PL order: never import the extra one (that would reserve stock twice).
    await log("NEEDS_ATTENTION", "order_link", `Shopify order ${order.name} says it was created from V3PL order ${target.orderNumber}, which is already linked to Shopify order ${target.shopifyOrderName ?? target.shopifyOrderId}. Not imported — cancel the duplicate in Shopify Admin.`, { orderId: target.id });
    return { action: "skipped", orderId: target.id, orderNumber: target.orderNumber, message: `Duplicate Shopify order for V3PL order ${target.orderNumber} — not imported` };
  }
  try {
    const r = await recordShopifyOrderReference(target.id, { shopifyStoreId: store.id, shopifyOrderId: numericId, shopifyOrderName: order.name }, ctx.actorId ?? null);
    await log("SUCCESS", "order_link", `Shopify order ${order.name} was created from V3PL order ${target.orderNumber} — linked${r.updated ? "" : " (already recorded)"}, not imported, nothing reserved again`, { orderId: target.id });
  } catch (err) {
    if (!(err instanceof ShopifyOrderRequestError)) throw err;
    await log("NEEDS_ATTENTION", "order_link", `Shopify order ${order.name} claims V3PL order ${target.orderNumber} but the link was refused: ${err.message} Not imported.`, { orderId: target.id });
    return { action: "skipped", orderId: target.id, orderNumber: target.orderNumber, message: `Link refused: ${err.message}` };
  }
  return { action: "updated", orderId: target.id, orderNumber: target.orderNumber, message: `Shopify order ${order.name} linked to V3PL order ${target.orderNumber} (created from V3PL)` };
}

type StoreRow = { id: string; name: string; shopDomain: string; grantedScopes: string | null; ordersImportEnabled: boolean; importTestOrders: boolean; ordersImportSince: Date | null; warehouses: { warehouseId: string }[] };
type ExistingOrder = { id: string; orderNumber: string; status: string; cancelledAt: Date | null; shopifyUpdatedAt: Date | null; items: { id: string; sku: string; variantId: string; quantity: number; shippedQty: number; cancelledQty: number; reservedQty: number; shopifyLineItemId: string | null }[] };

/**
 * Which live Shopify line corresponds to each V3PL item. Imported orders carry the Shopify line id on the item;
 * orders V3PL created in Shopify (D-062) do not, so those items match through the store's variant mapping
 * (exact SKU as last resort). An item with no counterpart is left untouched — never treated as removed.
 */
async function matchLines(storeId: string, items: ExistingOrder["items"], lines: OrderLineNode[]): Promise<Map<string, OrderLineNode>> {
  const out = new Map<string, OrderLineNode>();
  const byLineId = new Map(lines.map((l) => [l.id, l]));
  const unlinked = items.filter((i) => !i.shopifyLineItemId);
  const variantToShopify = unlinked.length
    ? new Map((await prisma.shopifyVariantMapping.findMany({ where: { storeId, status: "MATCHED", variantId: { in: unlinked.map((i) => i.variantId) } }, select: { variantId: true, shopifyVariantId: true } })).map((m) => [m.variantId!, m.shopifyVariantId]))
    : new Map<string, string>();
  const taken = new Set<string>();
  for (const item of items) {
    let live: OrderLineNode | undefined;
    if (item.shopifyLineItemId) live = byLineId.get(item.shopifyLineItemId);
    else {
      const sv = variantToShopify.get(item.variantId);
      live = lines.find((l) => !taken.has(l.id) && ((sv && l.variant?.id === sv) || (!sv && normalizeSku(l.sku) === item.sku)));
    }
    if (!live) continue;
    taken.add(live.id);
    out.set(item.id, live);
  }
  return out;
}
type Logger = (status: "SUCCESS" | "FAILED" | "NEEDS_ATTENTION" | "SKIPPED", operation: string, message: string, extra?: { orderId?: string | null; internalId?: string | null; errorDetail?: string | null }) => Promise<void>;

async function importNew(store: StoreRow, order: OrderNode, numericId: string, ctx: SyncContext, log: Logger): Promise<OrderSyncOutcome> {
  const op = "order_import";
  if (!store.ordersImportEnabled) {
    if (ctx.cause !== "reconcile") await log("SKIPPED", op, `Order ${order.name} not imported — order import is switched off for this store`);
    return { action: "skipped", message: "Order import is off for this store" };
  }
  if (order.test && !store.importTestOrders) {
    await log("SKIPPED", op, `Order ${order.name} is a Shopify test order — not imported (enable “Import test orders” for development stores)`);
    return { action: "skipped", message: "Test order not imported" };
  }
  if (!ctx.force && store.ordersImportSince && new Date(order.createdAt) < store.ordersImportSince) {
    return { action: "skipped", message: `Order ${order.name} was created before the store's import start date` };
  }

  const { shippable, nonShipping } = splitLines(order.lineItems.nodes);
  const nonShippingText = nonShipping.map(describeLine);
  const { resolved, failures } = await resolveShippableLines(store.id, shippable);
  if (failures.length) {
    await log("NEEDS_ATTENTION", op, `Order ${order.name} not imported — ${failures.join("; ")}. Fix the product mapping, then Retry.`);
    return { action: "unresolved", message: `Unresolved lines: ${failures.join("; ")}`, unresolved: failures, nonShipping: nonShippingText };
  }
  if (resolved.length === 0) {
    const why = nonShipping.length ? `all ${nonShipping.length} item${nonShipping.length === 1 ? "" : "s"} are non-shipping (${nonShippingText.join("; ")})` : "it has no live line items";
    await log("SKIPPED", op, `Order ${order.name}: no warehouse action required — ${why}. No V3PL order created.`);
    return { action: "skipped", message: `No warehouse action required — ${why}`, nonShipping: nonShippingText };
  }

  const warehouseId = store.warehouses[0]?.warehouseId ?? null;
  const input = buildCreateInput({ storeId: store.id, shopDomain: store.shopDomain, order, resolved, warehouseId, eventId: ctx.eventId });
  // Customer directory link (D-065): only when the store granted read_customers; never blocks the import.
  input.customerId = await resolveShopifyOrderCustomer(store, numericId, ctx.actorId ?? null);
  const result = await createExternal(input, ctx.actorId ?? null);
  if (!result.created) {
    // Lost a race with a concurrent delivery of the same order: treat as an update.
    const existing = await prisma.order.findUnique({ where: { id: result.orderId }, select: existingSelect });
    if (existing) return updateExisting(store, order, existing, numericId, ctx, log);
    return { action: "updated", orderId: result.orderId, orderNumber: result.orderNumber, message: "Order already existed" };
  }

  const owners = new Set((await prisma.orderItem.findMany({ where: { orderId: result.orderId }, select: { ownerId: true } })).map((i) => i.ownerId)).size;
  const notes: string[] = [];
  if (!warehouseId) {
    await flagAttention(result.orderId, `Shopify store “${store.name}” has no default warehouse configured — configure it under Settings → Shopify Stores, then press Reserve now`, ctx.actorId ?? null);
    notes.push("not reserved: store has no default warehouse");
  }
  if (nonShippingText.length) {
    const actor = await ensureActor(prisma, ctx.actorId ?? null);
    await addOrderNote(result.orderId, `Shopify non-shipping items (no warehouse action required): ${nonShippingText.join("; ")}`, actor);
    notes.push(`${nonShippingText.length} non-shipping item${nonShippingText.length === 1 ? "" : "s"} noted, not reserved`);
  }
  const short = result.reservation.short.map((s) => ({ sku: s.sku, requested: s.requested, available: s.available }));
  if (short.length) notes.push(`insufficient stock: ${short.map((s) => `${s.sku} (${s.requested} needed, ${s.available} available)`).join(", ")}`);
  else if (warehouseId && !order.cancelledAt) notes.push(`${result.reservation.reserved.length} line${result.reservation.reserved.length === 1 ? "" : "s"} reserved`);
  if (order.cancelledAt) notes.push("imported as already cancelled");

  const message = `Order ${order.name} imported as V3PL order ${result.orderNumber} — ${resolved.length} warehouse line${resolved.length === 1 ? "" : "s"}, ${owners} owner${owners === 1 ? "" : "s"}${notes.length ? `; ${notes.join("; ")}` : ""}`;
  await log(short.length || !warehouseId ? "NEEDS_ATTENTION" : "SUCCESS", op, message, { orderId: result.orderId });
  return { action: "created", orderId: result.orderId, orderNumber: result.orderNumber, message, short, nonShipping: nonShippingText };
}

async function updateExisting(store: StoreRow, order: OrderNode, existing: ExistingOrder, numericId: string, ctx: SyncContext, log: Logger): Promise<OrderSyncOutcome> {
  const op = ctx.cause === "orders/cancelled" || order.cancelledAt ? "order_cancel" : ctx.cause === "refunds/create" ? "order_refund" : ctx.cause === "orders/edited" ? "order_edit" : "order_update";
  const eid = (suffix: string) => (ctx.eventId ? `${ctx.eventId}:${suffix}` : null);

  if (order.cancelledAt && existing.cancelledAt) {
    // Already cancelled in V3PL (incl. partially shipped → COMPLETED with remainder cancelled): nothing to do.
    return { action: "cancelled", orderId: existing.id, orderNumber: existing.orderNumber, message: `Order ${order.name} is already cancelled in V3PL` };
  }
  if (order.cancelledAt) {
    const r = await cancelOrder(existing.id, `Cancelled in Shopify${order.cancelReason ? ` (${order.cancelReason.toLowerCase().replace(/_/g, " ")})` : ""}`, ctx.actorId ?? null, eid("cancel"));
    if (!r.alreadyCancelled && !("replay" in r && r.replay)) {
      await log("SUCCESS", op, `Order ${order.name} cancelled in Shopify → V3PL order ${existing.orderNumber} cancelled, unshipped reservations released`, { orderId: existing.id });
    }
    return { action: "cancelled", orderId: existing.id, orderNumber: existing.orderNumber, message: `Order ${order.name} cancelled` };
  }

  const header = await syncExternalUpdate(
    existing.id,
    { shopifyFinancialStatus: order.displayFinancialStatus ?? null, shopifyFulfillmentStatus: order.displayFulfillmentStatus ?? null, shopifyUpdatedAt: new Date(order.updatedAt), tags: order.tags?.length ? order.tags.join(", ") : null, ...shipToFields(order) },
    ctx.actorId ?? null,
    eid("header"),
  );
  if ("stale" in header && header.stale) return { action: "skipped", stale: true, orderId: existing.id, orderNumber: existing.orderNumber, message: `Order ${order.name}: update older than the last applied change — ignored` };
  if (header.replay) return { action: "skipped", orderId: existing.id, orderNumber: existing.orderNumber, message: `Order ${order.name}: event already applied` };

  // Line reconciliation: Shopify currentQuantity is the target; the core refuses to go below what
  // has shipped or is being picked, in which case the order is flagged (refund after shipment).
  const matched = await matchLines(store.id, existing.items, order.lineItems.nodes);
  const changes: string[] = [];
  const attention: string[] = [];
  for (const item of existing.items) {
    const live = matched.get(item.id);
    // An imported line that disappeared from Shopify is gone (target 0); a V3PL-created line with no counterpart is left alone.
    const target = live && live.requiresShipping ? live.currentQuantity : live ? item.quantity : item.shopifyLineItemId ? 0 : item.quantity;
    if (target === item.quantity) continue;
    try {
      const r = await adjustLineQuantity(existing.id, item.id, target, ctx.cause === "refunds/create" ? "Refunded in Shopify" : "Edited in Shopify", ctx.actorId ?? null, eid(`line:${item.id}`));
      if (!r.replay) changes.push(`${item.sku} ${item.quantity} → ${target}`);
    } catch (err) {
      if (err instanceof OrderServiceError && (err.code === "INVALID_QUANTITY" || err.code === "BAD_STATUS")) {
        const floor = item.shippedQty + item.cancelledQty;
        attention.push(`${ctx.cause === "refunds/create" ? "Refund" : "Edit"} in Shopify reduced ${item.sku} to ${target} but ${floor} ${floor === 1 ? "unit is" : "units are"} already shipped or being picked — record a Return in V3PL when the goods arrive`);
        continue;
      }
      throw err;
    }
  }
  const known = new Set([...existing.items.map((i) => i.shopifyLineItemId), ...[...matched.values()].map((l) => l.id)]);
  const { shippable, nonShipping } = splitLines(order.lineItems.nodes);
  const added = shippable.filter((l) => !known.has(l.id));
  if (added.length) attention.push(`Line${added.length === 1 ? "" : "s"} added in Shopify after import: ${added.map(describeLine).join("; ")} — add to the V3PL order manually`);
  if (attention.length) await flagAttention(existing.id, attention.join(". "), ctx.actorId ?? null);

  const summary = [...changes.map((c) => `line ${c}`), ...(nonShipping.length ? [`${nonShipping.length} non-shipping item${nonShipping.length === 1 ? "" : "s"} not reserved`] : [])];
  const message = `Order ${order.name} synchronised (${ctx.cause}) → V3PL order ${existing.orderNumber}: ${summary.length ? summary.join(", ") : "details refreshed, no line changes"}${attention.length ? `. Attention: ${attention.join(". ")}` : ""}`;
  await log(attention.length ? "NEEDS_ATTENTION" : "SUCCESS", op, message, { orderId: existing.id });
  return { action: "updated", orderId: existing.id, orderNumber: existing.orderNumber, message };
}

// ---------------------------------------------------------------------------
// Reconciliation + backfill
// ---------------------------------------------------------------------------

export type ReconcileSummary = { scanned: number; created: number; updated: number; cancelled: number; unresolved: number; skipped: number; complete: boolean; checkpoint: Date | null };

async function runOrdersQuery(storeId: string, query: string, deadline: number, each: (o: OrderNode) => Promise<void>): Promise<{ scanned: number; complete: boolean; maxUpdatedAt: Date | null }> {
  let after: string | null = null;
  let scanned = 0;
  let maxUpdatedAt: Date | null = null;
  for (;;) {
    if (Date.now() > deadline) return { scanned, complete: false, maxUpdatedAt };
    const page: OrdersPage = await storeGraphql<OrdersPage>(storeId, ORDERS_QUERY, { first: 50, after, query });
    for (const o of page.orders.nodes) {
      if (Date.now() > deadline) return { scanned, complete: false, maxUpdatedAt };
      await each(o);
      scanned++;
      const u = new Date(o.updatedAt);
      if (!maxUpdatedAt || u > maxUpdatedAt) maxUpdatedAt = u;
    }
    if (!page.orders.pageInfo.hasNextPage) return { scanned, complete: true, maxUpdatedAt };
    after = page.orders.pageInfo.endCursor;
  }
}

function tally(summary: ReconcileSummary, o: OrderSyncOutcome) {
  if (o.action === "created") summary.created++;
  else if (o.action === "updated") summary.updated++;
  else if (o.action === "cancelled") summary.cancelled++;
  else if (o.action === "unresolved") summary.unresolved++;
  else summary.skipped++;
}

/** Safety net for missed webhooks: orders updated since the store checkpoint (D-031 layer 4). */
export async function reconcileOrders(storeId: string, opts: { budgetMs?: number; actorId?: string | null } = {}): Promise<ReconcileSummary> {
  const deadline = Date.now() + (opts.budgetMs ?? 60_000);
  const store = await prisma.shopifyStore.findUnique({ where: { id: storeId }, select: { status: true, ordersImportEnabled: true, lastOrderCheckpointAt: true, ordersImportSince: true, installedAt: true } });
  const summary: ReconcileSummary = { scanned: 0, created: 0, updated: 0, cancelled: 0, unresolved: 0, skipped: 0, complete: true, checkpoint: store?.lastOrderCheckpointAt ?? null };
  if (!store || store.status !== "CONNECTED" || !store.ordersImportEnabled) return summary;
  const since = store.lastOrderCheckpointAt ?? store.ordersImportSince ?? store.installedAt ?? new Date(Date.now() - 86_400_000);
  const run = await runOrdersQuery(storeId, `updated_at:>'${since.toISOString()}'`, deadline, async (o) => {
    tally(summary, await syncShopifyOrder(storeId, o.id, { cause: "reconcile", eventId: `reconcile:${gidToId(o.id)}:${o.updatedAt}`, actorId: opts.actorId ?? null, prefetched: o }));
  });
  summary.scanned = run.scanned;
  summary.complete = run.complete;
  if (run.complete) {
    summary.checkpoint = run.maxUpdatedAt ?? new Date(deadline - (opts.budgetMs ?? 60_000));
    await prisma.shopifyStore.update({ where: { id: storeId }, data: { lastOrderCheckpointAt: summary.checkpoint } });
  }
  if (run.scanned > 0) {
    await logSync({ storeId, direction: "INBOUND", entityType: "ORDER", operation: "order_reconcile", status: run.complete ? "SUCCESS" : "NEEDS_ATTENTION", message: `Reconciliation: ${run.scanned} Shopify order${run.scanned === 1 ? "" : "s"} checked — ${summary.created} imported, ${summary.updated} updated, ${summary.cancelled} cancelled, ${summary.unresolved} need attention, ${summary.skipped} skipped${run.complete ? "" : " (time limit — continues next run)"}` });
  }
  return summary;
}

/** Admin backfill within Shopify's 60-day window: imports orders created since a date, ignoring the cut-off. */
export async function importOrdersSince(storeId: string, since: Date, opts: { budgetMs?: number; actorId?: string | null } = {}): Promise<ReconcileSummary> {
  const deadline = Date.now() + (opts.budgetMs ?? 90_000);
  const summary: ReconcileSummary = { scanned: 0, created: 0, updated: 0, cancelled: 0, unresolved: 0, skipped: 0, complete: true, checkpoint: null };
  const run = await runOrdersQuery(storeId, `created_at:>='${since.toISOString()}'`, deadline, async (o) => {
    tally(summary, await syncShopifyOrder(storeId, o.id, { cause: "backfill", eventId: `backfill:${gidToId(o.id)}:${o.updatedAt}`, actorId: opts.actorId ?? null, force: true, prefetched: o }));
  });
  summary.scanned = run.scanned;
  summary.complete = run.complete;
  await logSync({ storeId, direction: "INBOUND", entityType: "ORDER", operation: "order_backfill", status: run.complete ? "SUCCESS" : "NEEDS_ATTENTION", message: `Import since ${since.toISOString().slice(0, 10)}: ${run.scanned} Shopify order${run.scanned === 1 ? "" : "s"} checked — ${summary.created} imported, ${summary.updated} updated, ${summary.cancelled} cancelled, ${summary.unresolved} need attention, ${summary.skipped} skipped${run.complete ? "" : " (time limit — run again to continue)"}` });
  return summary;
}
