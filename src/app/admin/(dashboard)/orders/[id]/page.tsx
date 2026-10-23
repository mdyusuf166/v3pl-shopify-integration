import { notFound } from "next/navigation";
import { OrderDetail } from "@/components/orders/order-detail";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/server/auth/guards";
import { pickableQuantities } from "@/server/services/fulfillment";
import { getOrder, orderDeleteCheck } from "@/server/services/orders";
import { shopifyOutboundSummary } from "@/server/services/shopify-order-request";
import { listLocations, listWarehouses } from "@/server/services/warehouses";

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireStaff();
  const { id } = await params;
  const [order, warehouses] = await Promise.all([getOrder(id), listWarehouses()]);
  if (!order) notFound();
  const pickable = (await pickableQuantities(prisma, id)).filter((i) => i.pickable > 0).map((i) => ({ orderItemId: i.id, sku: i.sku, title: [i.title, i.variantTitle].filter(Boolean).join(" · "), pickable: i.pickable }));
  const locationsByWarehouse = Object.fromEntries(await Promise.all(warehouses.map(async (w) => [w.id, await listLocations(w.id)] as const)));
  const deleteCheck = user.role === "ADMIN" ? await orderDeleteCheck(id) : null;
  const shopifyOutbound = order.source === "MANUAL" || order.shopifyOutboundStatus ? await shopifyOutboundSummary(id) : null;
  return (
    <OrderDetail
      order={order}
      scoped={false}
      canManage={user.role === "ADMIN" || user.role === "SALES"}
      canOperate={user.role === "ADMIN" || user.role === "WAREHOUSE"}
      backHref="/admin/orders"
      backLabel="Orders"
      warehouses={warehouses}
      locationsByWarehouse={locationsByWarehouse}
      pickable={pickable}
      deleteBlockers={deleteCheck?.blockers}
      shopifyOutbound={shopifyOutbound}
    />
  );
}
