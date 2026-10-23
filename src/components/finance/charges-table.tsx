import Link from "next/link";
import { Receipt } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/common/empty-state";
import { formatDateTime, formatMoney } from "@/lib/format";
import { CHARGE_BASIS_LABELS, CHARGE_TYPE_LABELS } from "@/lib/validation/finance";
import type { listCharges } from "@/server/services/finance";

type Rows = Awaited<ReturnType<typeof listCharges>>["items"];

/** Applied operational charges (frozen at the time of the event). */
export function ChargesTable({ rows, orderHref, showOwner = false }: { rows: Rows; orderHref: (orderId: string) => string; showOwner?: boolean }) {
  if (rows.length === 0) return <EmptyState icon={Receipt} title="No charges recorded" description="Charges are recorded when shipments are made while charge rules are active and charges are enabled for the business." />;
  return (
    <Table data-slot="charges-table">
      <TableHeader>
        <TableRow>
          <TableHead>Date</TableHead>
          {showOwner && <TableHead>Owner</TableHead>}
          <TableHead>Charge</TableHead>
          <TableHead>Basis</TableHead>
          <TableHead>Reason</TableHead>
          <TableHead>Order</TableHead>
          <TableHead className="text-right">Qty</TableHead>
          <TableHead className="text-right">Unit</TableHead>
          <TableHead className="text-right">Amount</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((c) => (
          <TableRow key={c.id}>
            <TableCell className="whitespace-nowrap text-muted-foreground">{formatDateTime(c.createdAt)}</TableCell>
            {showOwner && <TableCell>{c.owner.businessName}</TableCell>}
            <TableCell>
              <Badge variant="outline">{CHARGE_TYPE_LABELS[c.chargeType]}</Badge> <span className="text-sm">{c.ruleName}</span>
              {c.rule && !c.rule.active && <span className="ml-1 text-xs text-muted-foreground">(rule now inactive)</span>}
              {!c.rule && <span className="ml-1 text-xs text-muted-foreground">(rule deleted)</span>}
            </TableCell>
            <TableCell className="text-muted-foreground">{CHARGE_BASIS_LABELS[c.basis]}</TableCell>
            <TableCell className="max-w-sm">
              <span className="block truncate" title={c.reason}>
                {c.reason}
              </span>
            </TableCell>
            <TableCell>
              {c.order ? (
                <Link href={orderHref(c.order.id)} className="underline-offset-2 hover:underline">
                  {c.order.orderNumber}
                </Link>
              ) : (
                "—"
              )}
            </TableCell>
            <TableCell className="text-right tabular-nums">{c.quantity}</TableCell>
            <TableCell className="text-right tabular-nums">{formatMoney(c.unitAmount, c.currency)}</TableCell>
            <TableCell className="text-right font-medium tabular-nums">{formatMoney(c.amount, c.currency)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
