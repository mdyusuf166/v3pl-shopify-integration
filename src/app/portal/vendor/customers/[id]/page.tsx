import { notFound } from "next/navigation";
import { CustomerDetail } from "@/components/customers/customer-detail";
import { requirePortalRole } from "@/server/auth/guards";
import { getCustomer } from "@/server/services/customers";

export default async function PortalCustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePortalRole("VENDOR");
  const { id } = await params;
  const customer = await getCustomer({ ownerId: user.ownerId }, id);
  if (!customer) notFound();
  return <CustomerDetail customer={customer} basePath="/portal/vendor/customers" ordersPath="/portal/vendor/orders" canEdit scopeOwnerId={user.ownerId} />;
}
