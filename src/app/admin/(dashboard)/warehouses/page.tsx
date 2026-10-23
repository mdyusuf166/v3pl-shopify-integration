import type { Metadata } from "next";
import Link from "next/link";
import { Plus, Warehouse } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/common/empty-state";
import { StatusBadge } from "@/components/common/status-badge";
import { PageHeader } from "@/components/layout/page-header";
import { formatInt } from "@/lib/format";
import { requireRole } from "@/server/auth/guards";
import { warehouseStockSummary } from "@/server/services/inventory";
import { listWarehouses } from "@/server/services/warehouses";

export const metadata: Metadata = { title: "Warehouses" };

export default async function WarehousesPage() {
  const user = await requireRole("ADMIN", "WAREHOUSE");
  const warehouses = await listWarehouses(true);
  const summaries = await Promise.all(warehouses.map((w) => warehouseStockSummary(w.id)));
  const canEdit = user.role === "ADMIN";
  const newButton = canEdit ? (
    <Button render={<Link href="/admin/warehouses/new" />}>
      <Plus /> New warehouse
    </Button>
  ) : null;

  return (
    <>
      <PageHeader title="Warehouses" description="Physical sites where stock is held. Inventory is tracked per warehouse and location." actions={newButton} />
      {warehouses.length === 0 ? (
        <EmptyState icon={Warehouse} title="No warehouses yet" description="Create the first warehouse to start receiving stock." action={newButton ?? undefined} />
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Name</TableHead>
                <TableHead className="hidden md:table-cell">Location</TableHead>
                <TableHead className="text-right">Locations</TableHead>
                <TableHead className="text-right">SKUs</TableHead>
                <TableHead className="text-right">On hand</TableHead>
                <TableHead className="text-right">Reserved</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {warehouses.map((w, i) => (
                <TableRow key={w.id}>
                  <TableCell className="font-mono text-xs">{w.code}</TableCell>
                  <TableCell>
                    <Link href={`/admin/warehouses/${w.id}`} className="font-medium hover:underline">
                      {w.name}
                    </Link>
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">{[w.city, w.country].filter(Boolean).join(", ") || "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{w._count.locations}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatInt(summaries[i].skus)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatInt(summaries[i].onHand)}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{formatInt(summaries[i].reserved)}</TableCell>
                  <TableCell>
                    <StatusBadge status={w.status} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}
