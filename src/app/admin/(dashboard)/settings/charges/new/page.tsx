import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/page-header";
import { ChargeRuleForm } from "@/components/finance/charge-rule-form";
import { requireRole } from "@/server/auth/guards";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = { title: "New charge rule" };

export default async function NewChargeRulePage() {
  await requireRole("ADMIN");
  const owners = await prisma.owner.findMany({ where: { status: "ACTIVE" }, select: { id: true, businessName: true, code: true, type: true }, orderBy: [{ type: "asc" }, { businessName: "asc" }] });
  return (
    <>
      <PageHeader title="New charge rule" description="Define what is charged, to whom, and on which basis." />
      <ChargeRuleForm owners={owners} />
    </>
  );
}
