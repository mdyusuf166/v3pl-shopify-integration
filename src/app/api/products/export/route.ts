import { NextResponse, type NextRequest } from "next/server";
import { productExportFiltersSchema } from "@/lib/validation/products";
import { getCurrentUser } from "@/server/auth/current-user";
import { isPortalRole, isStaffRole } from "@/lib/roles";
import { exportProductsCsv } from "@/server/services/product-csv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/products/export?ownerId=…&status=…&q=… → Shopify-compatible product CSV (D-053).
 * Staff: any filter. Portal users: always scoped to their own owner.
 */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const params = Object.fromEntries(req.nextUrl.searchParams.entries());
  const parsed = productExportFiltersSchema.safeParse(params);
  if (!parsed.success) return NextResponse.json({ error: "bad_request", issues: parsed.error.issues.map((i) => i.message) }, { status: 400 });
  const scopeOwnerId = isPortalRole(user.role) ? user.ownerId ?? undefined : undefined;
  if (!isStaffRole(user.role) && !scopeOwnerId) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { csv, products } = await exportProductsCsv({ ...parsed.data, ...(scopeOwnerId ? { ownerId: undefined, scopeOwnerId } : {}) });
  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="v3pl-products-${stamp}.csv"`,
      "X-Product-Count": String(products),
      "Cache-Control": "no-store",
    },
  });
}
