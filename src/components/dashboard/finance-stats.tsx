import Link from "next/link";
import { ArrowDownLeft, ArrowUpRight } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { formatMoney } from "@/lib/format";
import { allOwnerBalances } from "@/server/services/finance";

/** Admin dashboard: operational totals across all owners (payable to owners vs receivable from owners). */
export async function FinanceStats() {
  const { totals, rows } = await allOwnerBalances();
  const open = rows.filter((r) => r.payable.gt(0) || r.receivable.gt(0)).length;
  const tiles = [
    { label: "Payable to owners", value: formatMoney(totals.payable), icon: ArrowUpRight, hint: "3PL product value + vendor payables, minus payments made" },
    { label: "Receivable from owners", value: formatMoney(totals.receivable), icon: ArrowDownLeft, hint: "Operational charges minus payments received (not netted against payables)" },
  ];
  return (
    <div className="grid gap-4 sm:grid-cols-2" data-slot="finance-stats">
      {tiles.map((t) => (
        <Link key={t.label} href="/admin/finance" className="group">
          <Card className="transition-colors group-hover:border-foreground/30">
            <CardContent className="flex items-center justify-between pt-4">
              <div>
                <p className="text-sm text-muted-foreground">{t.label}</p>
                <p className="text-2xl font-semibold tabular-nums">{t.value}</p>
                <p className="text-xs text-muted-foreground">
                  {t.hint} · {open} owner{open === 1 ? "" : "s"} with an outstanding balance
                </p>
              </div>
              <t.icon className="size-5 text-muted-foreground" />
            </CardContent>
          </Card>
        </Link>
      ))}
    </div>
  );
}
