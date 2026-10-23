import type { Metadata } from "next";
import Link from "next/link";
import { Download, Package, Plus, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/common/empty-state";
import { NativeSelect } from "@/components/common/native-select";
import { Pagination } from "@/components/common/pagination";
import { SearchFilterBar } from "@/components/common/search-filter-bar";
import { StatusBadge } from "@/components/common/status-badge";
import { PageHeader } from "@/components/layout/page-header";
import { ProductRowActions } from "@/components/products/product-row-actions";
import { optimizedImageUrl } from "@/lib/cloudinary-url";
import { formatInt } from "@/lib/format";
import { productListQuerySchema } from "@/lib/validation/products";
import { requireStaff } from "@/server/auth/guards";
import { listOwnerOptions } from "@/server/services/owners";
import { inventorySummary, listProducts, productDeleteCheck } from "@/server/services/products";

export const metadata: Metadata = { title: "Products" };

export default async function ProductsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireStaff();
  const sp = await searchParams;
  const query = productListQuerySchema.parse({
    q: typeof sp.q === "string" ? sp.q : undefined,
    ownerId: typeof sp.ownerId === "string" && sp.ownerId ? sp.ownerId : undefined,
    status: typeof sp.status === "string" ? sp.status : undefined,
    page: typeof sp.page === "string" ? sp.page : undefined,
  });
  const canEdit = user.role === "ADMIN";
  const [result, vendors, clients] = await Promise.all([listProducts(query), listOwnerOptions("VENDOR"), listOwnerOptions("THREEPL_CLIENT")]);
  const deleteChecks = canEdit ? new Map(await Promise.all(result.items.map(async (p) => [p.id, await productDeleteCheck(p.id)] as const))) : new Map();

  const params = (page: number) => {
    const p = new URLSearchParams();
    if (query.q) p.set("q", query.q);
    if (query.ownerId) p.set("ownerId", query.ownerId);
    if (query.status !== "ACTIVE") p.set("status", query.status);
    if (page > 1) p.set("page", String(page));
    return p.toString();
  };
  const hrefFor = (page: number) => `/admin/products${params(page) ? `?${params(page)}` : ""}`;
  const exportHref = `/api/products/export?${new URLSearchParams({ status: query.status, ...(query.q ? { q: query.q } : {}), ...(query.ownerId ? { ownerId: query.ownerId } : {}) }).toString()}`;

  const newButton = canEdit ? (
    <Button render={<Link href="/admin/products/new" />}>
      <Plus /> Add product
    </Button>
  ) : null;

  return (
    <>
      <PageHeader
        title="Products"
        description="Products and their variants. The SKU is the identity used by inventory, orders, fulfilment and Shopify."
        actions={
          <>
            <Button variant="outline" render={<a href={exportHref} />}>
              <Download /> Export
            </Button>
            {canEdit && (
              <Button variant="outline" render={<Link href="/admin/imports#products" />}>
                <Upload /> Import
              </Button>
            )}
            {newButton}
          </>
        }
      />
      <SearchFilterBar q={query.q} placeholder="Search title, SKU or barcode…">
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
        <NativeSelect name="status" defaultValue={query.status} aria-label="Status filter" className="w-36">
          <option value="ACTIVE">Active</option>
          <option value="ARCHIVED">Archived</option>
          <option value="ALL">All statuses</option>
        </NativeSelect>
      </SearchFilterBar>

      {result.items.length === 0 ? (
        <EmptyState
          icon={Package}
          title={query.q || query.ownerId || query.status !== "ACTIVE" ? "No products match these filters" : "No products yet"}
          description={query.q ? "Try a different search or clear the filters." : "Add a product or import a Shopify product CSV."}
          action={!query.q ? newButton ?? undefined : undefined}
        />
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12" />
                <TableHead>Product</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Variants</TableHead>
                <TableHead>Inventory</TableHead>
                <TableHead className="w-12 text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.items.map((p) => {
                const inv = inventorySummary(p.variants);
                const active = p.variants.filter((v) => v.status === "ACTIVE").length;
                const simple = p.options.length === 0 && p.variants.length === 1;
                return (
                  <TableRow key={p.id}>
                    <TableCell>
                      {p.images[0] ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={optimizedImageUrl(p.images[0].url, 80)} alt="" className="size-9 rounded-md border object-cover" />
                      ) : (
                        <div className="flex size-9 items-center justify-center rounded-md border bg-muted text-muted-foreground">
                          <Package className="size-4" />
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <Link href={`/admin/products/${p.id}`} className="font-medium hover:underline">
                        {p.name}
                      </Link>
                      <div className="text-xs text-muted-foreground">
                        {p.owner.businessName}
                        {simple ? (
                          <>
                            {" · "}
                            <span className="font-mono">{p.variants[0].sku}</span>
                          </>
                        ) : p.options.length > 0 ? ` · ${p.options.join(" / ")}` : ""}
                      </div>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={p.status} />
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {simple ? <span className="text-muted-foreground">Simple</span> : `${p.variants.length} variant${p.variants.length === 1 ? "" : "s"}`}
                      {!simple && active !== p.variants.length && <div className="text-xs text-muted-foreground">{active} active</div>}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {inv.onHand === 0 && inv.reserved === 0 ? (
                        <span className="text-muted-foreground">No stock</span>
                      ) : (
                        <>
                          <span className={inv.available > 0 ? "" : "text-amber-700"}>{formatInt(inv.available)} available</span>
                          <div className="text-xs text-muted-foreground">
                            {formatInt(inv.onHand)} on hand{inv.reserved ? ` · ${formatInt(inv.reserved)} reserved` : ""}
                            {inv.warehouses > 1 ? ` · ${inv.warehouses} warehouses` : ""}
                          </div>
                        </>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <ProductRowActions id={p.id} name={p.name} status={p.status} blockers={deleteChecks.get(p.id)?.blockers ?? []} canEdit={canEdit} />
                    </TableCell>
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
