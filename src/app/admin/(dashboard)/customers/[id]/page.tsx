import { notFound } from "next/navigation";
import { CustomerDetail } from "@/components/customers/customer-detail";
import { requireRole } from "@/server/auth/guards";
import { getCustomer } from "@/server/services/customers";

export default async function CustomerPage({ params }: { params: Promise<{ id: string }> }) {
  await requireRole("ADMIN", "SALES");
  const { id } = await params;
  const customer = await getCustomer({ ownerId: undefined }, id);
  if (!customer) notFound();
  return <CustomerDetail customer={customer} basePath="/admin/customers" ordersPath="/admin/orders" canEdit showOwner />;
}
