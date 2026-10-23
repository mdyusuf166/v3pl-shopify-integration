import type { NextRequest } from "next/server";
import { handleShopifyWebhookRequest } from "@/server/services/shopify/webhook-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/webhooks/shopify/compliance — mandatory privacy topics for public apps:
 * customers/data_request, customers/redact, shop/redact. Invalid HMAC → 401 (required by Shopify).
 */
export async function POST(req: NextRequest) {
  return handleShopifyWebhookRequest(req);
}
