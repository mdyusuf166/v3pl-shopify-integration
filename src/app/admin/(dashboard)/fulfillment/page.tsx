import type { Metadata } from "next";
import Link from "next/link";
import { PackageCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/common/empty-state";
import { NativeSelect } from "@/components/common/native-select";
import { Pagination } from "@/components/common/pagination";
import { PageHeader } from "@/components/layout/page-header";
import { formatDateTime } from "@/lib/format";
import { requireRole } from "@/server/auth/guards";
import { listFulfillmentQueue } from "@/server/services/fulfillment";
import { listOrders } from "@/server/services/orders";
import { listWarehouses } from "@/server/services/warehouses";

export const metadata: Metadata = { title: "Fulfillment" };

export default async function FulfillmentPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireRole("ADMIN", "WAREHOUSE");
  const sp = await searchParams;
  const tab = (["OPEN", "PICKING", "PACKED", "SHIPPED"].includes(String(sp.tab)) ? String(sp.tab) : "OPEN") as "OPEN" | "PICKING" | "PACKED" | "SHIPPED";
  const warehouseId = typeof sp.warehouseId === "string" && sp.warehouseId ? sp.warehouseId : undefined;
  const page = Number(sp.page) || 1;
  const [queue, toPick, warehouses] = await Promise.all([listFulfillmentQueue(tab, warehouseId, page), listOrders({ status: "OPEN", fulfillmentStatus: "RESERVED", warehouseId, pageSize: 10 }), listWarehouses()]);
  const hrefFor = (p: number) => `/admin/fulfillment?tab=${tab}${warehouseId ? `&warehouseId=${warehouseId}` : ""}${p > 1 ? `&page=${p}` : ""}`;

  return (
    <>
      <PageHeader title="Fulfillment" description="Warehouse work queue: reserved orders waiting to be picked, picking in progress, packed and ready to ship." />
      <form method="get" className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="tab" value={tab} />
        <NativeSelect name="warehouseId" defaultValue={warehouseId ?? ""} className="w-44" aria-label="Warehouse">
          <option value="">All warehouses</option>
          {warehouses.map((w) => (
            <option key={w.id} value={w.id}>
              {w.code} · {w.name}
            </option>
          ))}
        </NativeSelect>
        <Button type="submit" variant="secondary" size="sm">
          Apply
        </Button>
        <div className="ml-auto flex gap-1">
          {(["OPEN", "PICKING", "PACKED", "SHIPPED"] as const).map((t) => (
            <Button key={t} size="sm" variant={t === tab ? "default" : "outline"} render={<Link href={`/admin/fulfillment?tab=${t}${warehouseId ? `&warehouseId=${warehouseId}` : ""}`} />}>
              {t === "OPEN" ? "Open" : t.charAt(0) + t.slice(1).toLowerCase()}
            </Button>
          ))}
        </div>
      </form>

      {tab === "OPEN" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Reserved, not yet picking ({toPick.total})</CardTitle>
          </CardHeader>
          <CardContent>
            {toPick.items.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing waiting.</p>
            ) : (
              <ul className="divide-y text-sm">
                {toPick.items.map((o) => (
                  <li key={o.id} className="flex items-center justify-between gap-3 py-2">
                    <Link href={`/admin/orders/${o.id}`} className="font-medium hover:underline">
                      Order {o.orderNumber}
                    </Link>
                    <span className="truncate text-muted-foreground">{o.shipName ?? o.customerName ?? ""}</span>
                    <span className="tabular-nums text-muted-foreground">{o.items.reduce((s, i) => s + i.quantity - i.cancelledQty, 0)} units</span>
                    <span className="text-muted-foreground">{formatDateTime(o.placedAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      {queue.items.length === 0 ? (
        <EmptyState icon={PackageCheck} title={tab === "OPEN" ? "No picking or packing in progress" : `No ${tab.toLowerCase()} fulfilments`} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {queue.items.map((f) => (
            <Card key={f.id}>
              <CardHeader className="flex-row items-start justify-between">
                <div>
                  <CardTitle className="text-base">
                    <Link href={`/admin/orders/${f.order.id}`} className="hover:underline">
                      Order {f.order.orderNumber}
                    </Link>{" "}
                    <span className="text-muted-foreground">· {f.warehouse.code}</span>
                  </CardTitle>
                  <p className="text-xs text-muted-foreground">
                    {f.order.shipName ?? f.order.customerName ?? ""} {f.order.shipCity ? `· ${f.order.shipCity}` : ""} · started {formatDateTime(f.createdAt)}
                  </p>
                </div>
                <Badge variant="outline">{f.status === "PICKING" ? "Picking" : f.status === "PACKED" ? "Packed" : f.status === "SHIPPED" ? "Shipped" : "Cancelled"}</Badge>
              </CardHeader>
              <CardContent>
                <ul className="divide-y text-sm">
                  {f.items.map((i) => (
                    <li key={i.id} className="flex items-center justify-between py-1.5">
                      <span>
                        <span className="font-mono text-xs">{i.orderItem.sku}</span> <span className="text-muted-foreground">{i.orderItem.title}</span>
                      </span>
                      <span className="whitespace-nowrap">
                        {i.location && <span className="mr-2 rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">{i.location.label}</span>}× {i.quantity}
                      </span>
                    </li>
                  ))}
                </ul>
                {f.shipment?.trackingNumber && <p className="mt-2 text-xs text-muted-foreground">{f.shipment.carrier} {f.shipment.trackingNumber}</p>}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      <Pagination page={queue.page} pageCount={queue.pageCount} total={queue.total} pageSize={queue.pageSize} hrefFor={hrefFor} />
    </>
  );
}
