import { NextResponse, type NextRequest } from "next/server";
import { isPortalRole, isStaffRole } from "@/lib/roles";
import { REPORT_TYPES, reportQuerySchema, scopeFromQuery, type ReportType } from "@/lib/validation/reports";
import { exportFiltersSchema } from "@/lib/validation/orders";
import { getCurrentUser } from "@/server/auth/current-user";
import { exportOrdersCsv } from "@/server/services/order-csv";
import { inventorySnapshotCsv, returnsCsv, returnsReport, shipmentsCsv, shipmentsReport, skuActivityCsv, skuActivityReport } from "@/server/services/reports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/reports/:report?from&to&warehouseId[&ownerId][&status][&q] → CSV.
 * Staff may filter by owner; portal users are ALWAYS scoped to their own owner and any
 * ownerId parameter is ignored. The "orders" report reuses the Shopify-compatible order export.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ report: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const { report } = await ctx.params;
  if (!(REPORT_TYPES as readonly string[]).includes(report)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const parsed = reportQuerySchema.safeParse({ ...Object.fromEntries(req.nextUrl.searchParams.entries()), report });
  if (!parsed.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const q = parsed.data;
  const staff = isStaffRole(user.role);
  if (!staff && !(isPortalRole(user.role) && user.ownerId)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const ownerId = staff ? q.ownerId || undefined : user.ownerId!;
  const includeOwner = staff && !ownerId;
  const scope = scopeFromQuery(q, ownerId);

  let csv: string;
  const type = report as ReportType;
  if (type === "activity") csv = skuActivityCsv(await skuActivityReport(scope), includeOwner);
  else if (type === "shipments") csv = shipmentsCsv((await shipmentsReport({ ...scope, status: q.status, q: q.q, page: 1, pageSize: 5000 })).items, includeOwner);
  else if (type === "returns") csv = returnsCsv((await returnsReport({ ...scope, status: (q.status as "RECEIVED" | "INSPECTED" | "ALL" | undefined) ?? "ALL", page: 1, pageSize: 5000 })).items, includeOwner);
  else if (type === "inventory") csv = await inventorySnapshotCsv(scope, includeOwner);
  else {
    const filters = exportFiltersSchema.parse({ status: "ALL", fulfillmentStatus: "ALL", shipmentStatus: "ALL", source: "ALL", warehouseId: q.warehouseId, from: q.from, to: q.to, ownerId: staff ? q.ownerId : undefined });
    csv = (await exportOrdersCsv({ ...filters, scopeOwnerId: staff ? undefined : ownerId })).csv;
  }
  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(csv, {
    status: 200,
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="v3pl-${type}-${stamp}.csv"`, "Cache-Control": "no-store" },
  });
}
