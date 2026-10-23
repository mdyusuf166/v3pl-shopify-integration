import type { Metadata } from "next";
import Link from "next/link";
import { Download, Plus, ShoppingCart } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/common/empty-state";
import { NativeSelect } from "@/components/common/native-select";
import { Pagination } from "@/components/common/pagination";
import { SearchFilterBar } from "@/components/common/search-filter-bar";
import { PageHeader } from "@/components/layout/page-header";
import { OrdersTable } from "@/components/orders/orders-table";
import { requirePortalRole } from "@/server/auth/guards";
import { listOrders } from "@/server/services/orders";

export const metadata: Metadata = { title: "Orders" };

export default async function PortalOrdersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requirePortalRole("THREEPL_CLIENT");
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q : undefined;
  const status = (["OPEN", "COMPLETED", "CANCELLED", "ALL"].includes(String(sp.status)) ? String(sp.status) : "ALL") as "OPEN" | "COMPLETED" | "CANCELLED" | "ALL";
  const page = Number(sp.page) || 1;
  const result = await listOrders({ scopeOwnerId: user.ownerId, q, status, page });
  const hrefFor = (p: number) => `/portal/3pl/orders?status=${status}${q ? `&q=${encodeURIComponent(q)}` : ""}${p > 1 ? `&page=${p}` : ""}`;
  return (
    <>
      <PageHeader
        title="Orders"
        description="Fulfilment orders you asked the warehouse to ship, with their picking, packing and shipping progress."
        actions={
          <>
            <Button variant="outline" render={<a href="/api/orders/export?status=ALL" />}>
              <Download /> Export CSV
            </Button>
            <Button render={<Link href="/portal/3pl/orders/new" />}>
              <Plus /> New order
            </Button>
          </>
        }
      />
      <SearchFilterBar q={q} placeholder="Order #, recipient, SKU, tracking…">
        <NativeSelect name="status" defaultValue={status} className="w-40" aria-label="Status">
          <option value="ALL">All</option>
          <option value="OPEN">Open</option>
          <option value="COMPLETED">Completed</option>
          <option value="CANCELLED">Cancelled</option>
        </NativeSelect>
      </SearchFilterBar>
      {result.items.length === 0 ? <EmptyState icon={ShoppingCart} title="No orders yet" description="Submit your first fulfilment order." action={<Button render={<Link href="/portal/3pl/orders/new" />}>New order</Button>} /> : <OrdersTable rows={result.items} basePath="/portal/3pl/orders" scoped />}
      <Pagination page={result.page} pageCount={result.pageCount} total={result.total} pageSize={result.pageSize} hrefFor={hrefFor} />
    </>
  );
}
