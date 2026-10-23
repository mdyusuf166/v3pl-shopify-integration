import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/page-header";
import { TransferForm } from "@/components/transfers/transfer-form";
import { requireRole } from "@/server/auth/guards";
import { listWarehouses } from "@/server/services/warehouses";

export const metadata: Metadata = { title: "New transfer" };

export default async function NewTransferPage() {
  await requireRole("ADMIN", "WAREHOUSE");
  const warehouses = await listWarehouses();
  return (
    <>
      <PageHeader title="New transfer" description="Move stock from one warehouse to another." />
      <div className="max-w-5xl">
        <TransferForm warehouses={warehouses} />
      </div>
    </>
  );
}
