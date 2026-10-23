import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, CheckCircle2, ChevronLeft, Download } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusBadge } from "@/components/common/status-badge";
import { ImportConfirm } from "@/components/imports/import-confirm";
import { PageHeader } from "@/components/layout/page-header";
import { formatDateTime } from "@/lib/format";
import { requireRole } from "@/server/auth/guards";
import { getImportJob, jobPreview, jobProductPreview } from "@/server/services/imports";
import type { ImportOutcome } from "@/server/services/order-csv";
import type { ProductImportOutcome, ProductImportPreview } from "@/server/services/product-csv";

export default async function ImportJobPage({ params }: { params: Promise<{ id: string }> }) {
  await requireRole("ADMIN", "SALES");
  const { id } = await params;
  const job = await getImportJob(id);
  if (!job) notFound();
  if (job.type === "PRODUCTS") return <ProductJob job={job} preview={jobProductPreview(job)} outcome={(job.result as ProductImportOutcome | null) ?? null} />;

  const preview = jobPreview(job);
  const outcome = (job.result as ImportOutcome | null) ?? null;
  const failedNames = new Set(outcome?.failed.map((f) => f.name) ?? []);
  const createdByName = new Map(outcome?.created.map((c) => [c.name, c]) ?? []);
  const hasFailures = (preview?.summary.failedRows ?? 0) > 0 || (outcome?.failed.length ?? 0) > 0;

  return (
    <>
      <div>
        <Link href="/admin/imports" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ChevronLeft className="size-4" /> Imports
        </Link>
      </div>
      <PageHeader
        title={job.status === "PREVIEW" ? "Review import" : "Import results"}
        description={`${job.fileName} · ${job.detectedFormat ?? "unknown format"} · uploaded ${formatDateTime(job.createdAt)} by ${job.createdBy.name}`}
        actions={
          <>
            <StatusBadge status={job.status} />
            {hasFailures && (
              <Button variant="outline" render={<a href={`/api/imports/${job.id}/failed-rows`} />}>
                <Download /> Failed rows CSV
              </Button>
            )}
            {job.status === "PREVIEW" && preview && <ImportConfirm jobId={job.id} validCount={preview.summary.validOrders} noun="order" />}
          </>
        }
      />

      {preview && preview.missingRequired.length > 0 && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Unsupported file</AlertTitle>
          <AlertDescription>Missing required column(s): {preview.missingRequired.join(", ")}. Expected a Shopify order export or a V3PL order export.</AlertDescription>
        </Alert>
      )}

      {preview && (
        <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-6">
          {[
            ["Rows", preview.summary.totalRows],
            ["Orders in file", preview.summary.totalOrders],
            [job.status === "PREVIEW" ? "Ready to import" : "Created", job.status === "PREVIEW" ? preview.summary.validOrders : outcome?.created.length ?? 0],
            ["Failed orders", job.status === "PREVIEW" ? preview.summary.failedOrders : outcome?.failed.length ?? 0],
            ["Duplicates", job.status === "PREVIEW" ? preview.summary.duplicateOrders : outcome?.duplicates.length ?? 0],
            ["Failed rows", preview.summary.failedRows],
          ].map(([label, value]) => (
            <Card key={label as string}>
              <CardContent className="pt-4">
                <p className="text-xs text-muted-foreground">{label as string}</p>
                <p className="text-xl font-semibold tabular-nums">{value as number}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {preview && preview.unknownColumns.length > 0 && <p className="text-xs text-muted-foreground">Ignored columns (not used by V3PL): {preview.unknownColumns.join(", ")}</p>}

      {preview && preview.groups.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Orders</CardTitle>
            <CardDescription>An order with any error is skipped entirely — nothing is imported partially. Fix the rows and re-upload the failed-rows file.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Rows</TableHead>
                    <TableHead>Lines</TableHead>
                    <TableHead>Ship to</TableHead>
                    <TableHead>Warehouse</TableHead>
                    <TableHead>Outcome</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.groups.map((g) => {
                    const rowErrors = preview.rows.filter((r) => g.rowIndexes.includes(r.index)).flatMap((r) => r.errors.map((e) => `Row ${r.index}: ${e}`));
                    const errors = [...g.errors, ...rowErrors, ...(outcome?.failed.find((f) => f.name === g.name)?.errors ?? [])];
                    const created = createdByName.get(g.name);
                    return (
                      <TableRow key={g.name}>
                        <TableCell className="font-mono text-xs">{g.name}</TableCell>
                        <TableCell className="text-muted-foreground">{g.rowIndexes.join(", ")}</TableCell>
                        <TableCell>{g.lines.map((l) => `${l.quantity} × ${l.sku}`).join(", ")}</TableCell>
                        <TableCell className="max-w-48 truncate">{g.header["Shipping Name"] ?? g.header["Email"] ?? "—"}</TableCell>
                        <TableCell className="font-mono text-xs">{g.warehouseCode ?? "default"}</TableCell>
                        <TableCell>
                          {created ? (
                            <Link href={`/admin/orders/${created.orderId}`} className="inline-flex items-center gap-1 text-emerald-700 hover:underline">
                              <CheckCircle2 className="size-4" /> Order {created.orderNumber}
                              {created.short > 0 && <Badge variant="outline">stock short</Badge>}
                            </Link>
                          ) : g.duplicate ? (
                            <Badge variant="outline">Duplicate — skipped</Badge>
                          ) : errors.length > 0 || failedNames.has(g.name) ? (
                            <ul className="space-y-0.5 text-xs text-red-700">
                              {[...new Set(errors)].map((e) => (
                                <li key={e}>{e}</li>
                              ))}
                            </ul>
                          ) : job.status === "PREVIEW" ? (
                            <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700">
                              Ready
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}
    </>
  );
}

type JobRow = NonNullable<Awaited<ReturnType<typeof getImportJob>>>;

/** Product import (D-053): one group per handle, variants listed under it. */
function ProductJob({ job, preview, outcome }: { job: JobRow; preview: ProductImportPreview | null; outcome: ProductImportOutcome | null }) {
  type Done = ProductImportOutcome["created"][number] & { action: "created" | "updated" };
  const done = new Map<string, Done>([...(outcome?.created ?? []).map((c): [string, Done] => [c.handle, { ...c, action: "created" }]), ...(outcome?.updated ?? []).map((c): [string, Done] => [c.handle, { ...c, action: "updated" }])]);
  const failedByHandle = new Map(outcome?.failed.map((f) => [f.handle, f]) ?? []);
  const hasFailures = (preview?.summary.failedRows ?? 0) > 0 || (preview?.summary.failedProducts ?? 0) > 0 || (outcome?.failed.length ?? 0) > 0;
  const isPreview = job.status === "PREVIEW";

  return (
    <>
      <div>
        <Link href="/admin/imports" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ChevronLeft className="size-4" /> Imports
        </Link>
      </div>
      <PageHeader
        title={isPreview ? "Review product import" : "Product import results"}
        description={`${job.fileName} · ${job.detectedFormat ?? "unknown format"} · uploaded ${formatDateTime(job.createdAt)} by ${job.createdBy.name}`}
        actions={
          <>
            <StatusBadge status={job.status} />
            {hasFailures && (
              <Button variant="outline" render={<a href={`/api/imports/${job.id}/failed-rows`} />}>
                <Download /> Failed rows CSV
              </Button>
            )}
            {isPreview && preview && <ImportConfirm jobId={job.id} validCount={preview.summary.validProducts} noun="product" />}
          </>
        }
      />

      {preview && preview.missingRequired.length > 0 && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Unsupported file</AlertTitle>
          <AlertDescription>Missing required column(s): {preview.missingRequired.join(", ")}. Expected a Shopify product export (Handle, Title, Option columns, Variant SKU…) or a V3PL product export.</AlertDescription>
        </Alert>
      )}

      {preview && (
        <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-6">
          {[
            ["Rows", preview.summary.totalRows],
            ["Products in file", preview.summary.totalProducts],
            [isPreview ? "Ready to import" : "Imported", isPreview ? preview.summary.validProducts : (outcome?.created.length ?? 0) + (outcome?.updated.length ?? 0)],
            ["Failed products", isPreview ? preview.summary.failedProducts : outcome?.failed.length ?? 0],
            ["New SKUs", preview.summary.newSkus],
            [preview.options.stockWarehouseId ? "Units to receive" : "Existing SKUs", preview.options.stockWarehouseId ? preview.summary.unitsToReceive : preview.summary.existingSkus],
          ].map(([label, value]) => (
            <Card key={label as string}>
              <CardContent className="pt-4">
                <p className="text-xs text-muted-foreground">{label as string}</p>
                <p className="text-xl font-semibold tabular-nums">{value as number}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {preview && preview.unknownColumns.length > 0 && <p className="text-xs text-muted-foreground">Ignored columns (not used by V3PL): {preview.unknownColumns.join(", ")}</p>}

      {preview && preview.groups.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Products</CardTitle>
            <CardDescription>A product with any error is skipped entirely. Existing SKUs are updated in place; new SKUs are added to the product they share a handle with.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Handle</TableHead>
                    <TableHead>Title</TableHead>
                    <TableHead>Owner</TableHead>
                    <TableHead>Variants</TableHead>
                    <TableHead>Outcome</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.groups.map((g) => {
                    const rowErrors = preview.rows.filter((r) => g.rowIndexes.includes(r.index)).flatMap((r) => r.errors.map((e) => `Row ${r.index}: ${e}`));
                    const errors = [...new Set([...g.errors, ...rowErrors, ...(failedByHandle.get(g.handle)?.errors ?? [])])];
                    const result = done.get(g.handle);
                    return (
                      <TableRow key={g.handle}>
                        <TableCell className="font-mono text-xs">{g.handle}</TableCell>
                        <TableCell>
                          <div className="font-medium">{g.title || <span className="text-muted-foreground">—</span>}</div>
                          <div className="text-xs text-muted-foreground">
                            {g.options.length ? g.options.join(" / ") : "Simple product"} · {g.action === "update" ? "updates existing product" : "new product"}
                          </div>
                        </TableCell>
                        <TableCell className="text-muted-foreground">{g.ownerName ?? g.ownerCode ?? "—"}</TableCell>
                        <TableCell>
                          <ul className="space-y-0.5 text-xs">
                            {g.variants.map((v) => (
                              <li key={v.rowIndex} className="flex flex-wrap gap-x-2">
                                <span className="font-mono">{v.sku || "(no SKU)"}</span>
                                {v.optionValues.length > 0 && <span className="text-muted-foreground">{v.optionValues.join(" / ")}</span>}
                                {v.price && <span className="text-muted-foreground">${v.price}</span>}
                                {v.quantity !== null && <span className="text-muted-foreground">qty {v.quantity}</span>}
                                {v.existingVariantId && <Badge variant="outline">existing</Badge>}
                              </li>
                            ))}
                          </ul>
                          {g.notes.length > 0 && (
                            <ul className="mt-1 space-y-0.5 text-xs text-amber-700">
                              {g.notes.map((n) => (
                                <li key={n}>{n}</li>
                              ))}
                            </ul>
                          )}
                        </TableCell>
                        <TableCell>
                          {result ? (
                            <Link href={`/admin/products/${result.productId}`} className="inline-flex items-center gap-1 text-emerald-700 hover:underline">
                              <CheckCircle2 className="size-4" /> {result.action === "created" ? "Created" : "Updated"}
                              {result.received > 0 && <Badge variant="outline">{result.received} units received</Badge>}
                            </Link>
                          ) : errors.length > 0 ? (
                            <ul className="space-y-0.5 text-xs text-red-700">
                              {errors.map((e) => (
                                <li key={e}>{e}</li>
                              ))}
                            </ul>
                          ) : isPreview ? (
                            <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700">
                              Ready
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}
    </>
  );
}
