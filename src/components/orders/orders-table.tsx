import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusBadge } from "@/components/common/status-badge";
import { formatDateTime, formatMoney } from "@/lib/format";
import { presentOrderStatus, warehouseStageLabel } from "@/lib/order-presentation";
import type { listOrders } from "@/server/services/orders";

type Row = Awaited<ReturnType<typeof listOrders>>["items"][number];

/**
 * Orders list. The primary status is the customer-facing one (D-055); staff additionally see the
 * warehouse stage (reserved / picking / packed) as a hint under it.
 */
export function OrdersTable({ rows, basePath, scoped }: { rows: Row[]; basePath: string; scoped: boolean }) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Order</TableHead>
            <TableHead>Placed</TableHead>
            <TableHead>Customer</TableHead>
            <TableHead>Items</TableHead>
            {!scoped && <TableHead className="hidden lg:table-cell">Owners</TableHead>}
            <TableHead>Status</TableHead>
            {!scoped && <TableHead className="hidden md:table-cell">Payment</TableHead>}
            {!scoped && <TableHead className="hidden text-right md:table-cell">Total</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((o) => {
            const owners = [...new Set(o.items.map((i) => i.owner.businessName))];
            const units = o.items.reduce((s, i) => s + i.quantity - i.cancelledQty, 0);
            const presented = presentOrderStatus(o);
            const stage = !scoped && presented === "UNFULFILLED" ? warehouseStageLabel(o.fulfillmentStatus) : null;
            return (
              <TableRow key={o.id}>
                <TableCell>
                  <Link href={`${basePath}/${o.id}`} className="font-medium hover:underline">
                    {o.orderNumber}
                  </Link>
                  <div className="text-xs text-muted-foreground">
                    {o.source.toLowerCase().replace("_", " ")}
                    {o.shopifyOrderName || o.sourceRef ? ` · ${o.shopifyOrderName ?? o.sourceRef}` : ""}
                  </div>
                </TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">{formatDateTime(o.placedAt)}</TableCell>
                <TableCell className="max-w-48 truncate">{o.shipName ?? o.customerName ?? "—"}</TableCell>
                <TableCell className="tabular-nums">
                  {units} {units === 1 ? "item" : "items"}
                  {o.items.length > 1 && <span className="text-muted-foreground"> · {o.items.length} lines</span>}
                </TableCell>
                {!scoped && <TableCell className="hidden max-w-48 truncate text-muted-foreground lg:table-cell">{owners.join(", ")}</TableCell>}
                <TableCell>
                  <div className="flex items-center gap-1.5">
                    <StatusBadge status={presented} />
                    {o.needsAttention && <AlertTriangle className="size-4 text-amber-600" aria-label="Needs attention" />}
                  </div>
                  {stage && <div className="mt-0.5 text-xs text-muted-foreground">{stage}</div>}
                </TableCell>
                {!scoped && <TableCell className="hidden capitalize text-muted-foreground md:table-cell">{o.financialStatus.toLowerCase().replace("_", " ")}</TableCell>}
                {!scoped && <TableCell className="hidden text-right tabular-nums md:table-cell">{formatMoney(o.total, o.currency)}</TableCell>}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
