import Link from "next/link";
import { BarChart3, PackageCheck, RotateCcw, Truck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/common/empty-state";
import { Pagination } from "@/components/common/pagination";
import { StatusBadge } from "@/components/common/status-badge";
import { PageHeader } from "@/components/layout/page-header";
import { ReportFilters } from "@/components/reports/report-filters";
import { formatDateTime, formatInt } from "@/lib/format";
import { REPORT_LABELS, REPORT_TYPES, scopeFromQuery, type ReportQuery, type ReportType } from "@/lib/validation/reports";
import { listStock } from "@/server/services/inventory";
import { ordersSummaryReport, returnsReport, shipmentsReport, skuActivityReport } from "@/server/services/reports";

type Props = {
  /** Portal: the session owner id. Admin: the optional filter value. */
  scopeOwnerId?: string;
  isStaff: boolean;
  basePath: string;
  ordersPath: string;
  query: ReportQuery;
  warehouses: { id: string; code: string; name: string }[];
  owners?: { id: string; businessName: string }[];
  reports?: readonly ReportType[];
  title?: string;
  description?: string;
};

function csvHrefFor(query: ReportQuery, isStaff: boolean) {
  const p = new URLSearchParams();
  if (query.from) p.set("from", query.from);
  if (query.to) p.set("to", query.to);
  if (query.warehouseId) p.set("warehouseId", query.warehouseId);
  if (query.status) p.set("status", query.status);
  if (query.q) p.set("q", query.q);
  if (isStaff && query.ownerId) p.set("ownerId", query.ownerId);
  const s = p.toString();
  return `/api/reports/${query.report}${s ? `?${s}` : ""}`;
}

/** Shared report screen for admin (/admin/reports) and portals (/portal/x/reports, /shipments, /returns). */
export async function ReportView({ scopeOwnerId, isStaff, basePath, ordersPath, query, warehouses, owners, reports = REPORT_TYPES, title, description }: Props) {
  const ownerId = isStaff ? query.ownerId || undefined : scopeOwnerId;
  const scope = scopeFromQuery(query, ownerId);
  const meta = REPORT_LABELS[query.report];
  const hrefFor = (page: number) => {
    const p = new URLSearchParams();
    p.set("report", query.report);
    for (const [k, v] of Object.entries({ from: query.from, to: query.to, warehouseId: query.warehouseId, status: query.status, q: query.q, ownerId: isStaff ? query.ownerId : undefined })) if (v) p.set(k, v);
    if (page > 1) p.set("page", String(page));
    return `${basePath}?${p.toString()}`;
  };
  const periodLabel = query.from || query.to ? `${query.from ?? "start"} → ${query.to ?? "today"}` : "all time";

  return (
    <>
      <PageHeader title={title ?? "Reports"} description={description ?? "Operational reports from live data. Filter by period and warehouse, then download as CSV."} />
      <ReportFilters basePath={basePath} query={query} warehouses={warehouses} owners={owners} reports={reports} showTabs={reports.length > 1} csvHref={csvHrefFor(query, isStaff)} />
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <BarChart3 className="size-4 text-muted-foreground" /> {meta.title}
            <Badge variant="outline">{periodLabel}</Badge>
          </CardTitle>
          <CardDescription>{meta.description}</CardDescription>
        </CardHeader>
        <CardContent>
          {query.report === "activity" && <ActivityTable scope={scope} isStaff={isStaff && !ownerId} />}
          {query.report === "orders" && <OrdersSummary scope={scope} ordersPath={ordersPath} />}
          {query.report === "shipments" && <ShipmentsTable scope={scope} query={query} ordersPath={ordersPath} hrefFor={hrefFor} isStaff={isStaff && !ownerId} />}
          {query.report === "returns" && <ReturnsTable scope={scope} query={query} ordersPath={ordersPath} hrefFor={hrefFor} isStaff={isStaff && !ownerId} />}
          {query.report === "inventory" && <InventoryTable scope={scope} query={query} hrefFor={hrefFor} isStaff={isStaff && !ownerId} />}
        </CardContent>
      </Card>
    </>
  );
}

type Scope = ReturnType<typeof scopeFromQuery>;

async function ActivityTable({ scope, isStaff }: { scope: Scope; isStaff: boolean }) {
  const rows = await skuActivityReport(scope);
  if (rows.length === 0) return <EmptyState icon={BarChart3} title="No SKUs to report" description="Add products and receive stock to see activity here." />;
  const totals = rows.reduce((t, r) => ({ received: t.received + r.received, shipped: t.shipped + r.shipped, returned: t.returned + r.returned, damaged: t.damaged + r.damaged, missing: t.missing + r.missing, onHand: t.onHand + r.onHand, available: t.available + r.available }), { received: 0, shipped: 0, returned: 0, damaged: 0, missing: 0, onHand: 0, available: 0 });
  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>SKU</TableHead>
            <TableHead>Product</TableHead>
            {isStaff && <TableHead className="hidden lg:table-cell">Owner</TableHead>}
            <TableHead className="text-right">Received</TableHead>
            <TableHead className="text-right">Shipped</TableHead>
            <TableHead className="hidden text-right md:table-cell">Returned</TableHead>
            <TableHead className="hidden text-right md:table-cell">Damaged</TableHead>
            <TableHead className="hidden text-right md:table-cell">Missing</TableHead>
            <TableHead className="hidden text-right lg:table-cell">Adjusted</TableHead>
            <TableHead className="text-right">On hand</TableHead>
            <TableHead className="text-right">Available</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.variantId}>
              <TableCell className="font-mono text-xs">{r.sku}</TableCell>
              <TableCell>
                {r.product}
                {r.variantName && <span className="text-muted-foreground"> · {r.variantName}</span>}
              </TableCell>
              {isStaff && <TableCell className="hidden text-muted-foreground lg:table-cell">{r.owner}</TableCell>}
              <TableCell className="text-right tabular-nums">{formatInt(r.received)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatInt(r.shipped)}</TableCell>
              <TableCell className="hidden text-right tabular-nums md:table-cell">{formatInt(r.returned)}</TableCell>
              <TableCell className={`hidden text-right tabular-nums md:table-cell ${r.damaged ? "text-red-700" : ""}`}>{formatInt(r.damaged)}</TableCell>
              <TableCell className={`hidden text-right tabular-nums md:table-cell ${r.missing ? "text-red-700" : ""}`}>{formatInt(r.missing)}</TableCell>
              <TableCell className="hidden text-right tabular-nums lg:table-cell">{r.adjusted > 0 ? `+${r.adjusted}` : r.adjusted}</TableCell>
              <TableCell className="text-right tabular-nums">{formatInt(r.onHand)}</TableCell>
              <TableCell className={`text-right font-medium tabular-nums ${r.available <= 5 ? "text-amber-700" : ""}`}>{formatInt(r.available)}</TableCell>
            </TableRow>
          ))}
          <TableRow className="bg-muted/40 font-medium">
            <TableCell colSpan={isStaff ? 3 : 2}>Total</TableCell>
            <TableCell className="text-right tabular-nums">{formatInt(totals.received)}</TableCell>
            <TableCell className="text-right tabular-nums">{formatInt(totals.shipped)}</TableCell>
            <TableCell className="hidden text-right tabular-nums md:table-cell">{formatInt(totals.returned)}</TableCell>
            <TableCell className="hidden text-right tabular-nums md:table-cell">{formatInt(totals.damaged)}</TableCell>
            <TableCell className="hidden text-right tabular-nums md:table-cell">{formatInt(totals.missing)}</TableCell>
            <TableCell className="hidden lg:table-cell" />
            <TableCell className="text-right tabular-nums">{formatInt(totals.onHand)}</TableCell>
            <TableCell className="text-right tabular-nums">{formatInt(totals.available)}</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
  );
}

