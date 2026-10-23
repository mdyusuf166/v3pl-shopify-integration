import type { Prisma, ShopifyOutboundJob } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { storeGraphql } from "./api";
import { FulfillmentServiceError, recordExternalReference } from "@/server/services/fulfillment";
import { firstUserError, toGid } from "./client";
import { NonRetryableJobError, type JobRunResult } from "./jobs";
import {
  FULFILLMENT_CREATE_MUTATION,
  FULFILLMENT_ORDER_MOVE_MUTATION,
  FULFILLMENT_TRACKING_UPDATE_MUTATION,
  ORDER_FULFILLMENT_CONTEXT_QUERY,
  type FulfillmentCreatePayload,
  type FulfillmentOrderMovePayload,
  type FulfillmentTrackingUpdatePayload,
  type OrderFulfillmentContext,
} from "./queries";
import { logSync } from "./sync-log";

/**
 * Step 4 outbound: V3PL shipment → Shopify fulfillment (+ tracking), shopify-integration.md §12.
 * Runners are idempotent: a shipment already linked to a Shopify fulfillment is a no-op; a
 * retry after a lost response adopts the fulfillment Shopify already has (by our recorded id or
 * by tracking number) instead of creating a second one. Linking uses the core contract
 * `fulfillment.recordExternalReference` (R-1, D-051) — never a direct write to core tables.
 */

const OPEN_FO_STATUSES = new Set(["OPEN", "IN_PROGRESS", "SCHEDULED", "ON_HOLD"]);

type ShipmentRow = Prisma.ShipmentGetPayload<{
  include: {
    items: { include: { orderItem: { select: { id: true; sku: true; variantId: true; shopifyLineItemId: true } } } };
    fulfillment: { select: { id: true; type: true; shopifyFulfillmentId: true; shopifyStoreId: true } };
    order: { select: { id: true; orderNumber: true; shopifyOrderId: true; shopifyOrderName: true; shopifyStoreId: true } };
  };
}>;

async function loadShipment(shipmentId: string): Promise<ShipmentRow | null> {
  return prisma.shipment.findUnique({
    where: { id: shipmentId },
    include: {
      items: { include: { orderItem: { select: { id: true, sku: true, variantId: true, shopifyLineItemId: true } } } },
      fulfillment: { select: { id: true, type: true, shopifyFulfillmentId: true, shopifyStoreId: true } },
      order: { select: { id: true, orderNumber: true, shopifyOrderId: true, shopifyOrderName: true, shopifyStoreId: true } },
    },
  });
}

type TrackingInput = { company?: string; number?: string; url?: string };
/** Tracking as last sent to Shopify, kept in job.result so a later TRACKING_UPDATE can skip a redundant push (and e-mail). */
type SentTracking = { company: string | null; number: string | null; url: string | null };

function trackingInput(s: { carrier: string | null; trackingNumber: string | null; trackingUrl: string | null }): TrackingInput | undefined {
  if (!s.trackingNumber && !s.trackingUrl && !s.carrier) return undefined;
  return { company: s.carrier ?? undefined, number: s.trackingNumber ?? undefined, url: s.trackingUrl ?? undefined };
}

function asSent(t: TrackingInput | { company?: string | null; number?: string | null; url?: string | null } | null | undefined): SentTracking | null {
  if (!t) return null;
  return { company: t.company ?? null, number: t.number ?? null, url: t.url ?? null };
}

function sameTracking(a: SentTracking | null, b: SentTracking | null): boolean {
  return !!a && !!b && a.company === b.company && a.number === b.number && a.url === b.url;
}

/**
 * Record the Shopify fulfillment id on the V3PL fulfilment through the core contract (R-1, D-051).
 * `{ updated: false }` = same reference already recorded (idempotent replay) → success.
 * BAD_STATUS / INVALID_REFERENCE / NOT_FOUND cannot be fixed by retrying: the id is kept on the
 * job so a later Retry adopts it instead of creating a second Shopify fulfillment, and the job
 * goes straight to Needs attention with the core's reason.
 */
async function linkFulfillment(storeId: string, fulfillmentId: string, shopifyFulfillmentId: string, job: ShopifyOutboundJob): Promise<{ updated: boolean }> {
  try {
    return await recordExternalReference(fulfillmentId, { shopifyStoreId: storeId, shopifyFulfillmentId }, null);
  } catch (err) {
    if (err instanceof FulfillmentServiceError) {
      await prisma.shopifyOutboundJob.update({ where: { id: job.id }, data: { result: { shopifyFulfillmentId } } });
      const shortId = shopifyFulfillmentId.split("/").pop();
      const hint = err.code === "BAD_STATUS" ? ` Shopify fulfillment ${shortId} exists — check the Shopify order and the V3PL fulfilment before retrying; nothing will be created twice.` : "";
      throw new NonRetryableJobError(`V3PL could not record the link to Shopify fulfillment ${shortId}: ${err.message}${hint}`, `${err.code} ${shopifyFulfillmentId}`);
    }
    throw err;
  }
}

