import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeftRight, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/common/empty-state";
import { NativeSelect } from "@/components/common/native-select";
import { Pagination } from "@/components/common/pagination";
import { StatusBadge } from "@/components/common/status-badge";
import { PageHeader } from "@/components/layout/page-header";
import { formatDateTime, formatInt } from "@/lib/format";
import { requireRole } from "@/server/auth/guards";
import { listTransfers } from "@/server/services/transfers";

export const metadata: Metadata = { title: "Transfers" };

export default async function TransfersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireRole("ADMIN", "WAREHOUSE");
  const sp = await searchParams;
  const status = (["PENDING", "COMPLETED", "CANCELLED", "ALL"].includes(String(sp.status)) ? String(sp.status) : "ALL") as "PENDING" | "COMPLETED" | "CANCELLED" | "ALL";
  const page = Number(sp.page) || 1;
  const result = await listTransfers({ status, page });
  const hrefFor = (p: number) => `/admin/transfers?status=${status}${p > 1 ? `&page=${p}` : ""}`;
  const newButton = (
    <Button render={<Link href="/admin/transfers/new" />}>
      <Plus /> New transfer
    </Button>
  );

  return (
    <>
      <PageHeader title="Transfers" description="Stock moving between warehouses. Pending transfers are in transit." actions={newButton} />
      <form method="get" className="flex items-center gap-2">
        <NativeSelect name="status" defaultValue={status} aria-label="Status filter" className="w-40">
          <option value="ALL">All statuses</option>
          <option value="PENDING">Pending (in transit)</option>
          <option value="COMPLETED">Completed</option>
          <option value="CANCELLED">Cancelled</option>
        </NativeSelect>
        <Button type="submit" variant="secondary" size="sm">
          Apply
        </Button>
      </form>
      {result.items.length === 0 ? (
        <EmptyState icon={ArrowLeftRight} title="No transfers" description="Create a transfer to move stock between warehouses." action={newButton} />
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Created</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead>Route</TableHead>
                <TableHead className="text-right">Lines</TableHead>
                <TableHead className="text-right">Units</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden md:table-cell">By</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.items.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="whitespace-nowrap">
                    <Link href={`/admin/transfers/${t.id}`} className="hover:underline">
                      {formatDateTime(t.createdAt)}
                    </Link>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{t.reference ?? "—"}</TableCell>
                  <TableCell>
                    {t.sourceWarehouse.code} → {t.destWarehouse.code}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{t.lineCount}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatInt(t.units)}</TableCell>
                  <TableCell>
                    <StatusBadge status={t.status} />
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">{t.createdBy.name}</TableCell>
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
