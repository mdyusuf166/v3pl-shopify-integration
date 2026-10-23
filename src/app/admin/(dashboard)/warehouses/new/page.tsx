import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/page-header";
import { WarehouseForm } from "@/components/warehouses/warehouse-form";
import { requireRole } from "@/server/auth/guards";

export const metadata: Metadata = { title: "New warehouse" };

export default async function NewWarehousePage() {
  await requireRole("ADMIN");
  return (
    <>
      <PageHeader title="New warehouse" />
      <div className="max-w-3xl">
        <WarehouseForm />
      </div>
    </>
  );
}
