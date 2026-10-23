import { NextResponse, type NextRequest } from "next/server";
import { authorizeApi } from "@/server/auth/guards";
import { unmatchedCsv } from "@/server/services/shopify/mapping";
import { getStore } from "@/server/services/shopify/stores";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/shopify/stores/:id/unmatched — CSV of Shopify variants without a V3PL SKU (Admin only). */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authorizeApi("ADMIN");
  if (auth.error) return auth.error;
  const { id } = await ctx.params;
  const store = await getStore(id);
  if (!store) return NextResponse.json({ error: "not found" }, { status: 404 });
  const csv = await unmatchedCsv(id);
  const fileName = `${store.shopDomain.replace(/\.myshopify\.com$/, "")}-unmatched-${new Date().toISOString().slice(0, 10)}.csv`;
  return new NextResponse(csv, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${fileName}"`, "Cache-Control": "no-store" },
  });
}
