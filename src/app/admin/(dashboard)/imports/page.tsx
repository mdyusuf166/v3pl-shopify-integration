import type { Metadata } from "next";
import Link from "next/link";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Pagination } from "@/components/common/pagination";
import { StatusBadge } from "@/components/common/status-badge";
import { ImportUploadForm } from "@/components/imports/import-upload-form";
import { ProductImportUploadForm } from "@/components/imports/product-import-upload-form";
import { PageHeader } from "@/components/layout/page-header";
import { formatDateTime } from "@/lib/format";
import { requireRole } from "@/server/auth/guards";
import { listImportJobs } from "@/server/services/imports";
import { listOwnerOptions } from "@/server/services/owners";
import { listWarehouses } from "@/server/services/warehouses";

export const metadata: Metadata = { title: "Imports & exports" };

export default async function ImportsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireRole("ADMIN", "SALES");
  const sp = await searchParams;
  const page = Number(sp.page) || 1;
  const [jobs, warehouses, vendors, clients] = await Promise.all([listImportJobs(page), listWarehouses(), listOwnerOptions("VENDOR"), listOwnerOptions("THREEPL_CLIENT")]);
  return (
    <>
      <PageHeader
        title="Imports & exports"
        description="Bulk order and product imports with preview and row-level errors; filtered CSV exports."
        actions={
          <>
            <Button variant="outline" render={<a href="/api/products/export?status=ALL" />}>
              <Download /> Export products
            </Button>
            <Button variant="outline" render={<Link href="/admin/orders/export" />}>
              <Download /> Export orders
            </Button>
          </>
        }
      />
      <ImportUploadForm warehouses={warehouses} />
      {user.role === "ADMIN" && <ProductImportUploadForm warehouses={warehouses} owners={[...vendors, ...clients]} />}
      <Card>
        <CardHeader>
          <CardTitle>Import history</CardTitle>
          <CardDescription>Every upload, its outcome and the downloadable failed-row report.</CardDescription>
        </CardHeader>
        <CardContent>
          {jobs.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">No imports yet.</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>File</TableHead>
                    <TableHead>Format</TableHead>
                    <TableHead className="text-right">Rows</TableHead>
                    <TableHead className="text-right">Groups</TableHead>
                    <TableHead className="text-right">Imported</TableHead>
                    <TableHead className="text-right">Failed</TableHead>
                    <TableHead className="text-right">Dup./updated</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="hidden md:table-cell">By</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {jobs.items.map((j) => (
                    <TableRow key={j.id}>
                      <TableCell className="whitespace-nowrap">
                        <Link href={`/admin/imports/${j.id}`} className="hover:underline">
                          {formatDateTime(j.createdAt)}
                        </Link>
                      </TableCell>
                      <TableCell className="capitalize text-muted-foreground">{j.type.toLowerCase()}</TableCell>
                      <TableCell className="max-w-56 truncate">{j.fileName}</TableCell>
                      <TableCell className="text-muted-foreground">{j.detectedFormat ?? "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">{j.totalRows}</TableCell>
                      <TableCell className="text-right tabular-nums">{j.totalOrders}</TableCell>
                      <TableCell className="text-right tabular-nums">{j.successCount}</TableCell>
                      <TableCell className={`text-right tabular-nums ${j.failedCount ? "text-red-700" : ""}`}>{j.failedCount}</TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">{j.duplicateCount}</TableCell>
                      <TableCell>
                        <StatusBadge status={j.status} />
                      </TableCell>
                      <TableCell className="hidden text-muted-foreground md:table-cell">{j.createdBy.name}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <Pagination page={jobs.page} pageCount={jobs.pageCount} total={jobs.total} pageSize={jobs.pageSize} hrefFor={(p) => `/admin/imports${p > 1 ? `?page=${p}` : ""}`} />
        </CardContent>
      </Card>
    </>
  );
}
