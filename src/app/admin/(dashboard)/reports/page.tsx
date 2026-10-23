import type { Metadata } from "next";
import { ReportView } from "@/components/reports/report-view";
import { reportQuerySchema } from "@/lib/validation/reports";
import { requireRole } from "@/server/auth/guards";
import { listOwnerOptions } from "@/server/services/owners";
import { listWarehouses } from "@/server/services/warehouses";

export const metadata: Metadata = { title: "Reports" };

export default async function AdminReportsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireRole("ADMIN");
  const sp = await searchParams;
  const pick = (k: string) => (typeof sp[k] === "string" && sp[k] ? (sp[k] as string) : undefined);
  const parsed = reportQuerySchema.safeParse({ report: pick("report") ?? "activity", from: pick("from"), to: pick("to"), warehouseId: pick("warehouseId"), ownerId: pick("ownerId"), status: pick("status"), q: pick("q"), page: pick("page") });
  const query = parsed.success ? parsed.data : reportQuerySchema.parse({});
  const [warehouses, vendors, clients] = await Promise.all([listWarehouses(true), listOwnerOptions("VENDOR"), listOwnerOptions("THREEPL_CLIENT")]);
  return (
    <ReportView
      isStaff
      basePath="/admin/reports"
      ordersPath="/admin/orders"
      query={query}
      warehouses={warehouses}
      owners={[...vendors, ...clients]}
      title="Reports"
      description="Operational reports across all vendors and 3PL clients, or filtered to one owner. Every figure comes from the live ledger and order tables."
    />
  );
}
