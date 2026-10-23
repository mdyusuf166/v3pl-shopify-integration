import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft, History } from "lucide-react";
import { EmptyState } from "@/components/common/empty-state";
import { NativeSelect } from "@/components/common/native-select";
import { Pagination } from "@/components/common/pagination";
import { SearchFilterBar } from "@/components/common/search-filter-bar";
import { MovementsTable } from "@/components/inventory/movements-table";
import { PageHeader } from "@/components/layout/page-header";
import { MOVEMENT_TYPE_LABELS } from "@/lib/format";
import { movementListQuerySchema } from "@/lib/validation/inventory";
import { requireStaff } from "@/server/auth/guards";
import type { InventoryTransactionType } from "@/generated/prisma/client";
import { listMovements } from "@/server/services/inventory";
import { listOwnerOptions } from "@/server/services/owners";
import { listWarehouses } from "@/server/services/warehouses";

export const metadata: Metadata = { title: "Inventory movements" };

export default async function MovementsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireStaff();
  const sp = await searchParams;
  const query = movementListQuerySchema.parse({
    q: typeof sp.q === "string" ? sp.q : undefined,
    ownerId: typeof sp.ownerId === "string" && sp.ownerId ? sp.ownerId : undefined,
    warehouseId: typeof sp.warehouseId === "string" && sp.warehouseId ? sp.warehouseId : undefined,
    type: typeof sp.type === "string" && sp.type in MOVEMENT_TYPE_LABELS ? sp.type : undefined,
    page: typeof sp.page === "string" ? sp.page : undefined,
  });
  const [result, warehouses, vendors, clients] = await Promise.all([
    listMovements({ ...query, type: query.type as InventoryTransactionType | undefined }),
    listWarehouses(true),
    listOwnerOptions("VENDOR"),
    listOwnerOptions("THREEPL_CLIENT"),
  ]);
  const hrefFor = (page: number) => {
    const p = new URLSearchParams();
    if (query.q) p.set("q", query.q);
    if (query.ownerId) p.set("ownerId", query.ownerId);
    if (query.warehouseId) p.set("warehouseId", query.warehouseId);
    if (query.type) p.set("type", query.type);
    if (page > 1) p.set("page", String(page));
    const s = p.toString();
    return `/admin/inventory/movements${s ? `?${s}` : ""}`;
  };

  return (
    <>
      <div>
        <Link href="/admin/inventory" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ChevronLeft className="size-4" /> Inventory
        </Link>
      </div>
      <PageHeader title="Inventory movements" description="The complete, append-only ledger. Every change to stock is listed here with who, when and why." />
      <SearchFilterBar q={query.q} placeholder="Search SKU or product…">
        <NativeSelect name="type" defaultValue={query.type ?? ""} aria-label="Type filter" className="w-44">
          <option value="">All types</option>
          {Object.entries(MOVEMENT_TYPE_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect name="warehouseId" defaultValue={query.warehouseId ?? ""} aria-label="Warehouse filter" className="w-40">
          <option value="">All warehouses</option>
          {warehouses.map((w) => (
            <option key={w.id} value={w.id}>
              {w.code}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect name="ownerId" defaultValue={query.ownerId ?? ""} aria-label="Owner filter" className="w-48">
          <option value="">All owners</option>
          {[...vendors, ...clients].map((o) => (
            <option key={o.id} value={o.id}>
              {o.businessName}
            </option>
          ))}
        </NativeSelect>
      </SearchFilterBar>
      {result.items.length === 0 ? <EmptyState icon={History} title="No movements match these filters" /> : <MovementsTable rows={result.items} />}
      <Pagination page={result.page} pageCount={result.pageCount} total={result.total} pageSize={result.pageSize} hrefFor={hrefFor} />
    </>
  );
}
