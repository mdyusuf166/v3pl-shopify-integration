import type { Prisma, ShopifyWebhookEvent, ShopifyWebhookEventStatus } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { handleProductsUpdate } from "./catalog-webhook";
import { normalizeShopDomain, verifyWebhookHmac } from "./crypto";
import { isShopifyConfigured, shopifyEnv } from "./env";
import { effectiveCredentials } from "./oauth";
import { fulfillmentWebhookHandlers } from "./fulfillment-in";
import { orderWebhookHandlers } from "./order-webhooks";
import { markUninstalled } from "./stores";
import { describeError, logSync } from "./sync-log";

/**
 * Webhook pipeline (D-025, shopify-integration.md §7.2):
 *   verify HMAC → record ShopifyWebhookEvent (webhookId UNIQUE) → 200 → process → PROCESSED/FAILED
 * Payloads are notifications; handlers re-fetch what they need from the Admin API.
 */

export type WebhookHeaders = {
  hmac: string | null;
  shopDomain: string | null;
  topic: string | null;
  webhookId: string | null;
  eventId: string | null;
  apiVersion: string | null;
  triggeredAt: string | null;
};

export function readWebhookHeaders(h: Headers): WebhookHeaders {
  return {
    hmac: h.get("x-shopify-hmac-sha256"),
    shopDomain: h.get("x-shopify-shop-domain"),
    topic: h.get("x-shopify-topic"),
    webhookId: h.get("x-shopify-webhook-id"),
    eventId: h.get("x-shopify-event-id"),
    apiVersion: h.get("x-shopify-api-version"),
    triggeredAt: h.get("x-shopify-triggered-at"),
  };
}

export type ReceiveResult =
  | { status: 200; eventId: string | null; storeId: string | null; duplicate: boolean }
  | { status: 400 | 401; error: string };

/**
 * Verifies and records one delivery. Never throws on bad input: returns the HTTP status to
 * send. Unknown shops are recorded as IGNORED (still 200 — Shopify must not keep retrying).
 */
