import { after, NextResponse, type NextRequest } from "next/server";
import { drainPending } from "./maintenance";
import { describeError } from "./sync-log";
import { processWebhookEvent, receiveWebhook } from "./webhooks";

/**
 * Shared Route Handler body for /api/webhooks/shopify and /api/webhooks/shopify/compliance.
 * Responds inside Shopify's 5-second budget, then processes with `after()` (D-025/D-031).
 */
export async function handleShopifyWebhookRequest(req: NextRequest): Promise<NextResponse> {
  const raw = await req.text();
  const result = await receiveWebhook(raw, req.headers);
  if (result.status !== 200) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  if (result.eventId && !result.duplicate) {
    const { eventId, storeId } = result;
    after(async () => {
      try {
        await processWebhookEvent(eventId);
        await drainPending(storeId, 15_000);
      } catch (err) {
        console.error("[shopify webhook] post-response processing failed:", describeError(err));
      }
    });
  }
  return new NextResponse(null, { status: 200 });
}
