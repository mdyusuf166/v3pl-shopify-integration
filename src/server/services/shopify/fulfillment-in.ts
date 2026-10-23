import type { ShipmentStatus } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { recordExternalShipment, updateShipmentStatus, updateShipmentTracking } from "@/server/services/fulfillment";
import { flagAttention } from "@/server/services/orders";
import { storeGraphql } from "./api";
import { gidToId, toGid } from "./client";
import { FULFILLMENT_QUERY, type FulfillmentPayload } from "./queries";
import { logSync } from "./sync-log";
import type { WebhookContext, WebhookHandler, WebhookHandlerResult } from "./webhooks";

/**
 * Step 4 inbound: fulfillments created/updated in Shopify Admin (D-032, shopify-integration.md §12).
 * - Our own fulfillments (recognised by the recorded Shopify id) only receive status/tracking updates.
 * - Foreign fulfillments are mirrored exactly once through core `recordExternalShipment`, which
 *   consumes the reservation once (externalEventId) and never creates negative stock.
 * - Delivery status maps onto the V3PL shipment; cancellation/failure flags the order — V3PL never
 *   reverses a shipped movement automatically.
 */

/** Shopify `Fulfillment.displayStatus` → V3PL shipment status (null = leave as is). */
export function shipmentStatusFor(displayStatus: string | null | undefined, status: string): { status: ShipmentStatus | null; attention: string | null } {
  if (status === "CANCELLED" || displayStatus === "CANCELED") return { status: null, attention: "Fulfillment was cancelled in Shopify. The V3PL shipment is kept — record a Return if the goods come back." };
  switch (displayStatus) {
    case "DELIVERED":
    case "PICKED_UP":
      return { status: "DELIVERED", attention: null };
    case "IN_TRANSIT":
    case "OUT_FOR_DELIVERY":
    case "ATTEMPTED_DELIVERY":
      return { status: "IN_TRANSIT", attention: null };
    case "FAILURE":
    case "NOT_DELIVERED":
      return { status: null, attention: `Shopify reports the delivery as ${displayStatus.toLowerCase().replace(/_/g, " ")}. Check the carrier.` };
    default:
      return { status: null, attention: null };
  }
}

function fulfillmentIdFromPayload(payload: Record<string, unknown>): string | null {
  const gid = payload.admin_graphql_api_id;
  if (typeof gid === "string" && gid.includes("/Fulfillment/")) return gid;
  return payload.id != null ? toGid("Fulfillment", String(payload.id)) : null;
}