export async function receiveWebhook(rawBody: string, headers: Headers): Promise<ReceiveResult> {
  const h = readWebhookHeaders(headers);
  if (!h.topic || !h.webhookId || !h.shopDomain) return { status: 400, error: "Missing Shopify webhook headers" };
  if (!isShopifyConfigured()) return { status: 401, error: "Shopify integration is not configured" };

  const shopDomain = normalizeShopDomain(h.shopDomain) ?? h.shopDomain.trim().toLowerCase();
  const store = await prisma.shopifyStore.findUnique({
    where: { shopDomain },
    select: { id: true, status: true, clientIdOverride: true, encClientSecretOverride: true },
  });
  const secret = store ? effectiveCredentials(store).clientSecret : shopifyEnv().SHOPIFY_API_SECRET;
  if (!verifyWebhookHmac(rawBody, h.hmac, secret)) return { status: 401, error: "Invalid webhook signature" };

  let payload: unknown = {};
  if (rawBody.trim()) {
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return { status: 400, error: "Body is not JSON" };
    }
  }
  const triggeredAt = h.triggeredAt && !Number.isNaN(Date.parse(h.triggeredAt)) ? new Date(h.triggeredAt) : null;

  try {
    const ev = await prisma.shopifyWebhookEvent.create({
      data: {
        storeId: store?.id ?? null,
        shopDomain,
        webhookId: h.webhookId,
        eventId: h.eventId,
        topic: h.topic,
        apiVersion: h.apiVersion,
        triggeredAt,
        status: store ? "RECEIVED" : "IGNORED",
        error: store ? null : "No V3PL store is connected for this shop domain",
        payload: payload as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    if (store) await prisma.shopifyStore.update({ where: { id: store.id }, data: { lastWebhookAt: new Date() } });
    return { status: 200, eventId: store ? ev.id : null, storeId: store?.id ?? null, duplicate: false };
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") return { status: 200, eventId: null, storeId: store?.id ?? null, duplicate: true };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Processing
// ---------------------------------------------------------------------------

export type WebhookContext = { event: ShopifyWebhookEvent; storeId: string; payload: Record<string, unknown> };
export type WebhookHandlerResult = { skipped?: "STALE"; message?: string } | void;
export type WebhookHandler = (ctx: WebhookContext) => Promise<WebhookHandlerResult>;

const HANDLERS: Record<string, WebhookHandler> = {
  "app/uninstalled": handleAppUninstalled,
  "products/update": handleProductsUpdate,
  ...orderWebhookHandlers,
  ...fulfillmentWebhookHandlers,
  "customers/data_request": complianceHandler("Customer data request"),
  "customers/redact": complianceHandler("Customer data erasure request"),
  "shop/redact": complianceHandler("Shop data erasure request"),
};

/** Later steps (orders, fulfillments, products) add their topics here. */
export function registerWebhookHandler(topic: string, handler: WebhookHandler): void {
  HANDLERS[topic] = handler;
}

export function handledTopics(): string[] {
  return Object.keys(HANDLERS);
}

export const MAX_WEBHOOK_ATTEMPTS = 5;
const STALE_LOCK_MS = 15 * 60_000;

/** 4, 8, 16, 32, 64 minutes … capped at 6 hours. */
export function computeBackoff(attempts: number, now = Date.now()): Date {
  const minutes = Math.min(2 ** Math.max(1, attempts) * 2, 360);
  return new Date(now + minutes * 60_000);
}

/**
 * Claims and processes one recorded event. Safe to call concurrently and repeatedly:
 * the claim is an atomic status transition, handlers are idempotent by contract.
 */
export async function processWebhookEvent(id: string): Promise<ShopifyWebhookEventStatus | null> {
  const claimed = await prisma.shopifyWebhookEvent.updateMany({
    where: { id, status: { in: ["RECEIVED", "FAILED"] } },
    data: { status: "PROCESSING", lockedAt: new Date(), attempts: { increment: 1 } },
  });
  if (claimed.count === 0) return null;
  const event = await prisma.shopifyWebhookEvent.findUniqueOrThrow({ where: { id } });

  if (!event.storeId) {
    await prisma.shopifyWebhookEvent.update({ where: { id }, data: { status: "IGNORED", lockedAt: null, error: "No store" } });
    return "IGNORED";
  }
  const handler = HANDLERS[event.topic];
  if (!handler) {
    await prisma.shopifyWebhookEvent.update({ where: { id }, data: { status: "IGNORED", lockedAt: null, processedAt: new Date(), error: `No handler for topic "${event.topic}" yet` } });
    return "IGNORED";
  }

  try {
    const payload = (event.payload && typeof event.payload === "object" ? event.payload : {}) as Record<string, unknown>;
    const result = await handler({ event, storeId: event.storeId, payload });
    const status: ShopifyWebhookEventStatus = result?.skipped === "STALE" ? "SKIPPED_STALE" : "PROCESSED";
    await prisma.shopifyWebhookEvent.update({ where: { id }, data: { status, lockedAt: null, processedAt: new Date(), error: null, nextRetryAt: null } });
    return status;
  } catch (err) {
    const detail = describeError(err);
    const exhausted = event.attempts >= MAX_WEBHOOK_ATTEMPTS;
    await prisma.shopifyWebhookEvent.update({
      where: { id },
      data: { status: "FAILED", lockedAt: null, error: detail, nextRetryAt: exhausted ? null : computeBackoff(event.attempts) },
    });
    await logSync({
      storeId: event.storeId,
      direction: "INBOUND",
      entityType: "WEBHOOK",
      operation: event.topic,
      status: exhausted ? "NEEDS_ATTENTION" : "FAILED",
      message: exhausted
        ? `Webhook ${event.topic} failed ${event.attempts} times and needs attention`
        : `Webhook ${event.topic} failed (attempt ${event.attempts}) — will retry automatically`,
      errorDetail: detail,
      externalId: event.webhookId,
      webhookEventId: event.id,
      retryCount: event.attempts,
    });
    return "FAILED";
  }
}

/**
 * Retry sweep (piggyback + daily cron): due FAILED events, RECEIVED events that were never
 * processed (e.g. the function died after responding), and stale PROCESSING locks.
 */
export async function retryDueWebhookEvents(opts: { storeId?: string; limit?: number; deadline?: number } = {}): Promise<number> {
  const now = new Date();
  await prisma.shopifyWebhookEvent.updateMany({
    where: { status: "PROCESSING", lockedAt: { lt: new Date(now.getTime() - STALE_LOCK_MS) }, ...(opts.storeId ? { storeId: opts.storeId } : {}) },
    data: { status: "FAILED", lockedAt: null, error: "Processing was interrupted", nextRetryAt: now },
  });
  const due = await prisma.shopifyWebhookEvent.findMany({
    where: {
      storeId: opts.storeId ?? { not: null },
      OR: [{ status: "FAILED", nextRetryAt: { lte: now } }, { status: "RECEIVED", receivedAt: { lte: new Date(now.getTime() - 2 * 60_000) } }],
    },
    orderBy: { receivedAt: "asc" },
    take: opts.limit ?? 50,
    select: { id: true },
  });
  let processed = 0;
  for (const e of due) {
    if (opts.deadline && Date.now() > opts.deadline) break;
    await processWebhookEvent(e.id);
    processed++;
  }
  return processed;
}

/** Admin “Retry” on a failed event (also works after the automatic attempts are exhausted). */
export async function retryWebhookEventNow(id: string): Promise<ShopifyWebhookEventStatus | null> {
  await prisma.shopifyWebhookEvent.updateMany({ where: { id, status: { in: ["FAILED", "IGNORED", "SKIPPED_STALE"] } }, data: { status: "FAILED", nextRetryAt: null } });
  return processWebhookEvent(id);
}

export const WEBHOOK_PAGE_SIZE = 50;

export async function listWebhookEvents(params: { storeId?: string; status?: ShopifyWebhookEventStatus; topic?: string; page?: number; pageSize?: number }) {
  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.min(200, params.pageSize ?? WEBHOOK_PAGE_SIZE);
  const where: Prisma.ShopifyWebhookEventWhereInput = { storeId: params.storeId, status: params.status, topic: params.topic };
  const [total, rows] = await Promise.all([
    prisma.shopifyWebhookEvent.count({ where }),
    prisma.shopifyWebhookEvent.findMany({
      where,
      orderBy: { receivedAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: { id: true, storeId: true, shopDomain: true, webhookId: true, eventId: true, topic: true, apiVersion: true, triggeredAt: true, receivedAt: true, status: true, attempts: true, nextRetryAt: true, processedAt: true, error: true },
    }),
  ]);
  return { rows, total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) };
}

// ---------------------------------------------------------------------------
// Step 1 handlers
// ---------------------------------------------------------------------------

async function handleAppUninstalled(ctx: WebhookContext): Promise<WebhookHandlerResult> {
  await prisma.$transaction(async (tx) => {
    await markUninstalled(ctx.storeId, tx);
    await logSync(
      {
        storeId: ctx.storeId,
        direction: "INBOUND",
        entityType: "STORE",
        operation: "app/uninstalled",
        status: "NEEDS_ATTENTION",
        message: "The V3PL app was uninstalled from this Shopify store. Orders and inventory are no longer synchronised. Reconnect from V3PL if this was unintended.",
        webhookEventId: ctx.event.id,
      },
      tx,
    );
  });
}

/**
 * Mandatory compliance topics (public apps). Step 1 acknowledges, records and surfaces them
 * for manual handling within Shopify's 30-day window; customer data on orders is core-owned.
 */
function complianceHandler(label: string): WebhookHandler {
  return async (ctx) => {
    const customer = ctx.payload.customer as { id?: number | string; email?: string } | undefined;
    await logSync({
      storeId: ctx.storeId,
      direction: "INBOUND",
      entityType: "STORE",
      operation: ctx.event.topic,
      status: "NEEDS_ATTENTION",
      message: `${label} received from Shopify — must be completed within 30 days (see docs/shopify-integration.md §7.1).`,
      externalId: customer?.id != null ? String(customer.id) : (typeof ctx.payload.shop_domain === "string" ? ctx.payload.shop_domain : null),
      webhookEventId: ctx.event.id,
    });
  };
}
