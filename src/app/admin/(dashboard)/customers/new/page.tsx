import type { Metadata } from "next";
import { CustomerForm } from "@/components/customers/customer-form";
import { PageHeader } from "@/components/layout/page-header";
import { requireRole } from "@/server/auth/guards";
import { listOwnerOptions } from "@/server/services/owners";

export const metadata: Metadata = { title: "New customer" };

export default async function NewCustomerPage() {
  await requireRole("ADMIN", "SALES");
  const [vendors, clients] = await Promise.all([listOwnerOptions("VENDOR"), listOwnerOptions("THREEPL_CLIENT")]);
  const owners = [...vendors.map((o) => ({ ...o, type: "VENDOR" as const })), ...clients.map((o) => ({ ...o, type: "THREEPL_CLIENT" as const }))];
  return (
    <>
      <PageHeader title="Add customer" description="Contact and address details used when creating orders." />
      <div className="max-w-5xl">
        <CustomerForm basePath="/admin/customers" owners={owners} />
      </div>
    </>
  );
}