async function handleFulfillment(ctx: WebhookContext, topic: "fulfillments/create" | "fulfillments/update"): Promise<WebhookHandlerResult> {
  const gid = fulfillmentIdFromPayload(ctx.payload);
  if (!gid) throw new Error(`${topic} payload carries no fulfillment id`);
  const eventId = ctx.event.eventId ?? ctx.event.webhookId;
  const store = await prisma.shopifyStore.findUnique({ where: { id: ctx.storeId }, select: { status: true, warehouses: { orderBy: { priority: "asc" }, take: 1, select: { warehouseId: true } } } });
  if (!store || store.status !== "CONNECTED") return { message: "Store not connected — skipped" };

  const f = (await storeGraphql<FulfillmentPayload>(ctx.storeId, FULFILLMENT_QUERY, { id: gid })).fulfillment;
  if (!f) {
    await logSync({ storeId: ctx.storeId, direction: "INBOUND", entityType: "FULFILLMENT", operation: topic, status: "SKIPPED", message: `Shopify fulfillment ${gidToId(gid)} no longer exists`, externalId: gid, webhookEventId: ctx.event.id });
    return { message: "Fulfillment not found" };
  }
  const tracking = f.trackingInfo[0] ?? null;
  const mapped = shipmentStatusFor(f.displayStatus, f.status);

  const known = await prisma.fulfillment.findUnique({ where: { shopifyStoreId_shopifyFulfillmentId: { shopifyStoreId: ctx.storeId, shopifyFulfillmentId: f.id } }, select: { id: true, type: true, orderId: true, shipment: { select: { id: true, status: true, trackingNumber: true, carrier: true, trackingUrl: true } } } });
  if (known) {
    const changes: string[] = [];
    if (known.shipment) {
      if (tracking && (tracking.number ?? null) !== known.shipment.trackingNumber && known.type === "EXTERNAL") {
        await updateShipmentTracking(known.shipment.id, { carrier: tracking.company ?? null, trackingNumber: tracking.number ?? null, trackingUrl: tracking.url ?? null }, null, `${eventId}:tracking`);
        changes.push(`tracking ${tracking.company ?? ""} ${tracking.number ?? ""}`.trim());
      }
      if (mapped.status && mapped.status !== known.shipment.status) {
        await updateShipmentStatus(known.shipment.id, mapped.status, null, `${eventId}:status`);
        changes.push(`status → ${mapped.status.toLowerCase().replace("_", " ")}`);
      }
    }
    if (mapped.attention) await flagAttention(known.orderId, mapped.attention, null);
    const message = `Shopify fulfillment ${gidToId(f.id)} updated${changes.length ? `: ${changes.join(", ")}` : " (no change for V3PL)"}${mapped.attention ? `. Attention: ${mapped.attention}` : ""}`;
    if (changes.length || mapped.attention) await logSync({ storeId: ctx.storeId, direction: "INBOUND", entityType: "FULFILLMENT", operation: topic, status: mapped.attention ? "NEEDS_ATTENTION" : "SUCCESS", message, externalId: f.id, internalId: known.shipment?.id ?? known.id, orderId: known.orderId, webhookEventId: ctx.event.id });
    return { message };
  }

  // Foreign fulfillment (created in Shopify Admin or by another app): mirror it once.
  if (f.status === "CANCELLED") return { message: "Cancelled fulfillment never mirrored — nothing to do" };
  const shopifyOrderId = f.order ? gidToId(f.order.id) : null;
  const order = shopifyOrderId ? await prisma.order.findUnique({ where: { shopifyStoreId_shopifyOrderId: { shopifyStoreId: ctx.storeId, shopifyOrderId } }, select: { id: true, orderNumber: true, items: { select: { id: true, sku: true, shopifyLineItemId: true } } } }) : null;
  if (!order) {
    await logSync({ storeId: ctx.storeId, direction: "INBOUND", entityType: "FULFILLMENT", operation: topic, status: "SKIPPED", message: `Fulfillment ${gidToId(f.id)} belongs to Shopify order ${shopifyOrderId ?? "?"} which is not imported in V3PL — nothing mirrored`, externalId: f.id, webhookEventId: ctx.event.id });
    return { message: "Order not in V3PL" };
  }
  const byLine = new Map(order.items.filter((i) => i.shopifyLineItemId).map((i) => [i.shopifyLineItemId!, i]));
  const lines = f.fulfillmentLineItems.nodes.map((n) => ({ item: n.lineItem ? byLine.get(n.lineItem.id) : undefined, quantity: n.quantity })).filter((x): x is { item: NonNullable<typeof x.item>; quantity: number } => !!x.item && x.quantity > 0);
  if (lines.length === 0) {
    await logSync({ storeId: ctx.storeId, direction: "INBOUND", entityType: "FULFILLMENT", operation: topic, status: "SKIPPED", message: `Fulfillment ${gidToId(f.id)} for V3PL order ${order.orderNumber} contains no warehouse lines (non-shipping items) — nothing mirrored`, externalId: f.id, orderId: order.id, webhookEventId: ctx.event.id });
    return { message: "No warehouse lines" };
  }
  const r = await recordExternalShipment(
    order.id,
    {
      lines: lines.map((l) => ({ orderItemId: l.item.id, quantity: l.quantity })),
      carrier: tracking?.company ?? null,
      trackingNumber: tracking?.number ?? null,
      trackingUrl: tracking?.url ?? null,
      shippedAt: new Date(f.createdAt),
      externalFulfillmentId: f.id,
      shopifyStoreId: ctx.storeId,
      externalEventId: `${eventId}:mirror`,
      warehouseId: store.warehouses[0]?.warehouseId ?? null,
    },
    null,
  );
  if (r.created && r.shipmentId && mapped.status && mapped.status !== "SHIPPED") await updateShipmentStatus(r.shipmentId, mapped.status, null, `${eventId}:status`);
  const summary = lines.map((l) => `${l.quantity} × ${l.item.sku}`).join(", ");
  const message = r.created
    ? `Fulfillment created in Shopify mirrored into V3PL order ${order.orderNumber}: ${summary}${tracking?.number ? ` (${tracking.company ?? ""} ${tracking.number})`.replace("( ", "(") : ""} — reservation consumed once`
    : `Fulfillment ${gidToId(f.id)} was already mirrored into V3PL order ${order.orderNumber}`;
  await logSync({ storeId: ctx.storeId, direction: "INBOUND", entityType: "FULFILLMENT", operation: topic, status: "SUCCESS", message, externalId: f.id, internalId: r.shipmentId ?? null, orderId: order.id, webhookEventId: ctx.event.id });
  return { message };
}

export const fulfillmentWebhookHandlers: Record<string, WebhookHandler> = {
  "fulfillments/create": (ctx) => handleFulfillment(ctx, "fulfillments/create"),
  "fulfillments/update": (ctx) => handleFulfillment(ctx, "fulfillments/update"),
};
