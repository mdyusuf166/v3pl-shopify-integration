import { NextResponse, type NextRequest } from "next/server";
import { appUrl } from "@/lib/env";
import { getCurrentUser } from "@/server/auth/current-user";
import { refreshShopMetadata } from "@/server/services/shopify/api";
import { ShopifyOAuthError, completeInstall } from "@/server/services/shopify/oauth";
import { describeError } from "@/server/services/shopify/sync-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/shopify/oauth/callback — Shopify redirects the Admin's browser here after the
 * merchant approves the scopes. Requires the V3PL admin session that started the flow
 * (defence in depth on top of the HMAC + state checks).
 */
export async function GET(req: NextRequest) {
  const base = appUrl();
  const user = await getCurrentUser();
  if (!user || user.role !== "ADMIN") {
    const next = `/api/shopify/oauth/callback?${req.nextUrl.searchParams.toString()}`;
    return NextResponse.redirect(`${base}/admin/login?next=${encodeURIComponent(next)}`);
  }
  try {
    const r = await completeInstall(req.nextUrl.searchParams, user.id);
    try {
      await refreshShopMetadata(r.storeId);
    } catch (err) {
      console.error("[shopify oauth] metadata refresh after connect failed:", describeError(err));
    }
    return NextResponse.redirect(`${base}/admin/settings/shopify/${r.storeId}?connected=${r.reconnect ? "reconnected" : "1"}`);
  } catch (err) {
    const code = err instanceof ShopifyOAuthError ? err.code : "UNKNOWN";
    console.error("[shopify oauth] callback failed:", describeError(err), err instanceof ShopifyOAuthError ? err.detail : "");
    return NextResponse.redirect(`${base}/admin/settings/shopify?error=${encodeURIComponent(code)}`);
  }
}
