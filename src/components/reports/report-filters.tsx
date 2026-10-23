import Link from "next/link";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/common/native-select";
import { REPORT_LABELS, REPORT_TYPES, type ReportQuery, type ReportType } from "@/lib/validation/reports";
import { cn } from "@/lib/utils";

type Props = {
  basePath: string;
  query: ReportQuery;
  warehouses: { id: string; code: string; name: string }[];
  /** Staff only: owner filter options. */
  owners?: { id: string; businessName: string }[];
  /** Restrict the tab set (e.g. a Shipments page shows only that report). */
  reports?: readonly ReportType[];
  showTabs?: boolean;
  csvHref: string;
};

/** GET-form filters + report tabs + CSV download. Works without JavaScript. */
export function ReportFilters({ basePath, query, warehouses, owners, reports = REPORT_TYPES, showTabs = true, csvHref }: Props) {
  const keep = (report: ReportType) => {
    const p = new URLSearchParams();
    p.set("report", report);
    if (query.from) p.set("from", query.from);
    if (query.to) p.set("to", query.to);
    if (query.warehouseId) p.set("warehouseId", query.warehouseId);
    if (query.ownerId && owners) p.set("ownerId", query.ownerId);
    return `${basePath}?${p.toString()}`;
  };
  const isTable = query.report === "shipments" || query.report === "returns";
  return (
    <div className="space-y-3">
      {showTabs && (
        <div className="flex flex-wrap gap-1" role="tablist">
          {reports.map((r) => (
            <Link key={r} href={keep(r)} role="tab" aria-selected={query.report === r} className={cn("rounded-md px-3 py-1.5 text-sm transition-colors", query.report === r ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground")}>
              {REPORT_LABELS[r].title}
            </Link>
          ))}
        </div>
      )}
      <form method="get" className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="report" value={query.report} />
        <label className="space-y-1 text-xs text-muted-foreground">
          From
          <Input type="date" name="from" defaultValue={query.from ?? ""} className="w-36" />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          To
          <Input type="date" name="to" defaultValue={query.to ?? ""} className="w-36" />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          Warehouse
          <NativeSelect name="warehouseId" defaultValue={query.warehouseId ?? ""} className="w-40">
            <option value="">All warehouses</option>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.code} · {w.name}
              </option>
            ))}
          </NativeSelect>
        </label>
        {owners && (
          <label className="space-y-1 text-xs text-muted-foreground">
            Vendor / 3PL client
            <NativeSelect name="ownerId" defaultValue={query.ownerId ?? ""} className="w-48">
              <option value="">All owners</option>
              {owners.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.businessName}
                </option>
              ))}
            </NativeSelect>
          </label>
        )}
        {isTable && (
          <label className="space-y-1 text-xs text-muted-foreground">
            Status
            <NativeSelect name="status" defaultValue={query.status ?? "ALL"} className="w-36">
              <option value="ALL">All</option>
              {query.report === "shipments" ? (
                <>
                  <option value="SHIPPED">Shipped</option>
                  <option value="IN_TRANSIT">In transit</option>
                  <option value="DELIVERED">Delivered</option>
                  <option value="RETURNED">Returned</option>
                </>
              ) : (
                <>
                  <option value="RECEIVED">Awaiting inspection</option>
                  <option value="INSPECTED">Inspected</option>
                </>
              )}
            </NativeSelect>
          </label>
        )}
        {query.report === "shipments" && (
          <label className="space-y-1 text-xs text-muted-foreground">
            Search
            <Input name="q" defaultValue={query.q ?? ""} placeholder="Tracking, carrier, order #" className="w-48" />
          </label>
        )}
        <Button type="submit" variant="secondary" size="sm">
          Apply
        </Button>
        <Button variant="outline" size="sm" className="ml-auto" render={<a href={csvHref} />}>
          <Download /> Download CSV
        </Button>
      </form>
    </div>
  );
}
