import type { Metadata } from "next";
import { CustomerList } from "@/components/customers/customer-list";
import { requirePortalRole } from "@/server/auth/guards";

export const metadata: Metadata = { title: "Customers" };

export default async function PortalCustomersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requirePortalRole("VENDOR");
  return <CustomerList scope={{ ownerId: user.ownerId }} basePath="/portal/vendor/customers" searchParams={await searchParams} canCreate description="Your customers — used when creating orders. Only your own records are shown." />;
}
