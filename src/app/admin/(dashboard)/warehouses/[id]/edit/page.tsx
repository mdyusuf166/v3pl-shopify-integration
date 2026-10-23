import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { WarehouseForm } from "@/components/warehouses/warehouse-form";
import { requireRole } from "@/server/auth/guards";
import { getWarehouse } from "@/server/services/warehouses";

export default async function EditWarehousePage({ params }: { params: Promise<{ id: string }> }) {
  await requireRole("ADMIN");
  const { id } = await params;
  const w = await getWarehouse(id);
  if (!w) notFound();
  return (
    <>
      <div>
        <Link href={`/admin/warehouses/${w.id}`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ChevronLeft className="size-4" /> {w.name}
        </Link>
      </div>
      <PageHeader title="Edit warehouse" description={w.name} />
      <div className="max-w-3xl">
        <WarehouseForm
          warehouse={{
            id: w.id,
            code: w.code,
            name: w.name,
            addressLine1: w.addressLine1 ?? "",
            addressLine2: w.addressLine2 ?? "",
            city: w.city ?? "",
            state: w.state ?? "",
            postalCode: w.postalCode ?? "",
            country: w.country ?? "",
            notes: w.notes ?? "",
          }}
        />
      </div>
    </>
  );
}
