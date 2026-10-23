import type { Metadata } from "next";
import Link from "next/link";
import { Download, Plus, ShoppingCart, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/common/empty-state";
import { NativeSelect } from "@/components/common/native-select";
import { Pagination } from "@/components/common/pagination";
import { SearchFilterBar } from "@/components/common/search-filter-bar";
import { PageHeader } from "@/components/layout/page-header";
import { OrdersTable } from "@/components/orders/orders-table";
import { PRESENTED_STATUSES, PRESENTED_STATUS_LABEL } from "@/lib/order-presentation";
import { ORDER_SOURCES, orderListQuerySchema } from "@/lib/validation/orders";
import { requireStaff } from "@/server/auth/guards";
import { listOrders } from "@/server/services/orders";
import { listOwnerOptions } from "@/server/services/owners";
import { listWarehouses } from "@/server/services/warehouses";

export const metadata: Metadata = { title: "Orders" };

const ORDER_FILTER_LABEL: Record<string, string> = { ALL: "all orders", OPEN: "open orders (new + confirmed)", NEW: "new orders", CONFIRMED: "confirmed orders", COMPLETED: "completed orders", CANCELLED: "cancelled orders", DRAFT: "draft orders" };

export default async function OrdersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireStaff();
  const sp = await searchParams;
  const pick = (k: string) => (typeof sp[k] === "string" && sp[k] ? (sp[k] as string) : undefined);
  const q = orderListQuerySchema.parse({ q: pick("q"), status: pick("status"), view: pick("view"), fulfillmentStatus: pick("fulfillmentStatus"), source: pick("source"), ownerId: pick("ownerId"), warehouseId: pick("warehouseId"), needsAttention: sp.needsAttention === "1" ? true : undefined, from: pick("from"), to: pick("to"), page: pick("page") });
  const [result, warehouses, vendors, clients] = await Promise.all([
    listOrders({ ...q, from: q.from ? new Date(q.from) : undefined, to: q.to ? new Date(`${q.to}T23:59:59.999Z`) : undefined }),
    listWarehouses(true),
    listOwnerOptions("VENDOR"),
    listOwnerOptions("THREEPL_CLIENT"),
  ]);
  const hrefFor = (page: number) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ q: q.q, status: q.status !== "ALL" ? q.status : "", view: q.view !== "ALL" ? q.view : "", fulfillmentStatus: q.fulfillmentStatus !== "ALL" ? q.fulfillmentStatus : "", source: q.source !== "ALL" ? q.source : "", ownerId: q.ownerId, warehouseId: q.warehouseId, needsAttention: q.needsAttention ? "1" : "", from: q.from, to: q.to })) if (v) p.set(k, v);
    if (page > 1) p.set("page", String(page));
    const s = p.toString();
    return `/admin/orders${s ? `?${s}` : ""}`;
  };
  const canCreate = user.role !== "WAREHOUSE";

  return (
    <>
      <PageHeader
        title="Orders"
        description="Every order from every channel. One customer order stays one order; each line keeps its owner."
        actions={
          <>
            <Button variant="outline" render={<Link href="/admin/orders/export" />}>
              <Download /> Export
            </Button>
            {canCreate && (
              <>
                <Button variant="outline" render={<Link href="/admin/imports" />}>
                  <Upload /> Import CSV
                </Button>
                <Button render={<Link href="/admin/orders/new" />}>
                  <Plus /> New order
                </Button>
              </>
            )}
          </>
        }
      />
      <SearchFilterBar q={q.q} placeholder="Order #, reference, customer, SKU, tracking…">
        <NativeSelect name="status" defaultValue={q.status} aria-label="Open or all orders" className="w-36">
          <option value="ALL">All orders</option>
          <option value="OPEN">Open only</option>
          <option value="COMPLETED">Completed only</option>
          <option value="CANCELLED">Cancelled only</option>
        </NativeSelect>
        <NativeSelect name="view" defaultValue={q.view} aria-label="Status" className="w-44">
          <option value="ALL">Any status</option>
          {PRESENTED_STATUSES.map((s) => (
            <option key={s} value={s}>
              {PRESENTED_STATUS_LABEL[s]}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect name="source" defaultValue={q.source} aria-label="Source" className="w-36">
          <option value="ALL">Any source</option>
          {ORDER_SOURCES.map((s) => (
            <option key={s} value={s}>
              {s.toLowerCase().replace("_", " ")}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect name="ownerId" defaultValue={q.ownerId ?? ""} aria-label="Owner" className="w-44">
          <option value="">Any owner</option>
          {[...vendors, ...clients].map((o) => (
            <option key={o.id} value={o.id}>
              {o.businessName}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect name="warehouseId" defaultValue={q.warehouseId ?? ""} aria-label="Warehouse" className="w-32">
          <option value="">Any warehouse</option>
          {warehouses.map((w) => (
            <option key={w.id} value={w.id}>
              {w.code}
            </option>
          ))}
        </NativeSelect>
        <Input type="date" name="from" defaultValue={q.from ?? ""} aria-label="From date" className="w-36" />
        <Input type="date" name="to" defaultValue={q.to ?? ""} aria-label="To date" className="w-36" />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="needsAttention" value="1" defaultChecked={q.needsAttention} className="size-4 rounded border" /> Needs attention
        </label>
      </SearchFilterBar>
      <p className="text-xs text-muted-foreground" data-slot="orders-filter-caption">
        Showing {ORDER_FILTER_LABEL[q.status]}
        {q.view !== "ALL" ? ` · ${PRESENTED_STATUS_LABEL[q.view]}` : ""}
        {q.q ? ` · matching “${q.q}”` : ""} · newest first · {result.total} order{result.total === 1 ? "" : "s"}. Completed and cancelled orders stay listed here; use the filters to narrow down.
      </p>
      {result.items.length === 0 ? <EmptyState icon={ShoppingCart} title="No orders match these filters" description="Create an order, import a CSV, or widen the filters." /> : <OrdersTable rows={result.items} basePath="/admin/orders" scoped={false} />}
      <Pagination page={result.page} pageCount={result.pageCount} total={result.total} pageSize={result.pageSize} hrefFor={hrefFor} />
    </>
  );
}
