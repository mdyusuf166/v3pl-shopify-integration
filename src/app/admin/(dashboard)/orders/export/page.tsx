import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/common/native-select";
import { PageHeader } from "@/components/layout/page-header";
import { FULFILLMENT_STATUSES, ORDER_SOURCES, ORDER_STATUSES, SHIPMENT_STATUSES } from "@/lib/validation/orders";
import { requireStaff } from "@/server/auth/guards";
import { listOwnerOptions } from "@/server/services/owners";
import { listWarehouses } from "@/server/services/warehouses";

export const metadata: Metadata = { title: "Export orders" };

export default async function ExportOrdersPage() {
  await requireStaff();
  const [warehouses, vendors, clients] = await Promise.all([listWarehouses(true), listOwnerOptions("VENDOR"), listOwnerOptions("THREEPL_CLIENT")]);
  const sel = (name: string, label: string, options: readonly string[]) => (
    <div className="space-y-1.5">
      <Label htmlFor={name}>{label}</Label>
      <NativeSelect id={name} name={name} defaultValue="ALL">
        <option value="ALL">All</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o.toLowerCase().replace("_", " ")}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
  return (
    <>
      <div>
        <Link href="/admin/orders" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ChevronLeft className="size-4" /> Orders
        </Link>
      </div>
      <PageHeader title="Export orders" description="Filter → Export → CSV. One row per line item, Shopify-compatible columns plus V3PL columns. Opens cleanly in Excel or Google Sheets." />
      <Card className="max-w-3xl">
        <CardHeader>
          <CardTitle>Filters</CardTitle>
          <CardDescription>Leave a filter on “All” to include everything. Up to 5,000 orders per export.</CardDescription>
        </CardHeader>
        <CardContent>
          <form method="get" action="/api/orders/export" className="grid gap-4 sm:grid-cols-2">
            {sel("status", "Order status", ORDER_STATUSES)}
            {sel("fulfillmentStatus", "Fulfilment status", FULFILLMENT_STATUSES)}
            {sel("shipmentStatus", "Shipment status", SHIPMENT_STATUSES)}
            {sel("source", "Source", ORDER_SOURCES)}
            <div className="space-y-1.5">
              <Label htmlFor="ownerId">Vendor / 3PL client</Label>
              <NativeSelect id="ownerId" name="ownerId" defaultValue="">
                <option value="">All</option>
                {[...vendors, ...clients].map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.businessName}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="warehouseId">Warehouse</Label>
              <NativeSelect id="warehouseId" name="warehouseId" defaultValue="">
                <option value="">All</option>
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.code} · {w.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="from">Placed from</Label>
              <Input id="from" name="from" type="date" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="to">Placed to</Label>
              <Input id="to" name="to" type="date" />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="shopifyStoreId">Shopify store id (optional)</Label>
              <Input id="shopifyStoreId" name="shopifyStoreId" placeholder="Available once stores are connected (Phase 7)" />
            </div>
            <div className="sm:col-span-2 flex justify-end">
              <Button type="submit">
                <Download /> Export CSV
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </>
  );
}
