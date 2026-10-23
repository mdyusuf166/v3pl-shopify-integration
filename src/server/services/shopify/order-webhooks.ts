import { syncShopifyOrder, type SyncCause } from "./orders-in";
import type { WebhookContext, WebhookHandler, WebhookHandlerResult } from "./webhooks";

/**
 * Step 3 webhook handlers. Payloads are hints: each handler extracts the Shopify order id and
 * hands over to syncShopifyOrder(), which re-fetches the order and applies the core contracts.
 * The Shopify event id (falling back to the webhook id) is the idempotency key for core writes.
 */

function orderIdFromPayload(topic: SyncCause, payload: Record<string, unknown>): string | null {
  if (topic === "orders/edited") {
    const edit = payload.order_edit as { order_id?: number | string } | undefined;
    return edit?.order_id != null ? String(edit.order_id) : null;
  }
  if (topic === "refunds/create") return payload.order_id != null ? String(payload.order_id) : null;
  const gid = payload.admin_graphql_api_id;
  if (typeof gid === "string" && gid.includes("/Order/")) return gid;
  return payload.id != null ? String(payload.id) : null;
}

function handlerFor(topic: SyncCause): WebhookHandler {
  return async (ctx: WebhookContext): Promise<WebhookHandlerResult> => {
    const orderId = orderIdFromPayload(topic, ctx.payload);
    if (!orderId) throw new Error(`${topic} payload carries no order id`);
    const outcome = await syncShopifyOrder(ctx.storeId, orderId, { cause: topic, eventId: ctx.event.eventId ?? ctx.event.webhookId, webhookEventId: ctx.event.id });
    return { message: outcome.message, skipped: outcome.stale ? "STALE" : undefined };
  };
}

export const orderWebhookHandlers: Record<string, WebhookHandler> = {
  "orders/create": handlerFor("orders/create"),
  "orders/updated": handlerFor("orders/updated"),
  "orders/edited": handlerFor("orders/edited"),
  "orders/cancelled": handlerFor("orders/cancelled"),
  "refunds/create": handlerFor("refunds/create"),
};
