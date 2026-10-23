import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/layout/page-header";
import { ChargeRuleForm } from "@/components/finance/charge-rule-form";
import { requireRole } from "@/server/auth/guards";
import { prisma } from "@/lib/prisma";
import { getChargeRule } from "@/server/services/charges";

export const metadata: Metadata = { title: "Edit charge rule" };

export default async function EditChargeRulePage({ params }: { params: Promise<{ id: string }> }) {
  await requireRole("ADMIN");
  const { id } = await params;
  const [rule, owners] = await Promise.all([getChargeRule(id), prisma.owner.findMany({ where: { status: "ACTIVE" }, select: { id: true, businessName: true, code: true, type: true }, orderBy: [{ type: "asc" }, { businessName: "asc" }] })]);
  if (!rule) notFound();
  return (
    <>
      <PageHeader title={rule.name} description="Changes apply to future shipments only." />
      <ChargeRuleForm
        owners={owners}
        appliedCount={rule._count.charges}
        rule={{ id: rule.id, name: rule.name, chargeType: rule.chargeType, basis: rule.basis, amount: rule.amount.toString(), active: rule.active, ownerType: rule.ownerType ?? "", ownerId: rule.ownerId ?? "", minWeightGrams: rule.minWeightGrams ?? "", maxWeightGrams: rule.maxWeightGrams ?? "", minLongestCm: rule.minLongestCm?.toString() ?? "", maxLongestCm: rule.maxLongestCm?.toString() ?? "", notes: rule.notes ?? "" }}
      />
    </>
  );
}
