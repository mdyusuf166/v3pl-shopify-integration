import { History } from "lucide-react";
import { EmptyState } from "@/components/common/empty-state";
import { Pagination } from "@/components/common/pagination";
import { SearchFilterBar } from "@/components/common/search-filter-bar";
import { MovementsTable } from "@/components/inventory/movements-table";
import { PageHeader } from "@/components/layout/page-header";
import { listMovements } from "@/server/services/inventory";

type Props = { ownerId: string; basePath: string; searchParams: Record<string, string | string[] | undefined> };

/** Owner-scoped inventory history for the portals. */
export async function PortalMovements({ ownerId, basePath, searchParams }: Props) {
  const q = typeof searchParams.q === "string" ? searchParams.q : undefined;
  const page = Number(searchParams.page) || 1;
  const result = await listMovements({ ownerId, q, page });
  const hrefFor = (p: number) => `${basePath}${q ? `?q=${encodeURIComponent(q)}${p > 1 ? `&page=${p}` : ""}` : p > 1 ? `?page=${p}` : ""}`;
  return (
    <>
      <PageHeader title="Inventory history" description="Every receipt, reservation, shipment, return, adjustment and transfer affecting your stock." />
      <SearchFilterBar q={q} placeholder="Search SKU or product…" />
      {result.items.length === 0 ? <EmptyState icon={History} title="No movements yet" /> : <MovementsTable rows={result.items} hideOwner linkBase={null} />}
      <Pagination page={result.page} pageCount={result.pageCount} total={result.total} pageSize={result.pageSize} hrefFor={hrefFor} />
    </>
  );
}
