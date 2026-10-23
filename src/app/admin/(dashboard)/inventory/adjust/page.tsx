import type { Metadata } from "next";
import { AdjustForm } from "@/components/inventory/adjust-form";
import { PageHeader } from "@/components/layout/page-header";
import { requireRole } from "@/server/auth/guards";
import { listWarehouses } from "@/server/services/warehouses";

export const metadata: Metadata = { title: "Adjust stock" };

export default async function AdjustPage() {
  await requireRole("ADMIN", "WAREHOUSE");
  const warehouses = await listWarehouses();
  return (
    <>
      <PageHeader title="Adjust stock" description="Corrections, damaged and missing units — always with a reason." />
      <div className="max-w-3xl">
        <AdjustForm warehouses={warehouses} />
      </div>
    </>
  );
}
