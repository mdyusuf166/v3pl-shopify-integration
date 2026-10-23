import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader } from "@/components/layout/page-header";
import { formatDateTime, formatInt } from "@/lib/format";
import { requireRole } from "@/server/auth/guards";
import { getReceiving } from "@/server/services/receiving";

export default async function ReceivingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireRole("ADMIN", "WAREHOUSE");
  const { id } = await params;
  const r = await getReceiving(id);
  if (!r) notFound();
  const units = r.items.reduce((s, i) => s + i.quantity, 0);
  return (
    <>
      <div>
        <Link href="/admin/receiving" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ChevronLeft className="size-4" /> Receiving
        </Link>
      </div>
      <PageHeader title={r.reference ? `Receipt ${r.reference}` : "Receipt"} description={`${r.owner.businessName} → ${r.warehouse.code} · ${r.warehouse.name} · ${formatDateTime(r.receivedAt)} · by ${r.user.name}`} />
      <Card>
        <CardHeader>
          <CardTitle>
            {r.items.length} line{r.items.length === 1 ? "" : "s"} · {formatInt(units)} units
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-hidden rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>SKU</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead>Location</TableHead>
                  <TableHead className="text-right">Quantity</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {r.items.map((i) => (
                  <TableRow key={i.id}>
                    <TableCell>
                      <Link href={`/admin/products/${i.variant.product.id}`} className="font-mono text-xs hover:underline">
                        {i.variant.sku}
                      </Link>
                    </TableCell>
                    <TableCell>
                      {i.variant.product.name}
                      {i.variant.name && <span className="text-muted-foreground"> · {i.variant.name}</span>}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{i.location.label}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatInt(i.quantity)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {r.notes && <p className="mt-4 text-sm whitespace-pre-line text-muted-foreground">{r.notes}</p>}
        </CardContent>
      </Card>
    </>
  );
}
