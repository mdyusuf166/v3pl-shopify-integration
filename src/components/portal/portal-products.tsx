import { Package } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/common/empty-state";
import { Pagination } from "@/components/common/pagination";
import { SearchFilterBar } from "@/components/common/search-filter-bar";
import { StatusBadge } from "@/components/common/status-badge";
import { PageHeader } from "@/components/layout/page-header";
import { formatInt, formatMoney } from "@/lib/format";
import { listStock, stockTotals } from "@/server/services/inventory";
import { listProducts } from "@/server/services/products";

type Props = {
  /** ALWAYS the session owner id — never a URL parameter. */
  ownerId: string;
  basePath: string;
  searchParams: Record<string, string | string[] | undefined>;
  intro: string;
};

/** Owner-scoped "Products & stock" view shared by the vendor and 3PL portals. */
export async function PortalProducts({ ownerId, basePath, searchParams, intro }: Props) {
  const q = typeof searchParams.q === "string" ? searchParams.q : undefined;
  const page = Number(searchParams.page) || 1;
  const [products, stock, totals] = await Promise.all([listProducts({ ownerId, q, status: "ALL", page }), listStock({ ownerId, q }), stockTotals(ownerId)]);
  const stockByVariant = new Map<string, { code: string; onHand: number; reserved: number }[]>();
  for (const s of stock.items) {
    const list = stockByVariant.get(s.variant.id) ?? [];
    list.push({ code: s.warehouse.code, onHand: s.onHand, reserved: s.reserved });
    stockByVariant.set(s.variant.id, list);
  }
  const hrefFor = (p: number) => `${basePath}${q ? `?q=${encodeURIComponent(q)}${p > 1 ? `&page=${p}` : ""}` : p > 1 ? `?page=${p}` : ""}`;

  return (
    <>
      <PageHeader title="Products & stock" description={intro} />
      <div className="grid gap-4 sm:grid-cols-3">
        {[
          { label: "Units on hand", value: totals.onHand },
          { label: "Reserved for orders", value: totals.reserved },
          { label: "Available", value: totals.available },
        ].map((t) => (
          <Card key={t.label}>
            <CardContent className="pt-4">
              <p className="text-sm text-muted-foreground">{t.label}</p>
              <p className="text-2xl font-semibold tabular-nums">{formatInt(t.value)}</p>
            </CardContent>
          </Card>
        ))}
      </div>
      <SearchFilterBar q={q} placeholder="Search your products or SKUs…" />
      {products.items.length === 0 ? (
        <EmptyState icon={Package} title={q ? "No products match your search" : "No products yet"} description={q ? "Try a different search." : "The V3PL team will add your products and SKUs."} />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead className="text-right">Price</TableHead>
                <TableHead>Stock by warehouse (on hand · reserved)</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {products.items.flatMap((p) =>
                p.variants.map((v, i) => {
                  const rows = stockByVariant.get(v.id) ?? [];
                  return (
                    <TableRow key={v.id}>
                      <TableCell>
                        {i === 0 && <div className="font-medium">{p.name}</div>}
                        {v.name && <div className={i === 0 ? "text-xs text-muted-foreground" : "text-muted-foreground"}>{i === 0 ? v.name : `↳ ${v.name}`}</div>}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{v.sku}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatMoney(v.price, v.currency)}</TableCell>
                      <TableCell className="text-xs tabular-nums">
                        {rows.length === 0 ? <span className="text-muted-foreground">No stock</span> : rows.map((r) => (
                          <div key={r.code}>
                            <span className="font-medium">{r.code}</span> {r.onHand} · {r.reserved}
                          </div>
                        ))}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={v.status} />
                      </TableCell>
                    </TableRow>
                  );
                }),
              )}
            </TableBody>
          </Table>
        </div>
      )}
      <Pagination page={products.page} pageCount={products.pageCount} total={products.total} pageSize={products.pageSize} hrefFor={hrefFor} />
    </>
  );
}
