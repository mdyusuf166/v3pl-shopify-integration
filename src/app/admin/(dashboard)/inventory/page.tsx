import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeftRight, Boxes, History, PackageOpen, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/common/empty-state";
import { NativeSelect } from "@/components/common/native-select";
import { Pagination } from "@/components/common/pagination";
import { SearchFilterBar } from "@/components/common/search-filter-bar";
import { PageHeader } from "@/components/layout/page-header";
import { formatDateTime, formatInt } from "@/lib/format";
import { inventoryListQuerySchema } from "@/lib/validation/inventory";
import { requireStaff } from "@/server/auth/guards";
import { listStock, stockTotals } from "@/server/services/inventory";
import { listOwnerOptions } from "@/server/services/owners";
import { listWarehouses } from "@/server/services/warehouses";

export const metadata: Metadata = { title: "Inventory" };

export default async function InventoryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireStaff();
  const sp = await searchParams;
  const query = inventoryListQuerySchema.parse({
    q: typeof sp.q === "string" ? sp.q : undefined,
    ownerId: typeof sp.ownerId === "string" && sp.ownerId ? sp.ownerId : undefined,
    warehouseId: typeof sp.warehouseId === "string" && sp.warehouseId ? sp.warehouseId : undefined,
    lowStock: sp.lowStock === "1" ? true : undefined,
    page: typeof sp.page === "string" ? sp.page : undefined,
  });
  const [result, totals, warehouses, vendors, clients] = await Promise.all([
    listStock(query),
    stockTotals(),
    listWarehouses(),
    listOwnerOptions("VENDOR"),
    listOwnerOptions("THREEPL_CLIENT"),
  ]);
  const hrefFor = (page: number) => {
    const p = new URLSearchParams();
    if (query.q) p.set("q", query.q);
    if (query.ownerId) p.set("ownerId", query.ownerId);
    if (query.warehouseId) p.set("warehouseId", query.warehouseId);
    if (query.lowStock) p.set("lowStock", "1");
    if (page > 1) p.set("page", String(page));
    const s = p.toString();
    return `/admin/inventory${s ? `?${s}` : ""}`;
  };
  const canOperate = user.role === "ADMIN" || user.role === "WAREHOUSE";

  return (
    <>
      <PageHeader
        title="Inventory"
        description="Stock per SKU and warehouse. Available = on hand − reserved."
        actions={
          <>
            <Button variant="outline" render={<Link href="/admin/inventory/movements" />}>
              <History /> Movements
            </Button>
            {canOperate && (
              <>
                <Button variant="outline" render={<Link href="/admin/inventory/move" />}>
                  <ArrowLeftRight /> Move
                </Button>
                <Button variant="outline" render={<Link href="/admin/inventory/adjust" />}>
                  <SlidersHorizontal /> Adjust
                </Button>
                <Button render={<Link href="/admin/receiving/new" />}>
                  <PackageOpen /> Receive
                </Button>
              </>
            )}
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: "Units on hand", value: totals.onHand },
          { label: "Reserved", value: totals.reserved },
          { label: "Available", value: totals.available },
          { label: "Low stock (≤ 5)", value: totals.lowStock, href: "/admin/inventory?lowStock=1" },
        ].map((t) => (
          <Card key={t.label}>
            <CardContent className="pt-4">
              <p className="text-sm text-muted-foreground">{t.label}</p>
              <p className="text-2xl font-semibold tabular-nums">{t.href ? <Link href={t.href}>{formatInt(t.value)}</Link> : formatInt(t.value)}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <SearchFilterBar q={query.q} placeholder="Search SKU or product…">
        <NativeSelect name="warehouseId" defaultValue={query.warehouseId ?? ""} aria-label="Warehouse filter" className="w-44">
          <option value="">All warehouses</option>
          {warehouses.map((w) => (
            <option key={w.id} value={w.id}>
              {w.code} · {w.name}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect name="ownerId" defaultValue={query.ownerId ?? ""} aria-label="Owner filter" className="w-52">
          <option value="">All owners</option>
          {vendors.length > 0 && (
            <optgroup label="Vendors">
              {vendors.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.businessName}
                </option>
              ))}
            </optgroup>
          )}
          {clients.length > 0 && (
            <optgroup label="3PL clients">
              {clients.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.businessName}
                </option>
              ))}
            </optgroup>
          )}
        </NativeSelect>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="lowStock" value="1" defaultChecked={query.lowStock} className="size-4 rounded border" /> Low stock only
        </label>
      </SearchFilterBar>

      {result.items.length === 0 ? (
        <EmptyState icon={Boxes} title="No stock matches these filters" description="Receive stock or adjust the filters." />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>SKU</TableHead>
                <TableHead>Product</TableHead>
                <TableHead className="hidden lg:table-cell">Owner</TableHead>
                <TableHead>Warehouse</TableHead>
                <TableHead className="text-right">On hand</TableHead>
                <TableHead className="text-right">Reserved</TableHead>
                <TableHead className="text-right">Available</TableHead>
                <TableHead className="hidden xl:table-cell">Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.items.map((r) => {
                const available = r.onHand - r.reserved;
                return (
                  <TableRow key={r.id}>
                    <TableCell>
                      <Link href={`/admin/products/${r.variant.product.id}`} className="font-mono text-xs hover:underline">
                        {r.variant.sku}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <div className="max-w-64 truncate">{r.variant.product.name}</div>
                      {r.variant.name && <div className="text-xs text-muted-foreground">{r.variant.name}</div>}
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground lg:table-cell">{r.variant.product.owner.businessName}</TableCell>
                    <TableCell>{r.warehouse.code}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatInt(r.onHand)}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{formatInt(r.reserved)}</TableCell>
                    <TableCell className={`text-right font-medium tabular-nums ${available <= 5 ? "text-amber-700" : ""}`}>{formatInt(available)}</TableCell>
                    <TableCell className="hidden text-muted-foreground xl:table-cell">{formatDateTime(r.updatedAt)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
      <Pagination page={result.page} pageCount={result.pageCount} total={result.total} pageSize={result.pageSize} hrefFor={hrefFor} />
    </>
  );
}
