import type { Metadata } from "next";
import { ReportView } from "@/components/reports/report-view";
import { reportQuerySchema } from "@/lib/validation/reports";
import { requirePortalRole } from "@/server/auth/guards";
import { listWarehouses } from "@/server/services/warehouses";

export const metadata: Metadata = { title: "Returns" };

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requirePortalRole("THREEPL_CLIENT");
  const sp = await searchParams;
  const pick = (k: string) => (typeof sp[k] === "string" && sp[k] ? (sp[k] as string) : undefined);
  const parsed = reportQuerySchema.safeParse({ report: "returns", from: pick("from"), to: pick("to"), warehouseId: pick("warehouseId"), status: pick("status"), q: pick("q"), page: pick("page") });
  const query = parsed.success ? parsed.data : reportQuerySchema.parse({ report: "returns" });
  const warehouses = await listWarehouses();
  // Portal scope: always the session owner; any ownerId in the URL is ignored.
  return <ReportView scopeOwnerId={user.ownerId} isStaff={false} basePath="/portal/3pl/returns" ordersPath="/portal/3pl/orders" query={{ ...query, ownerId: undefined }} warehouses={warehouses} reports={["returns"]} title={"Returns"} description={"Returned units and their inspection outcome (restocked or damaged)."} />;
}
