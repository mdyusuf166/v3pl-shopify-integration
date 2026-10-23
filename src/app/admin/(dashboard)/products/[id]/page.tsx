import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusBadge } from "@/components/common/status-badge";
import { MovementsTable } from "@/components/inventory/movements-table";
import { PageHeader } from "@/components/layout/page-header";
import { ProductDeleteButton } from "@/components/products/product-delete-button";
import { ProductImages } from "@/components/products/product-images";
import { ProductStatusButton } from "@/components/products/product-status-button";
import { isCloudinaryConfigured } from "@/lib/env";
import { formatDateTime, formatInt, formatMoney } from "@/lib/format";
import { variantLabel } from "@/lib/validation/products";
import { requireStaff } from "@/server/auth/guards";
import { listMovements, stockForVariants } from "@/server/services/inventory";
import { getProduct, productDeleteCheck } from "@/server/services/products";

export default async function ProductDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireStaff();
  const { id } = await params;
  const product = await getProduct(id);
  if (!product) notFound();
  const canEdit = user.role === "ADMIN";
  const [stock, movements, deleteCheck] = await Promise.all([stockForVariants(product.variants.map((v) => v.id)), listMovements({ productId: id, pageSize: 15 }), canEdit ? productDeleteCheck(id) : null]);
  const ownerPath = `${product.owner.type === "VENDOR" ? "/admin/vendors" : "/admin/3pl-clients"}/${product.owner.id}`;
  const simple = product.options.length === 0 && product.variants.length === 1;
  const totals = product.variants.reduce(
    (acc, v) => {
      for (const r of stock.get(v.id) ?? []) {
        acc.onHand += r.onHand;
        acc.reserved += r.reserved;
      }
      return acc;
    },
    { onHand: 0, reserved: 0 },
  );

  return (
    <>
      <div>
        <Link href="/admin/products" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ChevronLeft className="size-4" /> Products
        </Link>
      </div>
      <PageHeader
        title={product.name}
        description={
          <>
            <Link href={ownerPath} className="underline underline-offset-4">
              {product.owner.businessName}
            </Link>
            {simple ? (
              <>
                {" · SKU "}
                <span className="font-mono">{product.variants[0].sku}</span>
              </>
            ) : (
              ` · ${product.variants.length} variant${product.variants.length === 1 ? "" : "s"}${product.options.length ? ` · ${product.options.join(" / ")}` : ""}`
            )}
          </>
        }
        actions={
          <>
            <StatusBadge status={product.status} className="mr-2" />
            {canEdit && (
              <>
                <Button variant="outline" render={<Link href={`/admin/products/${product.id}/edit`} />}>
                  <Pencil /> Edit
                </Button>
                <ProductStatusButton id={product.id} status={product.status} name={product.name} />
                <ProductDeleteButton id={product.id} name={product.name} status={product.status} blockers={deleteCheck?.blockers ?? []} redirectTo="/admin/products" />
              </>
            )}
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-3">
        {[
          { label: "Available", value: totals.onHand - totals.reserved },
          { label: "On hand", value: totals.onHand },
          { label: "Reserved", value: totals.reserved },
        ].map((t) => (
          <Card key={t.label}>
            <CardContent className="pt-4">
              <p className="text-sm text-muted-foreground">{t.label}</p>
              <p className="text-2xl font-semibold tabular-nums">{formatInt(t.value)}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>{simple ? "SKU" : "Variants"}</CardTitle>
              <CardDescription>Available = on hand − reserved, per warehouse.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      {!simple && <TableHead>Variant</TableHead>}
                      <TableHead>SKU</TableHead>
                      <TableHead className="text-right">Retail</TableHead>
                      <TableHead className="hidden text-right md:table-cell">Wholesale</TableHead>
                      <TableHead>Inventory</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {product.variants.map((v) => {
                      const rows = stock.get(v.id) ?? [];
                      const onHand = rows.reduce((s, r) => s + r.onHand, 0);
                      const available = rows.reduce((s, r) => s + r.available, 0);
                      return (
                        <TableRow key={v.id}>
                          {!simple && <TableCell className="font-medium">{variantLabel(v) ?? <span className="text-muted-foreground">Default</span>}</TableCell>}
                          <TableCell>
                            <span className="font-mono text-xs">{v.sku}</span>
                            {v.barcode && <div className="font-mono text-[11px] text-muted-foreground">{v.barcode}</div>}
                            {(v.weightGrams !== null || v.lengthCm !== null || v.widthCm !== null || v.heightCm !== null) && (
                              <div className="text-xs text-muted-foreground">
                                {v.weightGrams !== null ? `${v.weightGrams} g` : ""}
                                {v.weightGrams !== null && (v.lengthCm !== null || v.widthCm !== null || v.heightCm !== null) ? " · " : ""}
                                {v.lengthCm !== null || v.widthCm !== null || v.heightCm !== null ? `${v.lengthCm?.toString() ?? "–"} × ${v.widthCm?.toString() ?? "–"} × ${v.heightCm?.toString() ?? "–"} cm` : ""}
                              </div>
                            )}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{formatMoney(v.price, v.currency)}</TableCell>
                          <TableCell className="hidden text-right tabular-nums text-muted-foreground md:table-cell">{formatMoney(v.wholesalePrice, v.currency)}</TableCell>
                          <TableCell>
                            {rows.length === 0 ? (
                              <span className="text-xs text-muted-foreground">No stock</span>
                            ) : (
                              <div className="text-sm tabular-nums">
                                <span className={available > 0 ? "" : "text-amber-700"}>{formatInt(available)} available</span>
                                <span className="text-muted-foreground"> · {formatInt(onHand)} on hand</span>
                                {rows.length > 1 || rows[0].reserved > 0 ? (
                                  <ul className="mt-0.5 space-y-0.5 text-xs text-muted-foreground">
                                    {rows.map((r) => (
                                      <li key={r.warehouseId}>
                                        {r.code}: {r.onHand} on hand{r.reserved ? ` · ${r.reserved} reserved` : ""}
                                      </li>
                                    ))}
                                  </ul>
                                ) : (
                                  <span className="text-xs text-muted-foreground"> · {rows[0].code}</span>
                                )}
                              </div>
                            )}
                          </TableCell>
                          <TableCell>
                            <StatusBadge status={v.status} />
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Recent movements</CardTitle>
              <CardDescription>
                Latest ledger entries for this product.{" "}
                <Link href={`/admin/inventory/movements?q=${encodeURIComponent(product.variants[0]?.sku ?? product.name)}`} className="underline underline-offset-4">
                  View all
                </Link>
              </CardDescription>
            </CardHeader>
            <CardContent>
              {movements.items.length === 0 ? <p className="text-sm text-muted-foreground">No movements yet.</p> : <MovementsTable rows={movements.items} hideOwner linkBase={null} />}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <ProductImages productId={product.id} images={product.images} canEdit={canEdit} uploadsConfigured={isCloudinaryConfigured()} />
          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Owner</span>
                <span>{product.owner.code}</span>
              </div>
              {product.options.length > 0 && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Options</span>
                  <span>{product.options.join(", ")}</span>
                </div>
              )}
              <div className="flex justify-between text-muted-foreground">
                <span>Updated</span>
                <span>{formatDateTime(product.updatedAt)}</span>
              </div>
              {product.notes && (
                <div>
                  <p className="text-muted-foreground">Internal notes</p>
                  <p className="whitespace-pre-line">{product.notes}</p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
