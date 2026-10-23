import { TrendingUp } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatInt, formatMoney } from "@/lib/format";
import type { GrossMargin } from "@/server/services/finance";

/** Vendor gross-margin report: retail sales value of shipped units minus their wholesale cost. Reporting only — never a payable (D-064). */
export function GrossMarginCard({ margin, ownerLabel = "vendor" }: { margin: GrossMargin; ownerLabel?: string }) {
  return (
    <Card data-slot="gross-margin-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <TrendingUp className="size-4 text-muted-foreground" /> Gross margin
        </CardTitle>
        <CardDescription>Shipped units of {ownerLabel === "you" ? "your" : `this ${ownerLabel}'s`} products: retail sales value minus wholesale product cost. A reporting figure, not money owed.</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Units shipped</dt>
          <dd className="text-right tabular-nums">{formatInt(margin.units)}</dd>
          <dt className="text-muted-foreground">Retail sales value</dt>
          <dd className="text-right tabular-nums">{formatMoney(margin.sales)}</dd>
          <dt className="text-muted-foreground">Wholesale product cost{margin.unitsWithCost < margin.units ? ` (${formatInt(margin.unitsWithCost)} units priced)` : ""}</dt>
          <dd className="text-right tabular-nums">{formatMoney(margin.cost)}</dd>
          <dt className="font-medium">Gross margin</dt>
          <dd className="text-right text-lg font-semibold tabular-nums" data-slot="gross-margin">
            {formatMoney(margin.grossMargin)}
          </dd>
        </dl>
      </CardContent>
    </Card>
  );
}
