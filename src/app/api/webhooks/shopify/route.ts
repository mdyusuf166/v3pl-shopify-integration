import type { NextRequest } from "next/server";
import "@/server/services/shopify/register";
import { handleShopifyWebhookRequest } from "@/server/services/shopify/webhook-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** POST /api/webhooks/shopify — app-specific webhook subscriptions (orders, fulfillments, products, app/uninstalled). */
export async function POST(req: NextRequest) {
  return handleShopifyWebhookRequest(req);
}
