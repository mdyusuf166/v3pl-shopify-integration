import { notFound } from "next/navigation";
import { OrderDetail } from "@/components/orders/order-detail";
import { requirePortalRole } from "@/server/auth/guards";
import { getOrder } from "@/server/services/orders";

export default async function PortalOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePortalRole("VENDOR");
  const { id } = await params;
  // Scope is the session owner: other owners' lines, totals and admin actions are never rendered.
  const order = await getOrder(id, user.ownerId);
  if (!order) notFound();
  return <OrderDetail order={order} scoped canManage={false} canOperate={false} backHref="/portal/vendor/orders" backLabel="Orders" warehouses={[]} locationsByWarehouse={{}} pickable={[]} />;
}