const STATUS_LABEL: Record<string, string> = { DRAFT: "Draft", NEW: "New", CONFIRMED: "Confirmed", CANCELLED: "Cancelled", COMPLETED: "Completed", UNFULFILLED: "Unfulfilled", RESERVED: "Reserved", PICKING: "Picking", PACKED: "Packed", PARTIALLY_SHIPPED: "Partially shipped", SHIPPED: "Shipped", FULFILLED: "Fulfilled", MANUAL: "Manual", CSV_IMPORT: "CSV import", SHOPIFY: "Shopify", THREEPL_PORTAL: "3PL portal" };

async function OrdersSummary({ scope, ordersPath }: { scope: Scope; ordersPath: string }) {
  const s = await ordersSummaryReport(scope);
  if (s.totalOrders === 0) return <EmptyState icon={PackageCheck} title="No orders in this period" description="Change the date range or wait for new orders." />;
  const block = (title: string, entries: Record<string, number>) => (
    <div>
      <p className="mb-2 text-sm font-medium">{title}</p>
      <ul className="divide-y rounded-lg border text-sm">
        {Object.entries(entries)
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => (
            <li key={k} className="flex justify-between px-3 py-1.5">
              <span>{STATUS_LABEL[k] ?? k}</span>
              <span className="tabular-nums">{formatInt(v)}</span>
            </li>
          ))}
      </ul>
    </div>
  );
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
        {[
          ["Orders", s.totalOrders],
          ["Lines", s.lines],
          ["Units ordered", s.units.ordered],
          ["Units shipped", s.units.shipped],
          ["Units cancelled", s.units.cancelled],
          ["Units returned", s.units.returned],
        ].map(([label, v]) => (
          <div key={label as string} className="rounded-lg border p-3">
            <p className="text-xs text-muted-foreground">{label as string}</p>
            <p className="text-xl font-semibold tabular-nums">{formatInt(v as number)}</p>
          </div>
        ))}
      </div>
      <div className="grid gap-6 md:grid-cols-3">
        {block("By order status", s.byStatus)}
        {block("By fulfilment status", s.byFulfillment)}
        {block("By source", s.bySource)}
      </div>
      <p className="text-sm text-muted-foreground">
        Need the line-level detail? <Link href={ordersPath} className="underline underline-offset-4">Open the orders list</Link> or download the CSV above (Shopify-compatible order layout).
      </p>
    </div>
  );
}

