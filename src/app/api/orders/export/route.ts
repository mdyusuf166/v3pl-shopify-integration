import { NextResponse, type NextRequest } from "next/server";
import { exportFiltersSchema } from "@/lib/validation/orders";
import { getCurrentUser } from "@/server/auth/current-user";
import { isPortalRole, isStaffRole } from "@/lib/roles";
import { exportOrdersCsv } from "@/server/services/order-csv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/orders/export?status=…&from=…  → Shopify-compatible order CSV.
 * Staff: any filter. Portal users: always scoped to their own owner (lines + orders).
 */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const params = Object.fromEntries(req.nextUrl.searchParams.entries());
  const parsed = exportFiltersSchema.safeParse(params);
  if (!parsed.success) return NextResponse.json({ error: "bad_request", issues: parsed.error.issues.map((i) => i.message) }, { status: 400 });
  const scopeOwnerId = isPortalRole(user.role) ? user.ownerId ?? undefined : undefined;
  if (!isStaffRole(user.role) && !scopeOwnerId) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { csv, orders } = await exportOrdersCsv({ ...parsed.data, ...(scopeOwnerId ? { ownerId: undefined, scopeOwnerId } : {}) });
  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="v3pl-orders-${stamp}.csv"`,
      "X-Order-Count": String(orders),
      "Cache-Control": "no-store",
    },
  });
}
