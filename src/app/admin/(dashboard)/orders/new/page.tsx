import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/page-header";
import { OrderForm } from "@/components/orders/order-form";
import { requireRole } from "@/server/auth/guards";
import { listWarehouses } from "@/server/services/warehouses";

export const metadata: Metadata = { title: "New order" };

export default async function NewOrderPage() {
  await requireRole("ADMIN", "SALES");
  const warehouses = await listWarehouses();
  return (
    <>
      <PageHeader title="New order" description="Search SKUs, set quantities, choose the warehouse — stock is reserved when you save." />
      <OrderForm mode="admin" warehouses={warehouses} successPath="/admin/orders" />
    </>
  );
}
