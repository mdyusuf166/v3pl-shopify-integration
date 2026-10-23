import type { Metadata } from "next";
import { CustomerForm } from "@/components/customers/customer-form";
import { PageHeader } from "@/components/layout/page-header";
import { requirePortalRole } from "@/server/auth/guards";

export const metadata: Metadata = { title: "New customer" };

export default async function PortalNewCustomerPage() {
  await requirePortalRole("THREEPL_CLIENT");
  return (
    <>
      <PageHeader title="Add customer" description="Contact and address details used when creating orders." />
      <div className="max-w-5xl">
        <CustomerForm basePath="/portal/3pl/customers" />
      </div>
    </>
  );
}
