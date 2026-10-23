import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { CustomerForm } from "@/components/customers/customer-form";
import { PageHeader } from "@/components/layout/page-header";
import { requireRole } from "@/server/auth/guards";
import { getCustomer } from "@/server/services/customers";
import { listOwnerOptions } from "@/server/services/owners";

export default async function EditCustomerPage({ params }: { params: Promise<{ id: string }> }) {
  await requireRole("ADMIN", "SALES");
  const { id } = await params;
  const [customer, vendors, clients] = await Promise.all([getCustomer({ ownerId: undefined }, id), listOwnerOptions("VENDOR"), listOwnerOptions("THREEPL_CLIENT")]);
  if (!customer) notFound();
  const owners = [...vendors.map((o) => ({ ...o, type: "VENDOR" as const })), ...clients.map((o) => ({ ...o, type: "THREEPL_CLIENT" as const }))];
  const { orders, owner, ...rest } = customer;
  void owner;
  const values = Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, v === null ? "" : v])) as Record<string, string>;
  return (
    <>
      <div>
        <Link href={`/admin/customers/${customer.id}`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ChevronLeft className="size-4" /> {customer.name}
        </Link>
      </div>
      <PageHeader title="Edit customer" description="Changing a customer never rewrites the details already stored on past orders." />
      <div className="max-w-5xl">
        <CustomerForm basePath="/admin/customers" owners={owners} ownerLocked={orders.length > 0} customer={{ ...values, id: customer.id, ownerId: customer.ownerId ?? "", name: customer.name }} />
      </div>
    </>
  );
}