/** FULFILLMENT_CREATE runner (targetId = V3PL shipment id). */
export async function runFulfillmentCreateJob(job: ShopifyOutboundJob): Promise<JobRunResult> {
  const shipment = await loadShipment(job.targetId);
  if (!shipment) throw new NonRetryableJobError("Shipment no longer exists.");
  if (shipment.fulfillment.type === "EXTERNAL") return { message: "Mirrored from Shopify — nothing to push" };
  if (shipment.fulfillment.shopifyFulfillmentId) return { message: `Already linked to Shopify fulfillment ${shipment.fulfillment.shopifyFulfillmentId.split("/").pop()}`, result: { shopifyFulfillmentId: shipment.fulfillment.shopifyFulfillmentId } };
  if (!shipment.order.shopifyOrderId || shipment.order.shopifyStoreId !== job.storeId) return { message: "Not a Shopify order for this store" };

  const store = await prisma.shopifyStore.findUnique({ where: { id: job.storeId }, select: { status: true, fulfilLocationId: true, fulfilLocationName: true, name: true } });
  if (!store || store.status !== "CONNECTED") throw new Error("Store is not connected");

  // A previous attempt may have created the fulfillment but failed to record the link.
  const remembered = (job.result as { shopifyFulfillmentId?: string } | null)?.shopifyFulfillmentId;
  if (remembered) {
    await linkFulfillment(job.storeId, shipment.fulfillment.id, remembered, job);
    await logSync({ storeId: job.storeId, direction: "OUTBOUND", entityType: "FULFILLMENT", operation: "fulfillment_create", status: "SUCCESS", message: `Shipment for V3PL order ${shipment.order.orderNumber} linked to Shopify fulfillment ${remembered.split("/").pop()} (created on an earlier attempt)`, internalId: shipment.id, externalId: remembered, orderId: shipment.order.id });
    return { message: "Linked previously created fulfillment", result: { shopifyFulfillmentId: remembered } };
  }

  const orderGid = toGid("Order", shipment.order.shopifyOrderId);
  const fetchCtx = async () => (await storeGraphql<OrderFulfillmentContext>(job.storeId, ORDER_FULFILLMENT_CONTEXT_QUERY, { id: orderGid })).order;
  let ctx = await fetchCtx();
  if (!ctx) throw new NonRetryableJobError(`Shopify order ${shipment.order.shopifyOrderName ?? shipment.order.shopifyOrderId} no longer exists`);

  // Adopt a fulfillment Shopify already has for this tracking number (retry after a lost response).
  if (shipment.trackingNumber) {
    const same = ctx.fulfillments.find((f) => f.status !== "CANCELLED" && f.trackingInfo.some((t) => t.number === shipment.trackingNumber));
    if (same) {
      const takenBy = await prisma.fulfillment.findUnique({ where: { shopifyStoreId_shopifyFulfillmentId: { shopifyStoreId: job.storeId, shopifyFulfillmentId: same.id } }, select: { id: true } });
      if (!takenBy) {
        await linkFulfillment(job.storeId, shipment.fulfillment.id, same.id, job);
        await logSync({ storeId: job.storeId, direction: "OUTBOUND", entityType: "FULFILLMENT", operation: "fulfillment_create", status: "SUCCESS", message: `Shipment for V3PL order ${shipment.order.orderNumber} matched existing Shopify fulfillment ${same.id.split("/").pop()} by tracking ${shipment.trackingNumber} — no duplicate created`, internalId: shipment.id, externalId: same.id, orderId: shipment.order.id });
        return { message: "Adopted existing fulfillment", result: { shopifyFulfillmentId: same.id, adopted: true, sentTracking: asSent(same.trackingInfo[0]) } };
      }
    }
  }

  // Allocate shipped quantities to fulfillment-order line items; move FOs to our location if needed.
  // Imported Shopify orders carry the Shopify line id on each OrderItem; orders V3PL created in Shopify
  // (D-062) do not, so those lines match through the store's variant mapping (exact SKU as last resort).
  const unmappedVariantIds = [...new Set(shipment.items.filter((it) => !it.orderItem.shopifyLineItemId).map((it) => it.orderItem.variantId))];
  const variantMap = unmappedVariantIds.length
    ? new Map((await prisma.shopifyVariantMapping.findMany({ where: { storeId: job.storeId, status: "MATCHED", variantId: { in: unmappedVariantIds } }, select: { variantId: true, shopifyVariantId: true } })).map((m) => [m.variantId!, m.shopifyVariantId]))
    : new Map<string, string>();
  const wantKey = (it: (typeof shipment.items)[number]) => (it.orderItem.shopifyLineItemId ? `id:${it.orderItem.shopifyLineItemId}` : variantMap.has(it.orderItem.variantId) ? `variant:${variantMap.get(it.orderItem.variantId)}` : `sku:${it.orderItem.sku.trim().toUpperCase()}`);
  const buildAllocation = (c: NonNullable<OrderFulfillmentContext["order"]>) => {
    const wanted = new Map<string, number>();
    for (const it of shipment.items) wanted.set(wantKey(it), (wanted.get(wantKey(it)) ?? 0) + it.quantity);
    const byFo = new Map<string, { id: string; quantity: number }[]>();
    const toMove = new Set<string>();
    for (const fo of c.fulfillmentOrders.nodes) {
      if (!OPEN_FO_STATUSES.has(fo.status)) continue;
      for (const li of fo.lineItems.nodes) {
        const lineId = li.lineItem?.id;
        if (!lineId) continue;
        const keys = [`id:${lineId}`, ...(li.lineItem?.variant?.id ? [`variant:${li.lineItem.variant.id}`] : []), ...(li.lineItem?.sku?.trim() ? [`sku:${li.lineItem.sku.trim().toUpperCase()}`] : [])];
        const key = keys.find((k) => (wanted.get(k) ?? 0) > 0);
        if (!key || li.remainingQuantity <= 0) continue;
        const need = wanted.get(key)!;
        const take = Math.min(need, li.remainingQuantity);
        wanted.set(key, need - take);
        (byFo.get(fo.id) ?? byFo.set(fo.id, []).get(fo.id)!).push({ id: li.id, quantity: take });
        if (store.fulfilLocationId && fo.assignedLocation?.location?.id && fo.assignedLocation.location.id !== store.fulfilLocationId) toMove.add(fo.id);
      }
    }
    const unallocated = [...wanted.entries()].filter(([, q]) => q > 0);
    return { byFo, toMove, unallocated };
  };

  let alloc = buildAllocation(ctx);
  if (alloc.toMove.size && store.fulfilLocationId) {
    for (const foId of alloc.toMove) {
      const moved = await storeGraphql<FulfillmentOrderMovePayload>(job.storeId, FULFILLMENT_ORDER_MOVE_MUTATION, { id: foId, newLocationId: store.fulfilLocationId });
      const err = firstUserError(moved.fulfillmentOrderMove);
      if (err) throw new NonRetryableJobError(`Shopify refused to move the fulfillment order to “${store.fulfilLocationName ?? store.fulfilLocationId}”: ${err}. Fulfil it from Shopify Admin or change the store's fulfilment location.`);
    }
    ctx = await fetchCtx();
    if (!ctx) throw new NonRetryableJobError("Shopify order disappeared after moving its fulfillment order");
    alloc = buildAllocation(ctx);
  }
  if (alloc.byFo.size === 0) {
    const skus = shipment.items.map((i) => `${i.quantity} × ${i.orderItem.sku}`).join(", ");
    throw new NonRetryableJobError(`Nothing left to fulfil in Shopify for the shipment of V3PL order ${shipment.order.orderNumber} (${skus}) — the order was already fulfilled in Shopify or its lines changed. Check the Shopify order.`);
  }

  const sentTracking = trackingInput(shipment);
  const created = await storeGraphql<FulfillmentCreatePayload>(job.storeId, FULFILLMENT_CREATE_MUTATION, {
    fulfillment: {
      lineItemsByFulfillmentOrder: [...alloc.byFo.entries()].map(([fulfillmentOrderId, items]) => ({ fulfillmentOrderId, fulfillmentOrderLineItems: items })),
      trackingInfo: sentTracking,
      notifyCustomer: true,
    },
  });
  const err = firstUserError(created.fulfillmentCreate);
  if (err || !created.fulfillmentCreate.fulfillment) {
    const msg = err ?? "Shopify returned no fulfillment";
    if (/already|fulfilled|remaining|quantity/i.test(msg)) throw new NonRetryableJobError(`Shopify refused the fulfillment for V3PL order ${shipment.order.orderNumber}: ${msg}`);
    throw new Error(`fulfillmentCreate: ${msg}`);
  }
  const shopifyFulfillmentId = created.fulfillmentCreate.fulfillment.id;
  await linkFulfillment(job.storeId, shipment.fulfillment.id, shopifyFulfillmentId, job);

  const partial = alloc.unallocated.length > 0;
  const lines = [...alloc.byFo.values()].flat().reduce((s, i) => s + i.quantity, 0);
  await logSync({
    storeId: job.storeId,
    direction: "OUTBOUND",
    entityType: "FULFILLMENT",
    operation: "fulfillment_create",
    status: partial ? "NEEDS_ATTENTION" : "SUCCESS",
    message: `Shipment for V3PL order ${shipment.order.orderNumber} sent to Shopify as fulfillment ${shopifyFulfillmentId.split("/").pop()} (${lines} unit${lines === 1 ? "" : "s"}${shipment.trackingNumber ? `, ${shipment.carrier ?? "carrier"} ${shipment.trackingNumber}` : ", no tracking"})${partial ? ` — ${alloc.unallocated.length} line(s) had no remaining quantity in Shopify` : ""}`,
    internalId: shipment.id,
    externalId: shopifyFulfillmentId,
    orderId: shipment.order.id,
    newValue: shipment.trackingNumber ?? null,
  });
  return { message: "Fulfillment created", result: { shopifyFulfillmentId, sentTracking: asSent(sentTracking) } };
}

