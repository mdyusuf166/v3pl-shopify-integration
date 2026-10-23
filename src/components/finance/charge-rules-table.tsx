"use client";

import Link from "next/link";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Receipt, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/common/empty-state";
import { formatMoney } from "@/lib/format";
import { CHARGE_BASIS_LABELS, CHARGE_TYPE_LABELS } from "@/lib/validation/finance";
import { deleteChargeRuleAction, setChargeRuleActiveAction } from "@/server/actions/finance";

export type ChargeRuleRow = {
  id: string;
  name: string;
  chargeType: keyof typeof CHARGE_TYPE_LABELS;
  basis: keyof typeof CHARGE_BASIS_LABELS;
  amount: string;
  currency: string;
  active: boolean;
  ownerType: "VENDOR" | "THREEPL_CLIENT" | null;
  owner: { businessName: string; code: string } | null;
  minWeightGrams: number | null;
  maxWeightGrams: number | null;
  minLongestCm: string | null;
  maxLongestCm: string | null;
  applied: number;
};

const range = (min: string | number | null, max: string | number | null, unit: string) => (min === null && max === null ? null : `${min ?? "0"}–${max ?? "∞"} ${unit}`);

export function ChargeRulesTable({ rules }: { rules: ChargeRuleRow[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  if (rules.length === 0) return <EmptyState icon={Receipt} title="No charge rules yet" description="Create the first rule, then enable “Apply operational charges” on the vendors / 3PL clients it should apply to." />;

  const toggle = (r: ChargeRuleRow) =>
    startTransition(async () => {
      const res = await setChargeRuleActiveAction(r.id, !r.active);
      if (!res.ok) toast.error(res.error);
      else toast.success(r.active ? "Rule deactivated — future shipments skip it" : "Rule activated");
      router.refresh();
    });
  const remove = (r: ChargeRuleRow) => {
    if (!confirm(`Delete "${r.name}"? Only unused rules can be deleted.`)) return;
    startTransition(async () => {
      const res = await deleteChargeRuleAction(r.id);
      if (!res.ok) toast.error(res.error);
      else toast.success("Rule deleted");
      router.refresh();
    });
  };

  return (
    <Table data-slot="charge-rules">
      <TableHeader>
        <TableRow>
          <TableHead>Rule</TableHead>
          <TableHead>Type</TableHead>
          <TableHead>Basis</TableHead>
          <TableHead className="text-right">Amount</TableHead>
          <TableHead>Applies to</TableHead>
          <TableHead>Ranges</TableHead>
          <TableHead className="text-right">Applied</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="w-0" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rules.map((r) => {
          const w = range(r.minWeightGrams, r.maxWeightGrams, "g");
          const d = range(r.minLongestCm, r.maxLongestCm, "cm");
          return (
            <TableRow key={r.id} className={r.active ? undefined : "text-muted-foreground"}>
              <TableCell className="font-medium">{r.name}</TableCell>
              <TableCell>{CHARGE_TYPE_LABELS[r.chargeType]}</TableCell>
              <TableCell>{CHARGE_BASIS_LABELS[r.basis]}</TableCell>
              <TableCell className="text-right tabular-nums">{formatMoney(r.amount, r.currency)}</TableCell>
              <TableCell>{r.owner ? `${r.owner.businessName} (${r.owner.code})` : r.ownerType === "VENDOR" ? "Vendors" : r.ownerType === "THREEPL_CLIENT" ? "3PL clients" : "All businesses"}</TableCell>
              <TableCell className="text-sm">{[w && `weight ${w}`, d && `longest side ${d}`].filter(Boolean).join(" · ") || "—"}</TableCell>
              <TableCell className="text-right tabular-nums">{r.applied}</TableCell>
              <TableCell>
                <Badge variant="outline" className={r.active ? "border-emerald-200 bg-emerald-50 text-emerald-700" : ""}>
                  {r.active ? "Active" : "Inactive"}
                </Badge>
              </TableCell>
              <TableCell className="whitespace-nowrap text-right">
                <Button variant="ghost" size="sm" disabled={pending} onClick={() => toggle(r)}>
                  {r.active ? "Deactivate" : "Activate"}
                </Button>
                <Button variant="ghost" size="icon" aria-label="Edit" render={<Link href={`/admin/settings/charges/${r.id}`} />}>
                  <Pencil />
                </Button>
                <Button variant="ghost" size="icon" aria-label="Delete" disabled={pending || r.applied > 0} title={r.applied > 0 ? "Applied rules cannot be deleted — deactivate instead" : undefined} onClick={() => remove(r)}>
                  <Trash2 />
                </Button>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
