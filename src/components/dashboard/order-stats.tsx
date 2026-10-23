import Link from "next/link";
import { AlertTriangle, ClipboardList, PackageCheck, ShoppingCart, Truck } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { formatInt } from "@/lib/format";
import { orderCounters } from "@/server/services/orders";

/** Dashboard order tiles (spec §54): open, picking, packing, shipped today, attention. */
export async function OrderStats() {
  const c = await orderCounters();
  const tiles = [
    { label: "Open orders", value: c.open, href: "/admin/orders?status=OPEN", icon: ShoppingCart },
    { label: "Picking", value: c.picking, href: "/admin/fulfillment?tab=PICKING", icon: ClipboardList },
    { label: "Packed", value: c.packed, href: "/admin/fulfillment?tab=PACKED", icon: PackageCheck },
    { label: "Shipped today", value: c.shippedToday, href: "/admin/fulfillment?tab=SHIPPED", icon: Truck },
    { label: "Needs attention", value: c.attention, href: "/admin/orders?status=ALL&needsAttention=1", icon: AlertTriangle },
  ];
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
      {tiles.map((t) => (
        <Link key={t.label} href={t.href} className="group">
          <Card className={`transition-colors group-hover:border-foreground/30 ${t.label === "Needs attention" && t.value > 0 ? "border-amber-300" : ""}`}>
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
  );
}