/** TRACKING_UPDATE runner (targetId = V3PL shipment id). */
export async function runTrackingUpdateJob(job: ShopifyOutboundJob): Promise<JobRunResult> {
  const shipment = await loadShipment(job.targetId);
  if (!shipment) throw new NonRetryableJobError("Shipment no longer exists.");
  if (shipment.fulfillment.type === "EXTERNAL") return { message: "Mirrored from Shopify — tracking is owned by Shopify" };
  const createJob = await prisma.shopifyOutboundJob.findUnique({ where: { dedupeKey: `fulfillment:${shipment.id}` }, select: { status: true, result: true } });
  if (!shipment.fulfillment.shopifyFulfillmentId) {
    // Tracking edited before the fulfilment push ran: the FULFILLMENT_CREATE job reads the shipment
    // when it runs and carries the current tracking, so there is nothing separate to send.
    if (createJob && (createJob.status === "PENDING" || createJob.status === "RUNNING" || createJob.status === "FAILED")) return { message: "Fulfilment push still pending — tracking goes with it" };
    throw new NonRetryableJobError(`Tracking for V3PL order ${shipment.order.orderNumber} cannot be sent: the shipment is not linked to a Shopify fulfillment (push the fulfilment first).`);
  }
  const input = trackingInput(shipment);
  if (!input) return { message: "No tracking to send" };
  // Skip when Shopify already has exactly this tracking from us (the push ran after the edit, or a replay):
  // avoids a redundant mutation and a second shipping-update e-mail to the customer.
  const own = asSent((job.result as { sentTracking?: SentTracking | null } | null)?.sentTracking);
  const fromPush = asSent((createJob?.result as { sentTracking?: SentTracking | null } | null)?.sentTracking);
  const lastSent = own ?? fromPush;
  if (sameTracking(lastSent, asSent(input))) return { message: "Tracking already sent to Shopify — nothing to update", result: { sentTracking: asSent(input) } };
  const r = await storeGraphql<FulfillmentTrackingUpdatePayload>(job.storeId, FULFILLMENT_TRACKING_UPDATE_MUTATION, { fulfillmentId: shipment.fulfillment.shopifyFulfillmentId, trackingInfoInput: input, notifyCustomer: true });
  const err = firstUserError(r.fulfillmentTrackingInfoUpdate);
  if (err) throw new Error(`fulfillmentTrackingInfoUpdate: ${err}`);
  await logSync({ storeId: job.storeId, direction: "OUTBOUND", entityType: "FULFILLMENT", operation: "tracking_update", status: "SUCCESS", message: `Tracking for V3PL order ${shipment.order.orderNumber} sent to Shopify: ${shipment.carrier ?? "carrier"} ${shipment.trackingNumber ?? ""}`.trim(), internalId: shipment.id, externalId: shipment.fulfillment.shopifyFulfillmentId, orderId: shipment.order.id, newValue: shipment.trackingNumber ?? null });
  return { message: "Tracking updated", result: { sentTracking: asSent(input) } };
}
