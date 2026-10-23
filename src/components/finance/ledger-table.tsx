import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/common/empty-state";
import { Scale } from "lucide-react";
import { formatDateTime, formatMoney } from "@/lib/format";
import { CHARGE_TYPE_LABELS, LEDGER_TYPE_LABELS } from "@/lib/validation/finance";
import type { listLedgerEntries } from "@/server/services/finance";

type Rows = Awaited<ReturnType<typeof listLedgerEntries>>["items"];

/** Immutable ledger history: one column per account, signed by effect, so both sides stay traceable (D-064). */
export function LedgerTable({ rows, orderHref, ownerLabel = "owner" }: { rows: Rows; orderHref: (orderId: string) => string; ownerLabel?: string }) {
  if (rows.length === 0) return <EmptyState icon={Scale} title="No ledger entries yet" description="Entries appear when shipments are recorded (product value, charges), when a vendor payable is created, or when a payment / adjustment is entered." />;
  const cell = (e: Rows[number], account: "PAYABLE" | "RECEIVABLE") => (e.account === account ? `${e.effect === "INCREASE" ? "+" : "−"}${formatMoney(e.amount, e.currency)}` : "");
  return (
    <Table data-slot="ledger-table">
      <TableHeader>
        <TableRow>
          <TableHead>Date</TableHead>
          <TableHead>Type</TableHead>
          <TableHead>Description</TableHead>
          <TableHead>Reference</TableHead>
          <TableHead className="text-right">Payable to {ownerLabel}</TableHead>
          <TableHead className="text-right">Receivable from {ownerLabel}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((e) => (
          <TableRow key={e.id}>
            <TableCell className="whitespace-nowrap text-muted-foreground">{formatDateTime(e.occurredAt)}</TableCell>
            <TableCell>
              <Badge variant="outline">{LEDGER_TYPE_LABELS[e.type]}</Badge>
              {e.charge && <span className="ml-1 text-xs text-muted-foreground">{CHARGE_TYPE_LABELS[e.charge.chargeType]}</span>}
              {e.quantity !== null && e.type !== "CHARGE" && <span className="ml-1 text-xs text-muted-foreground">{e.quantity} units</span>}
            </TableCell>
            <TableCell className="max-w-md">
              <span className="block truncate" title={e.description}>
                {e.description}
              </span>
            </TableCell>
            <TableCell className="text-muted-foreground">
              {e.order ? (
                <Link href={orderHref(e.order.id)} className="underline-offset-2 hover:underline">
                  {e.order.orderNumber}
                </Link>
              ) : (
                [e.reference, e.receivingItem ? `Receipt · ${e.receivingItem.variant.sku}` : null].filter(Boolean).join(" · ") || "—"
              )}
            </TableCell>
            <TableCell className={`text-right tabular-nums ${e.account === "PAYABLE" && e.effect === "DECREASE" ? "text-muted-foreground" : ""}`}>{cell(e, "PAYABLE")}</TableCell>
            <TableCell className={`text-right tabular-nums ${e.account === "RECEIVABLE" && e.effect === "DECREASE" ? "text-muted-foreground" : ""}`}>{cell(e, "RECEIVABLE")}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
