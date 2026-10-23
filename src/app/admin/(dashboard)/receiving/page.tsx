import type { Metadata } from "next";
import Link from "next/link";
import { PackageOpen, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/common/empty-state";
import { NativeSelect } from "@/components/common/native-select";
import { Pagination } from "@/components/common/pagination";
import { SearchFilterBar } from "@/components/common/search-filter-bar";
import { PageHeader } from "@/components/layout/page-header";
import { formatDateTime, formatInt } from "@/lib/format";
import { requireRole } from "@/server/auth/guards";
import { listOwnerOptions } from "@/server/services/owners";
import { listReceivings } from "@/server/services/receiving";
import { listWarehouses } from "@/server/services/warehouses";

export const metadata: Metadata = { title: "Receiving" };

export default async function ReceivingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireRole("ADMIN", "WAREHOUSE");
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q : undefined;
  const ownerId = typeof sp.ownerId === "string" && sp.ownerId ? sp.ownerId : undefined;
  const warehouseId = typeof sp.warehouseId === "string" && sp.warehouseId ? sp.warehouseId : undefined;
  const page = Number(sp.page) || 1;
  const [result, warehouses, vendors, clients] = await Promise.all([listReceivings({ q, ownerId, warehouseId, page }), listWarehouses(true), listOwnerOptions("VENDOR"), listOwnerOptions("THREEPL_CLIENT")]);
  const hrefFor = (p: number) => {
    const u = new URLSearchParams();
    if (q) u.set("q", q);
    if (ownerId) u.set("ownerId", ownerId);
    if (warehouseId) u.set("warehouseId", warehouseId);
    if (p > 1) u.set("page", String(p));
    const s = u.toString();
    return `/admin/receiving${s ? `?${s}` : ""}`;
  };
  const newButton = (
    <Button render={<Link href="/admin/receiving/new" />}>
      <Plus /> Receive stock
    </Button>
  );

  return (
    <>
      <PageHeader title="Receiving" description="Goods booked into the warehouse. Each receipt creates RECEIVE entries in the ledger." actions={newButton} />
      <SearchFilterBar q={q} placeholder="Search reference or SKU…">
        <NativeSelect name="warehouseId" defaultValue={warehouseId ?? ""} aria-label="Warehouse filter" className="w-40">
          <option value="">All warehouses</option>
          {warehouses.map((w) => (
            <option key={w.id} value={w.id}>
              {w.code}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect name="ownerId" defaultValue={ownerId ?? ""} aria-label="Owner filter" className="w-48">
          <option value="">All owners</option>
          {[...vendors, ...clients].map((o) => (
            <option key={o.id} value={o.id}>
              {o.businessName}
            </option>
          ))}
        </NativeSelect>
      </SearchFilterBar>
      {result.items.length === 0 ? (
        <EmptyState icon={PackageOpen} title="No receipts yet" description="Record the first delivery to put stock into a warehouse." action={newButton} />
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Received</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead>Warehouse</TableHead>
                <TableHead className="text-right">Lines</TableHead>
                <TableHead className="text-right">Units</TableHead>
                <TableHead className="hidden md:table-cell">By</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.items.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="whitespace-nowrap">
                    <Link href={`/admin/receiving/${r.id}`} className="hover:underline">
                      {formatDateTime(r.receivedAt)}
                    </Link>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{r.reference ?? "—"}</TableCell>
                  <TableCell>{r.owner.businessName}</TableCell>
                  <TableCell>{r.warehouse.code}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.lineCount}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatInt(r.units)}</TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">{r.user.name}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <Pagination page={result.page} pageCount={result.pageCount} total={result.total} pageSize={result.pageSize} hrefFor={hrefFor} />
    </>
  );
}