async function ShipmentsTable({ scope, query, ordersPath, hrefFor, isStaff }: { scope: Scope; query: ReportQuery; ordersPath: string; hrefFor: (p: number) => string; isStaff: boolean }) {
  const r = await shipmentsReport({ ...scope, status: query.status, q: query.q, page: query.page });
  if (r.items.length === 0) return <EmptyState icon={Truck} title="No shipments match" description="Change the period, status or search." />;
  return (
    <div className="space-y-4">
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Shipped</TableHead>
              <TableHead>Order</TableHead>
              <TableHead>Carrier · tracking</TableHead>
              <TableHead className="hidden md:table-cell">Ship to</TableHead>
              <TableHead>Items</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {r.items.map((s) => (
              <TableRow key={s.id}>
                <TableCell className="whitespace-nowrap text-muted-foreground">{formatDateTime(s.shippedAt)}</TableCell>
                <TableCell>
                  <Link href={`${ordersPath}/${s.order.id}`} className="font-medium hover:underline">
                    {s.order.orderNumber}
                  </Link>
                  <div className="text-xs text-muted-foreground">{s.fulfillment.warehouse.code}</div>
                </TableCell>
                <TableCell>
                  {s.carrier ?? "—"}
                  {s.trackingNumber && (
                    <div className="font-mono text-xs">
                      {s.trackingUrl ? (
                        <a href={s.trackingUrl} target="_blank" rel="noreferrer" className="underline underline-offset-4">
                          {s.trackingNumber}
                        </a>
                      ) : (
                        s.trackingNumber
                      )}
                    </div>
                  )}
                </TableCell>
                <TableCell className="hidden text-muted-foreground md:table-cell">{[s.order.shipName, s.order.shipCity, s.order.shipCountry].filter(Boolean).join(", ") || "—"}</TableCell>
                <TableCell className="text-xs">
                  {s.items.map((i, idx) => (
                    <div key={idx}>
                      <span className="font-mono">{i.orderItem.sku}</span> × {i.quantity}
                      {isStaff && <span className="text-muted-foreground"> · {i.orderItem.owner.businessName}</span>}
                    </div>
                  ))}
                </TableCell>
                <TableCell>
                  <StatusBadge status={s.status} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <Pagination page={r.page} pageCount={r.pageCount} total={r.total} pageSize={r.pageSize} hrefFor={hrefFor} />
    </div>
  );
}

async function ReturnsTable({ scope, query, ordersPath, hrefFor, isStaff }: { scope: Scope; query: ReportQuery; ordersPath: string; hrefFor: (p: number) => string; isStaff: boolean }) {
  const status = (["RECEIVED", "INSPECTED", "ALL"].includes(query.status ?? "") ? query.status : "ALL") as "RECEIVED" | "INSPECTED" | "ALL";
  const r = await returnsReport({ ...scope, status, page: query.page });
  if (r.items.length === 0) return <EmptyState icon={RotateCcw} title="No returns match" description="Returns appear here once the warehouse receives them." />;
  return (
    <div className="space-y-4">
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Received</TableHead>
              <TableHead>Order</TableHead>
              <TableHead className="hidden md:table-cell">Reference · reason</TableHead>
              <TableHead>Items</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {r.items.map((ret) => (
              <TableRow key={ret.id}>
                <TableCell className="whitespace-nowrap text-muted-foreground">{formatDateTime(ret.receivedAt)}</TableCell>
                <TableCell>
                  <Link href={`${ordersPath}/${ret.order.id}`} className="font-medium hover:underline">
                    {ret.order.orderNumber}
                  </Link>
                  <div className="text-xs text-muted-foreground">{ret.warehouse.code}</div>
                </TableCell>
                <TableCell className="hidden text-muted-foreground md:table-cell">{[ret.reference, ret.reason].filter(Boolean).join(" · ") || "—"}</TableCell>
                <TableCell className="text-xs">
                  {ret.items.map((i, idx) => (
                    <div key={idx}>
                      <span className="font-mono">{i.orderItem.sku}</span> × {i.quantity} <span className="text-muted-foreground">· {i.condition ? (i.condition === "SELLABLE" ? "restocked" : "damaged") : "pending"}</span>
                      {isStaff && <span className="text-muted-foreground"> · {i.orderItem.owner.businessName}</span>}
                    </div>
                  ))}
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className={ret.status === "RECEIVED" ? "border-amber-200 bg-amber-50 text-amber-800" : "border-emerald-200 bg-emerald-50 text-emerald-700"}>
                    {ret.status === "RECEIVED" ? "Awaiting inspection" : "Inspected"}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <Pagination page={r.page} pageCount={r.pageCount} total={r.total} pageSize={r.pageSize} hrefFor={hrefFor} />
    </div>
  );
}

async function InventoryTable({ scope, query, hrefFor, isStaff }: { scope: Scope; query: ReportQuery; hrefFor: (p: number) => string; isStaff: boolean }) {
  const r = await listStock({ ownerId: scope.ownerId, warehouseId: scope.warehouseId, page: query.page });
  if (r.items.length === 0) return <EmptyState icon={BarChart3} title="No stock" description="Nothing is currently in stock for this selection." />;
  return (
    <div className="space-y-4">
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>SKU</TableHead>
              <TableHead>Product</TableHead>
              {isStaff && <TableHead className="hidden lg:table-cell">Owner</TableHead>}
              <TableHead>Warehouse</TableHead>
              <TableHead className="text-right">On hand</TableHead>
              <TableHead className="text-right">Reserved</TableHead>
              <TableHead className="text-right">Available</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {r.items.map((b) => (
              <TableRow key={b.id}>
                <TableCell className="font-mono text-xs">{b.variant.sku}</TableCell>
                <TableCell>{b.variant.product.name}</TableCell>
                {isStaff && <TableCell className="hidden text-muted-foreground lg:table-cell">{b.variant.product.owner.businessName}</TableCell>}
                <TableCell>{b.warehouse.code}</TableCell>
                <TableCell className="text-right tabular-nums">{formatInt(b.onHand)}</TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">{formatInt(b.reserved)}</TableCell>
                <TableCell className="text-right font-medium tabular-nums">{formatInt(b.onHand - b.reserved)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <Pagination page={r.page} pageCount={r.pageCount} total={r.total} pageSize={r.pageSize} hrefFor={hrefFor} />
    </div>
  );
}
