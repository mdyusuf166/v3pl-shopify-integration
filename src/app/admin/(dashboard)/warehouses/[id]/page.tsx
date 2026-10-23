import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/common/status-badge";
import { PageHeader } from "@/components/layout/page-header";
import { LocationsManager } from "@/components/warehouses/locations-manager";
import { WarehouseDeleteButton } from "@/components/warehouses/warehouse-delete-button";
import { WarehouseStatusButton } from "@/components/warehouses/warehouse-status-button";
import { formatInt } from "@/lib/format";
import { requireRole } from "@/server/auth/guards";
import { warehouseStockSummary } from "@/server/services/inventory";
import { getWarehouse, locationDeleteCheck, warehouseDeleteCheck } from "@/server/services/warehouses";

export default async function WarehouseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireRole("ADMIN", "WAREHOUSE");
  const { id } = await params;
  const [warehouse, summary] = await Promise.all([getWarehouse(id), warehouseStockSummary(id)]);
  if (!warehouse) notFound();
  const isAdmin = user.role === "ADMIN";
  const deleteCheck = isAdmin ? await warehouseDeleteCheck(id) : null;
  const locationBlockers = isAdmin ? Object.fromEntries(await Promise.all(warehouse.locations.map(async (l) => [l.id, (await locationDeleteCheck(l.id)).blockers] as const))) : {};
  const address = [warehouse.addressLine1, warehouse.addressLine2, [warehouse.city, warehouse.state, warehouse.postalCode].filter(Boolean).join(", "), warehouse.country].filter(Boolean).join("\n");

  return (
    <>
      <div>
        <Link href="/admin/warehouses" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ChevronLeft className="size-4" /> Warehouses
        </Link>
      </div>
      <PageHeader
        title={warehouse.name}
        description={`Warehouse · ${warehouse.code}`}
        actions={
          <>
            <StatusBadge status={warehouse.status} className="mr-2" />
            {isAdmin && (
              <>
                <Button variant="outline" render={<Link href={`/admin/warehouses/${warehouse.id}/edit`} />}>
                  <Pencil /> Edit
                </Button>
                <WarehouseStatusButton id={warehouse.id} status={warehouse.status} name={warehouse.name} />
                <WarehouseDeleteButton id={warehouse.id} code={warehouse.code} name={warehouse.name} blockers={deleteCheck?.blockers ?? []} />
              </>
            )}
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-3">
        {[
          { label: "SKUs in stock", value: summary.skus },
          { label: "Units on hand", value: summary.onHand },
          { label: "Reserved", value: summary.reserved },
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
        <div className="lg:col-span-2">
          <LocationsManager warehouseId={warehouse.id} locations={warehouse.locations} canEdit={true} canDelete={isAdmin} locationBlockers={locationBlockers} warehouseActive={warehouse.status === "ACTIVE"} />
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Address</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="whitespace-pre-line">{address || <span className="text-muted-foreground">—</span>}</p>
            {warehouse.notes && (
              <div>
                <p className="text-muted-foreground">Notes</p>
                <p className="whitespace-pre-line">{warehouse.notes}</p>
              </div>
            )}
            <Link href={`/admin/inventory?warehouseId=${warehouse.id}`} className="inline-block underline underline-offset-4">
              View stock in this warehouse
            </Link>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
