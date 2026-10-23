import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/page-header";
import { ProductForm } from "@/components/products/product-form";
import { requireRole } from "@/server/auth/guards";
import { listOwnerOptions } from "@/server/services/owners";
import { listWarehouses } from "@/server/services/warehouses";

export const metadata: Metadata = { title: "New product" };

export default async function NewProductPage() {
  await requireRole("ADMIN");
  const [vendors, clients, warehouses] = await Promise.all([listOwnerOptions("VENDOR"), listOwnerOptions("THREEPL_CLIENT"), listWarehouses()]);
  const owners = [...vendors.map((o) => ({ ...o, type: "VENDOR" as const })), ...clients.map((o) => ({ ...o, type: "THREEPL_CLIENT" as const }))];
  return (
    <>
      <PageHeader title="Add product" description="Owner, title and SKU — or turn on variants for options such as colour and size. Initial stock can be received right here." />
      <div className="max-w-5xl">
        <ProductForm owners={owners} warehouses={warehouses.map((w) => ({ id: w.id, code: w.code, name: w.name }))} />
      </div>
    </>
  );
}
