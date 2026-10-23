import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusBadge } from "@/components/common/status-badge";
import { PageHeader } from "@/components/layout/page-header";
import { TransferActions } from "@/components/transfers/transfer-actions";
import { formatDateTime, formatInt } from "@/lib/format";
import { requireRole } from "@/server/auth/guards";
import { getTransfer } from "@/server/services/transfers";
import { listLocations } from "@/server/services/warehouses";

export default async function TransferDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireRole("ADMIN", "WAREHOUSE");
  const { id } = await params;
  const t = await getTransfer(id);
  if (!t) notFound();
  const destLocations = t.status === "PENDING" ? await listLocations(t.destWarehouseId) : [];
  const units = t.items.reduce((s, i) => s + i.quantity, 0);

  return (
    <>
      <div>
        <Link href="/admin/transfers" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ChevronLeft className="size-4" /> Transfers
        </Link>
      </div>
      <PageHeader
        title={t.reference ? `Transfer ${t.reference}` : "Transfer"}
        description={`${t.sourceWarehouse.code} → ${t.destWarehouse.code} · created ${formatDateTime(t.createdAt)} by ${t.createdBy.name}${t.completedAt ? ` · completed ${formatDateTime(t.completedAt)} by ${t.completedBy?.name ?? ""}` : ""}${t.cancelledAt ? ` · cancelled ${formatDateTime(t.cancelledAt)}` : ""}`}
        actions={
          <>
            <StatusBadge status={t.status} className="mr-2" />
            {t.status === "PENDING" && <TransferActions id={t.id} destWarehouseId={t.destWarehouseId} destLocations={destLocations} lines={t.items.map((i) => ({ itemId: i.id, sku: i.variant.sku, quantity: i.quantity }))} />}
          </>
        }
      />
      <Card>
        <CardHeader>
          <CardTitle>
            {t.items.length} line{t.items.length === 1 ? "" : "s"} · {formatInt(units)} units {t.status === "PENDING" ? "in transit" : ""}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-hidden rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>SKU</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead>From</TableHead>
                  <TableHead>To</TableHead>
                  <TableHead className="text-right">Quantity</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {t.items.map((i) => (
                  <TableRow key={i.id}>
                    <TableCell className="font-mono text-xs">{i.variant.sku}</TableCell>
                    <TableCell>
                      {i.variant.product.name}
                      {i.variant.name && <span className="text-muted-foreground"> · {i.variant.name}</span>}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{i.variant.product.owner.businessName}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {t.sourceWarehouse.code} · {i.sourceLocation.label}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{i.destLocation ? `${t.destWarehouse.code} · ${i.destLocation.label}` : <span className="text-muted-foreground">in transit</span>}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatInt(i.quantity)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {t.notes && <p className="mt-4 text-sm whitespace-pre-line text-muted-foreground">{t.notes}</p>}
        </CardContent>
      </Card>
    </>
  );
}
