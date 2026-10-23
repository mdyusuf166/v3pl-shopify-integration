import Link from "next/link";
import { AlertTriangle, Boxes, Lock, PackageCheck } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { formatInt } from "@/lib/format";
import { stockTotals } from "@/server/services/inventory";

/** Dashboard inventory tiles (spec §54): total, available, reserved, low stock. */
export async function StockStats() {
  const totals = await stockTotals();
  const tiles = [
    { label: "Units on hand", value: totals.onHand, href: "/admin/inventory", icon: Boxes },
    { label: "Available", value: totals.available, href: "/admin/inventory", icon: PackageCheck },
    { label: "Reserved", value: totals.reserved, href: "/admin/inventory", icon: Lock },
    { label: "Low stock (≤ 5)", value: totals.lowStock, href: "/admin/inventory?lowStock=1", icon: AlertTriangle },
  ];
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {tiles.map((t) => (
        <Link key={t.label} href={t.href} className="group">
          <Card className="transition-colors group-hover:border-foreground/30">
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
