import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { CustomerForm } from "@/components/customers/customer-form";
import { PageHeader } from "@/components/layout/page-header";
import { requirePortalRole } from "@/server/auth/guards";
import { getCustomer } from "@/server/services/customers";

export default async function PortalEditCustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePortalRole("VENDOR");
  const { id } = await params;
  const customer = await getCustomer({ ownerId: user.ownerId }, id);
  if (!customer) notFound();
  const { orders, owner, ...rest } = customer;
  void orders;
  void owner;
  const values = Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, v === null ? "" : v])) as Record<string, string>;
  return (
    <>
      <div>
        <Link href={`/portal/vendor/customers/${customer.id}`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ChevronLeft className="size-4" /> {customer.name}
        </Link>
      </div>
      <PageHeader title="Edit customer" description="Changing a customer never rewrites the details already stored on past orders." />
      <div className="max-w-5xl">
        <CustomerForm basePath="/portal/vendor/customers" customer={{ ...values, id: customer.id, name: customer.name }} />
      </div>
    </>
  );
}
