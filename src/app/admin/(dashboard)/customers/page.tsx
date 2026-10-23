import type { Metadata } from "next";
import { CustomerList } from "@/components/customers/customer-list";
import { requireRole } from "@/server/auth/guards";
import { listOwnerOptions } from "@/server/services/owners";

export const metadata: Metadata = { title: "Customers" };

export default async function CustomersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireRole("ADMIN", "SALES");
  const [sp, vendors, clients] = await Promise.all([searchParams, listOwnerOptions("VENDOR"), listOwnerOptions("THREEPL_CLIENT")]);
  const owners = [...vendors.map((o) => ({ ...o, type: "VENDOR" as const })), ...clients.map((o) => ({ ...o, type: "THREEPL_CLIENT" as const }))];
  return <CustomerList scope={{ ownerId: undefined }} basePath="/admin/customers" searchParams={sp} owners={owners} canCreate description="Operational customer directory for orders — company customers plus each vendor's and 3PL client's own customers." />;
}
