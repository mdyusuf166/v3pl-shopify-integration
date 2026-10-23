import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/page-header";
import { OrderForm } from "@/components/orders/order-form";
import { requirePortalRole } from "@/server/auth/guards";
import { listWarehouses } from "@/server/services/warehouses";

export const metadata: Metadata = { title: "New order" };

export default async function PortalNewOrderPage() {
  const user = await requirePortalRole("THREEPL_CLIENT");
  const warehouses = await listWarehouses();
  return (
    <>
      <PageHeader title="New fulfilment order" description="Tell the warehouse what to ship and where. Stock is reserved from your inventory immediately." />
      <OrderForm mode="portal" warehouses={warehouses} ownerId={user.ownerId} successPath="/portal/3pl/orders" />
    </>
  );
}
