import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/layout/page-header";
import { ChargeRulesTable, type ChargeRuleRow } from "@/components/finance/charge-rules-table";
import { requireRole } from "@/server/auth/guards";
import { listChargeRules } from "@/server/services/charges";

export const metadata: Metadata = { title: "Operational charges" };

export default async function ChargesSettingsPage() {
  await requireRole("ADMIN");
  const rules = await listChargeRules();
  const rows: ChargeRuleRow[] = rules.map((r) => ({ id: r.id, name: r.name, chargeType: r.chargeType, basis: r.basis, amount: r.amount.toString(), currency: r.currency, active: r.active, ownerType: r.ownerType, owner: r.owner ? { businessName: r.owner.businessName, code: r.owner.code } : null, minWeightGrams: r.minWeightGrams, maxWeightGrams: r.maxWeightGrams, minLongestCm: r.minLongestCm?.toString() ?? null, maxLongestCm: r.maxLongestCm?.toString() ?? null, applied: r._count.charges }));
  return (
    <>
      <div>
        <Link href="/admin/settings" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ChevronLeft className="size-4" /> Settings
        </Link>
      </div>
      <PageHeader
        title="Operational charges"
        description="Rules applied when shipments are made for businesses with charges enabled. Recorded charges keep the amount in force at the time; editing a rule only affects future shipments."
        actions={
          <Button render={<Link href="/admin/settings/charges/new" />}>
            <Plus /> New rule
          </Button>
        }
      />
      <ChargeRulesTable rules={rows} />
    </>
  );
}
