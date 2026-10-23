import { prisma } from "@/lib/prisma";
import { syncProduct } from "./catalog";
import { logSync } from "./sync-log";
import type { WebhookContext, WebhookHandlerResult } from "./webhooks";

/**
 * products/update (Step 2): refresh the snapshots of that one product's variants from the
 * Admin API (the payload is a hint only), then re-match the store's mappings by SKU.
 * Never reads inventory quantities, never creates V3PL products.
 */
export async function handleProductsUpdate(ctx: WebhookContext): Promise<WebhookHandlerResult> {
  const raw = ctx.payload.admin_graphql_api_id;
  const numeric = ctx.payload.id;
  const gid = typeof raw === "string" && raw.startsWith("gid://") ? raw : numeric !== undefined && numeric !== null ? `gid://shopify/Product/${String(numeric)}` : null;
  if (!gid) throw new Error("products/update payload carries no product id");

  const store = await prisma.shopifyStore.findUnique({ where: { id: ctx.storeId }, select: { status: true } });
  if (!store || store.status !== "CONNECTED") return { message: "Store not connected — skipped" };

  const r = await syncProduct(ctx.storeId, gid);
  const title = typeof ctx.payload.title === "string" ? ctx.payload.title : gid.split("/").pop();
  const message = r
    ? `Product “${title}” updated in Shopify: ${r.variants} variant${r.variants === 1 ? "" : "s"} refreshed${r.removed ? `, ${r.removed} removed` : ""} — store now ${r.summary.MATCHED} matched / ${r.summary.UNMATCHED} unmatched / ${r.summary.CONFLICT} conflicts`
    : `Product “${title}” no longer exists in Shopify; its automatic mappings were removed`;
  await logSync({ storeId: ctx.storeId, direction: "INBOUND", entityType: "PRODUCT", operation: "products/update", status: "SUCCESS", message, externalId: gid, webhookEventId: ctx.event.id });
  return { message };
}
