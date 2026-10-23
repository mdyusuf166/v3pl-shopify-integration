import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/page-header";
import { ReceivingForm } from "@/components/receiving/receiving-form";
import { requireRole } from "@/server/auth/guards";
import { listOwnerOptions } from "@/server/services/owners";
import { listWarehouses } from "@/server/services/warehouses";

export const metadata: Metadata = { title: "Receive stock" };

export default async function NewReceivingPage() {
  await requireRole("ADMIN", "WAREHOUSE");
  const [vendors, clients, warehouses] = await Promise.all([listOwnerOptions("VENDOR"), listOwnerOptions("THREEPL_CLIENT"), listWarehouses()]);
  const owners = [...vendors.map((o) => ({ ...o, type: "VENDOR" as const })), ...clients.map((o) => ({ ...o, type: "THREEPL_CLIENT" as const }))];
  return (
    <>
      <PageHeader title="Receive stock" description="Book a delivery into a warehouse. Posting is immediate and auditable." />
      <div className="max-w-5xl">
        <ReceivingForm owners={owners} warehouses={warehouses} />
      </div>
    </>
  );
}
