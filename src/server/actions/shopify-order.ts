"use server";

import { revalidatePath } from "next/cache";
import { requireRole, requireStaff } from "@/server/auth/guards";
import { ShopifyOrderRequestError, requestShopifyOrder, resolveShopifyStoreForVariants, type OutboundState, type StoreResolution } from "@/server/services/shopify-order-request";
import { scheduleAfterResponse } from "@/server/services/shopify/maintenance";
import { fail, ok, type ActionResult } from "@/server/actions/action-result";

/**
 * Manual order → Shopify (core side, D-061). Store resolution is always server-side from the variant
 * mappings; the browser never names a store.
 */

function handleError(err: unknown): ActionResult<never> {
  if (err instanceof ShopifyOrderRequestError) return fail(err.message);
  console.error("[shopify-order action]", err);
  return fail("Something went wrong. Please try again.");
}

export type StoreHint = { ok: true; storeName: string } | { ok: false; code: Extract<StoreResolution, { ok: false }>["code"]; message: string };

/** Order form hint: can the picked SKUs go to one connected Shopify store? Staff only; never creates anything. */
export async function checkShopifyStoreForVariantsAction(variantIds: string[]): Promise<ActionResult<StoreHint>> {
  await requireStaff();
  try {
    const res = await resolveShopifyStoreForVariants(variantIds.filter(Boolean).slice(0, 500));
    return ok(res.ok ? { ok: true, storeName: res.storeName } : { ok: false, code: res.code, message: res.message });
  } catch (err) {
    return handleError(err);
  }
}

/** Queue the order for creation in its resolved store (idempotent: repeats reuse the same job). */
export async function requestShopifyOrderAction(orderId: string): Promise<ActionResult<{ jobId: string; state: OutboundState; reused: boolean; storeName: string }>> {
  const actor = await requireRole("ADMIN", "SALES");
  try {
    const r = await requestShopifyOrder(orderId, actor.id);
    // Shopify session wiring (D-062): run the queued ORDER_CREATE job right after this response; drain/cron are the fallback.
    if (r.state === "PENDING") scheduleAfterResponse(r.storeId);
    revalidatePath(`/admin/orders/${orderId}`);
    revalidatePath("/admin/orders");
    return ok({ jobId: r.jobId, state: r.state, reused: r.reused, storeName: r.storeName });
  } catch (err) {
    return handleError(err);
  }
}
