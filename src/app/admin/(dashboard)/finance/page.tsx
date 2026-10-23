import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader } from "@/components/layout/page-header";
import { formatDateTime, formatMoney } from "@/lib/format";
import { requireRole } from "@/server/auth/guards";
import { allOwnerBalances } from "@/server/services/finance";

export const metadata: Metadata = { title: "Finance" };

export default async function FinancePage() {
  await requireRole("ADMIN");
  const { rows, totals } = await allOwnerBalances();
  return (
    <>
      <PageHeader title="Finance" description="Operational settlement balances per vendor and 3PL client, derived from the ledger. Payable and receivable are separate obligations and are never netted. Charge rules live under Settings → Operational charges." />
      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardContent className="pt-4">
            <p className="text-sm text-muted-foreground">Payable to owners</p>
            <p className="text-2xl font-semibold tabular-nums text-emerald-700" data-slot="total-payable">
              {formatMoney(totals.payable)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <p className="text-sm text-muted-foreground">Receivable from owners</p>
            <p className="text-2xl font-semibold tabular-nums text-amber-700" data-slot="total-receivable">
              {formatMoney(totals.receivable)}
            </p>
          </CardContent>
        </Card>
      </div>
      <Table data-slot="owner-balances">
        <TableHeader>
          <TableRow>
            <TableHead>Business</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Charges</TableHead>
            <TableHead className="text-right">Payable to owner</TableHead>
            <TableHead className="text-right">Receivable from owner</TableHead>
            <TableHead>Last entry</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => {
            return (
              <TableRow key={r.id}>
                <TableCell>
                  <Link href={`/admin/finance/${r.id}`} className="font-medium underline-offset-2 hover:underline">
                    {r.businessName}
                  </Link>{" "}
                  <span className="text-xs text-muted-foreground">{r.code}</span>
                </TableCell>
                <TableCell className="text-muted-foreground">{r.type === "VENDOR" ? "Vendor" : "3PL client"}</TableCell>
                <TableCell>{r.chargesEnabled ? <Badge variant="outline">Enabled</Badge> : <span className="text-xs text-muted-foreground">Off</span>}</TableCell>
                <TableCell className={`text-right tabular-nums ${r.payable.gt(0) ? "text-emerald-700" : "text-muted-foreground"}`}>{formatMoney(r.payable)}</TableCell>
                <TableCell className={`text-right tabular-nums ${r.receivable.gt(0) ? "text-amber-700" : "text-muted-foreground"}`}>{formatMoney(r.receivable)}</TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">{r.lastEntryAt ? formatDateTime(r.lastEntryAt) : "—"}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </>
  );
}
