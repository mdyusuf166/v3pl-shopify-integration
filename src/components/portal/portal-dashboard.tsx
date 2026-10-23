import Link from "next/link";
import { AlertTriangle, ArrowRight, Boxes, ClipboardList, Lock, PackageCheck, PackageOpen, ShoppingCart, Truck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/common/status-badge";
import { presentOrderStatus } from "@/lib/order-presentation";
import { PageHeader } from "@/components/layout/page-header";
import { OwnerProfileCard } from "@/components/owners/owner-profile-card";
import { MOVEMENT_TYPE_LABELS, formatDateTime, formatInt, formatSigned } from "@/lib/format";
import { portalDashboard } from "@/server/services/reports";
import { BalanceCard } from "@/components/finance/balance-card";
import { ownerBalance } from "@/server/services/finance";

type Owner = Parameters<typeof OwnerProfileCard>[0]["owner"] & { id: string; businessName: string; type: "VENDOR" | "THREEPL_CLIENT" };

type Props = { owner: Owner; userName: string; basePath: string; canCreateOrders: boolean };


/** Vendor / 3PL home: real figures from the ledger and orders, scoped to the session owner. */
export async function PortalDashboard({ owner, userName, basePath, canCreateOrders }: Props) {
  const [d, balance] = await Promise.all([portalDashboard(owner.id), ownerBalance(owner.id)]);
  const isVendor = owner.type === "VENDOR";
  const tiles = [
    { label: "Units on hand", value: d.stock.onHand, icon: Boxes, href: `${basePath}/products` },
    { label: "Reserved for orders", value: d.stock.reserved, icon: Lock, href: `${basePath}/orders?status=OPEN` },
    { label: "Available", value: d.stock.available, icon: PackageCheck, href: `${basePath}/products` },
    { label: "Low stock SKUs (≤ 5)", value: d.stock.lowStock, icon: AlertTriangle, href: `${basePath}/products`, warn: d.stock.lowStock > 0 },
    { label: "Open orders", value: d.counters.open, icon: ShoppingCart, href: `${basePath}/orders?status=OPEN` },
    { label: "Being picked / packed", value: d.counters.picking + d.counters.packed, icon: ClipboardList, href: `${basePath}/orders?status=OPEN` },
    { label: "Units shipped · 30 days", value: d.shippedUnits30d, icon: Truck, href: `${basePath}/shipments` },
    { label: "Units received · 30 days", value: d.receivedUnits30d, icon: PackageOpen, href: `${basePath}/inventory` },
  ];

  return (
    <>
      <PageHeader
        title={owner.businessName}
        description={isVendor ? `Welcome, ${userName}. This is your inventory and what is happening with your products.` : `Welcome, ${userName}. This is your stock and the orders you asked the warehouse to fulfil.`}
        actions={
          canCreateOrders ? (
            <Button render={<Link href={`${basePath}/orders/new`} />}>
              <ShoppingCart /> New order
            </Button>
          ) : undefined
        }
      />

      {d.skuCount === 0 && d.stock.onHand === 0 && (
        <Card>
          <CardContent className="flex flex-col gap-2 pt-6 text-sm sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-medium">Your account is ready</p>
              <p className="text-muted-foreground">No products or stock have been added yet. The V3PL team sets up your SKUs and books in your first delivery; everything then appears here automatically.</p>
            </div>
          </CardContent>
        </Card>
      )}

      <BalanceCard balance={balance} href={`${basePath}/finance`} ownerLabel="you" ownerType={owner.type} compact />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((t) => (
          <Link key={t.label} href={t.href} className="group">
            <Card className={`h-full transition-colors group-hover:border-foreground/30 ${t.warn ? "border-amber-300" : ""}`}>
              <CardContent className="flex items-center justify-between pt-4">
                <div>
                  <p className="text-sm text-muted-foreground">{t.label}</p>
                  <p className="text-2xl font-semibold tabular-nums">{formatInt(t.value)}</p>
                </div>
                <t.icon className="size-5 text-muted-foreground" />
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      {(d.returnsAwaiting > 0 || d.counters.attention > 0 || d.lostUnits30d > 0) && (
        <div className="flex flex-wrap gap-2 text-sm">
          {d.counters.attention > 0 && (
            <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-800">
              {d.counters.attention} order{d.counters.attention === 1 ? "" : "s"} waiting on stock
            </Badge>
          )}
          {d.returnsAwaiting > 0 && (
            <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-800">
              {d.returnsAwaiting} return{d.returnsAwaiting === 1 ? "" : "s"} awaiting inspection
            </Badge>
          )}
          {d.lostUnits30d > 0 && (
            <Badge variant="outline" className="border-red-200 bg-red-50 text-red-700">
              {d.lostUnits30d} unit{d.lostUnits30d === 1 ? "" : "s"} damaged or missing · 30 days
            </Badge>
          )}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex-row items-center justify-between">
            <div>
              <CardTitle className="text-base">Recent orders</CardTitle>
              <CardDescription>Latest orders containing your products.</CardDescription>
            </div>
            <Button variant="ghost" size="sm" render={<Link href={`${basePath}/orders`} />}>
              All orders <ArrowRight />
            </Button>
          </CardHeader>
          <CardContent>
            {d.recentOrders.length === 0 ? (
              <p className="text-sm text-muted-foreground">No orders yet.</p>
            ) : (
              <ul className="divide-y text-sm">
                {d.recentOrders.map((o) => (
                  <li key={o.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                    <Link href={`${basePath}/orders/${o.id}`} className="font-medium hover:underline">
                      Order {o.orderNumber}
                    </Link>
                    <span className="truncate text-muted-foreground">{o.shipName ?? o.customerName ?? ""}</span>
                    <span className="ml-auto text-xs text-muted-foreground">{o.items.reduce((s, i) => s + i.quantity - i.cancelledQty, 0)} units · {formatDateTime(o.placedAt)}</span>
                    <StatusBadge status={presentOrderStatus(o)} />
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Stock by warehouse</CardTitle>
              <CardDescription>Where your units are held right now.</CardDescription>
            </CardHeader>
            <CardContent>
              {d.byWarehouse.length === 0 ? (
                <p className="text-sm text-muted-foreground">No stock in any warehouse.</p>
              ) : (
                <ul className="divide-y text-sm">
                  {d.byWarehouse.map((w) => (
                    <li key={w.id} className="flex items-center justify-between py-1.5">
                      <div>
                        <span className="font-medium">{w.code}</span> <span className="text-muted-foreground">{w.name}</span>
                        {(w.city || w.country) && <div className="text-xs text-muted-foreground">{[w.city, w.country].filter(Boolean).join(", ")}</div>}
                      </div>
                      <div className="text-right tabular-nums">
                        <div>{formatInt(w.onHand)} on hand</div>
                        <div className="text-xs text-muted-foreground">{formatInt(w.available)} available</div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle className="text-base">Recent activity</CardTitle>
              <Button variant="ghost" size="sm" render={<Link href={`${basePath}/inventory`} />}>
                History <ArrowRight />
              </Button>
            </CardHeader>
            <CardContent>
              {d.recentMovements.length === 0 ? (
                <p className="text-sm text-muted-foreground">No activity yet.</p>
              ) : (
                <ul className="divide-y text-sm">
                  {d.recentMovements.map((m) => (
                    <li key={m.id} className="flex items-center justify-between gap-2 py-1.5">
                      <div className="min-w-0">
                        <div className="truncate">
                          {MOVEMENT_TYPE_LABELS[m.type] ?? m.type} · <span className="font-mono text-xs">{m.variant.sku}</span>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {m.warehouse.code} · {formatDateTime(m.createdAt)}
                        </div>
                      </div>
                      <span className={`tabular-nums ${m.quantity > 0 ? "text-emerald-700" : "text-red-700"}`}>{formatSigned(m.quantity)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-1">
          <OwnerProfileCard owner={owner} title="Your business" description="Contact the V3PL team to change these details." />
        </div>
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Reports</CardTitle>
            <CardDescription>Period and warehouse filters, downloadable as CSV.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {[
              ["activity", "SKU activity"],
              ["orders", "Orders summary"],
              ["shipments", "Shipments"],
              ["returns", "Returns"],
              ["inventory", "Inventory snapshot"],
            ].map(([r, label]) => (
              <Button key={r} variant="outline" size="sm" render={<Link href={`${basePath}/reports?report=${r}`} />}>
                {label}
              </Button>
            ))}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
