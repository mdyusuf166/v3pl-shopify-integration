import type { Metadata } from "next";
import { MoveForm } from "@/components/inventory/move-form";
import { PageHeader } from "@/components/layout/page-header";
import { requireRole } from "@/server/auth/guards";
import { listWarehouses } from "@/server/services/warehouses";

export const metadata: Metadata = { title: "Move stock" };

export default async function MovePage() {
  await requireRole("ADMIN", "WAREHOUSE");
  const warehouses = await listWarehouses();
  return (
    <>
      <PageHeader title="Move stock" description="Relocate units between locations of the same warehouse." />
      <div className="max-w-3xl">
        <MoveForm warehouses={warehouses} />
      </div>
    </>
  );
}
