import Link from "next/link";
import { ArrowRight, Scale } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateTime, formatMoney } from "@/lib/format";
import { LEDGER_TYPE_LABELS } from "@/lib/validation/finance";
import type { OwnerBalance } from "@/server/services/finance";

type Account = OwnerBalance["payable"];

function Side({ title, hint, acc, compact }: { title: string; hint: string; acc: Account; compact: boolean }) {
  const types = Object.entries(acc.byType) as [keyof typeof LEDGER_TYPE_LABELS, { increased: { toString(): string }; decreased: { toString(): string } }][];
  return (
    <div className="min-w-0">
      <p className="text-muted-foreground">{title}</p>
      <p className="text-2xl font-semibold tabular-nums" data-slot={`balance-${title.toLowerCase().split(" ")[0]}`}>
        {formatMoney(acc.open)}
      </p>
      {!compact && (
        <>
          <p className="text-xs text-muted-foreground">{hint}</p>
          {types.length > 0 && (
            <dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 text-xs">
              {types.map(([t, v]) => (
                <Row key={t} label={LEDGER_TYPE_LABELS[t]} inc={v.increased} dec={v.decreased} />
              ))}
            </dl>
          )}
        </>
      )}
    </div>
  );
}

function Row({ label, inc, dec }: { label: string; inc: { toString(): string }; dec: { toString(): string } }) {
  const i = Number(inc.toString());
  const d = Number(dec.toString());
  return (
    <>
      {i > 0 && (
        <>
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="text-right tabular-nums">+{formatMoney(inc)}</dd>
        </>
      )}
      {d > 0 && (
        <>
          <dt className="text-muted-foreground">{label === "Payment" ? "Payments" : `${label} reversed`}</dt>
          <dd className="text-right tabular-nums">−{formatMoney(dec)}</dd>
        </>
      )}
    </>
  );
}

/**
 * Operational balance: payable and receivable shown side by side and never netted (D-064).
 * Shared by the admin owner profile, the portal dashboard and the finance pages.
 */
export function BalanceCard({ balance, href, ownerLabel = "owner", ownerType, compact = false }: { balance: OwnerBalance; href?: string; ownerLabel?: string; ownerType?: "VENDOR" | "THREEPL_CLIENT"; compact?: boolean }) {
  const payableHint = ownerType === "THREEPL_CLIENT" ? `Product value of ${ownerLabel === "you" ? "your" : "their"} goods shipped, plus adjustments, minus payments made` : ownerType === "VENDOR" ? "Manually recorded payables for received inventory, plus adjustments, minus payments made" : "Product value / recorded payables, plus adjustments, minus payments made";
  return (
    <Card data-slot="balance-card">
      <CardHeader className={compact ? "pb-2" : undefined}>
        <CardTitle className="flex items-center gap-2 text-base">
          <Scale className="size-4 text-muted-foreground" /> Operational balance
        </CardTitle>
        {!compact && <CardDescription>Two separate obligations from the settlement ledger. They are not netted against each other. Not an accounting statement.</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="grid gap-4 sm:grid-cols-2">
          <Side title={`Payable to ${ownerLabel}`} hint={payableHint} acc={balance.payable} compact={compact} />
          <Side title={`Receivable from ${ownerLabel}`} hint="Operational charges, plus adjustments, minus payments received" acc={balance.receivable} compact={compact} />
        </div>
        {!compact && (
          <p className="text-xs text-muted-foreground">
            {balance.entries} entr{balance.entries === 1 ? "y" : "ies"}
            {balance.lastEntryAt ? ` · last ${formatDateTime(balance.lastEntryAt)}` : ""}
          </p>
        )}
        {href && (
          <Button variant="outline" size="sm" render={<Link href={href} />}>
            Ledger & charges <ArrowRight />
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
