import Link from "next/link";
import { AlertTriangle, ChevronLeft } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusBadge } from "@/components/common/status-badge";
import { PageHeader } from "@/components/layout/page-header";
import { FulfillmentCard } from "@/components/orders/fulfillment-card";
import { OrderActions } from "@/components/orders/order-actions";
import { PickDialog } from "@/components/orders/pick-dialog";
import { ReturnsSection } from "@/components/orders/returns-section";
import { ShipmentCard } from "@/components/orders/shipment-card";
import { ShopifyOutboundCard } from "@/components/orders/shopify-outbound-card";
import type { shopifyOutboundSummary } from "@/server/services/shopify-order-request";
import { formatDateTime, formatMoney } from "@/lib/format";
import { presentOrderStatus, warehouseStageLabel } from "@/lib/order-presentation";
import type { OrderDetail as OrderDetailType } from "@/server/services/orders";
import { remainingQty } from "@/server/services/order-status";

type Props = {
  order: OrderDetailType;
  /** Portal view: read-only, scoped lines, no money totals. */
  scoped: boolean;
  canManage: boolean;
  canOperate: boolean;
  backHref: string;
  backLabel: string;
  warehouses: { id: string; code: string; name: string }[];
  locationsByWarehouse: Record<string, { id: string; label: string; isDefault: boolean }[]>;
  pickable: { orderItemId: string; sku: string; title: string; pickable: number }[];
  /** Admin only: reasons the order cannot be hard-deleted (D-054); undefined = no delete button. */
  deleteBlockers?: string[];
  /** Staff: outbound V3PL → Shopify state for manual orders (D-061). */
  shopifyOutbound?: Awaited<ReturnType<typeof shopifyOutboundSummary>> | null;
};

/** Portal history shows neutral labels only — event messages can mention other owners' SKUs. */
const SCOPED_EVENT_LABEL: Record<string, string> = {
  created: "Order placed",
  confirmed: "Order confirmed",
  cancelled: "Order cancelled",
  shipment_status: "Shipment status updated",
  return_received: "Return received",
  return_inspected: "Return inspected",
};

export function OrderDetail({ order, scoped, canManage, canOperate, backHref, backLabel, warehouses, locationsByWarehouse, pickable, deleteBlockers, shopifyOutbound }: Props) {
  const presented = presentOrderStatus(order);
  const stage = warehouseStageLabel(order.fulfillmentStatus);
  const unreserved = order.items.reduce((s, i) => s + Math.max(0, remainingQty(i) - i.reservedQty), 0);
  const owners = [...new Map(order.items.map((i) => [i.owner.id, i.owner])).values()];
  const shipTo = [order.shipName, order.shipCompany, order.shipAddress1, order.shipAddress2, [order.shipCity, order.shipProvince, order.shipZip].filter(Boolean).join(", "), order.shipCountry].filter(Boolean);
  const returnable = order.items.map((i) => ({ orderItemId: i.id, sku: i.sku, title: [i.title, i.variantTitle].filter(Boolean).join(" · "), returnable: i.shippedQty - i.returnedQty - order.returns.filter((r) => r.status === "RECEIVED").flatMap((r) => r.items).filter((ri) => ri.orderItem.sku === i.sku).reduce((s, ri) => s + ri.quantity, 0) }));

  return (
    <>
      <div>
        <Link href={backHref} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ChevronLeft className="size-4" /> {backLabel}
        </Link>
      </div>
      <PageHeader
        title={`Order ${order.orderNumber}`}
        description={
          <>
            {order.source.toLowerCase().replace("_", " ")}
            {order.sourceRef || order.shopifyOrderName ? ` · ref ${order.shopifyOrderName ?? order.sourceRef}` : ""} · placed {formatDateTime(order.placedAt)}
            {order.createdBy ? ` · by ${order.createdBy.name}` : order.submittedByOwner ? ` · submitted by ${order.submittedByOwner.businessName}` : ""}
          </>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={presented} />
            {!scoped && presented === "UNFULFILLED" && stage && (
              <Badge variant="outline" title="Warehouse stage">
                {stage}
              </Badge>
            )}
            {!scoped && order.status !== "CANCELLED" && (
              <Badge variant="outline" className="capitalize" title="Payment">
                {order.financialStatus.toLowerCase().replace("_", " ")}
              </Badge>
            )}
          </div>
        }
      />

      {order.needsAttention && !scoped && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Needs attention</AlertTitle>
          <AlertDescription>{order.needsAttentionReason}</AlertDescription>
        </Alert>
      )}

      {!scoped && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <OrderActions orderId={order.id} orderNumber={order.orderNumber} status={order.status} needsAttention={order.needsAttention} unreserved={unreserved} financialStatus={order.financialStatus} invoiceReference={order.invoiceReference} canManage={canManage} canOperate={canOperate} deleteBlockers={deleteBlockers} />
          {canOperate && (order.status === "NEW" || order.status === "CONFIRMED") && <PickDialog orderId={order.id} lines={pickable} warehouses={warehouses} defaultWarehouseId={order.warehouseId} />}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                Lines{owners.length > 1 && !scoped ? ` · ${owners.length} owners` : ""}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>SKU</TableHead>
                      <TableHead>Item</TableHead>
                      {!scoped && <TableHead className="hidden md:table-cell">Owner</TableHead>}
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead className="text-right">Reserved</TableHead>
                      <TableHead className="text-right">Shipped</TableHead>
                      <TableHead className="hidden text-right md:table-cell">Returned</TableHead>
                      <TableHead className="hidden text-right md:table-cell">Cancelled</TableHead>
                      {!scoped && <TableHead className="text-right">Price</TableHead>}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {order.items.map((i) => (
                      <TableRow key={i.id} className={i.quantity - i.cancelledQty === 0 ? "opacity-60" : ""}>
                        <TableCell>
                          {scoped ? (
                            <span className="font-mono text-xs">{i.sku}</span>
                          ) : (
                            <Link href={`/admin/products/${i.variant.productId}`} className="font-mono text-xs hover:underline">
                              {i.sku}
                            </Link>
                          )}
                        </TableCell>
                        <TableCell>
                          {i.title}
                          {i.variantTitle && <span className="text-muted-foreground"> · {i.variantTitle}</span>}
                          {i.warehouse && <div className="text-xs text-muted-foreground">from {i.warehouse.code}</div>}
                        </TableCell>
                        {!scoped && <TableCell className="hidden text-muted-foreground md:table-cell">{i.owner.businessName}</TableCell>}
                        <TableCell className="text-right tabular-nums">{i.quantity}</TableCell>
                        <TableCell className={`text-right tabular-nums ${remainingQty(i) > 0 && i.reservedQty < remainingQty(i) ? "text-amber-700" : ""}`}>{i.reservedQty}</TableCell>
                        <TableCell className="text-right tabular-nums">{i.shippedQty}</TableCell>
                        <TableCell className="hidden text-right tabular-nums text-muted-foreground md:table-cell">{i.returnedQty}</TableCell>
                        <TableCell className="hidden text-right tabular-nums text-muted-foreground md:table-cell">{i.cancelledQty}</TableCell>
                        {!scoped && <TableCell className="text-right tabular-nums">{formatMoney(i.unitPrice, i.currency)}</TableCell>}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>

          {order.fulfillments.length > 0 && (
            <div className="space-y-3">
              <h2 className="text-lg font-semibold">Fulfilments</h2>
              {order.fulfillments.map((f) => (
                <FulfillmentCard key={f.id} f={f} orderId={order.id} canOperate={canOperate && !scoped} />
              ))}
            </div>
          )}
          {order.shipments.length > 0 && (
            <div className="space-y-3">
              <h2 className="text-lg font-semibold">Shipments</h2>
              {order.shipments.map((s) => (
                <ShipmentCard key={s.id} s={s} orderId={order.id} canOperate={canOperate && !scoped} />
              ))}
            </div>
          )}
          {(order.returns.length > 0 || (!scoped && canOperate)) && (
            <ReturnsSection orderId={order.id} returns={order.returns} returnable={returnable} warehouses={warehouses} defaultWarehouseId={order.warehouseId} canOperate={canOperate && !scoped} locationsByWarehouse={locationsByWarehouse} />
          )}
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Ship to</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 text-sm">
              {shipTo.length === 0 ? <p className="text-muted-foreground">No address recorded</p> : shipTo.map((l, i) => <p key={i}>{l}</p>)}
              {(order.shipPhone || order.customerPhone) && <p className="text-muted-foreground">{order.shipPhone ?? order.customerPhone}</p>}
              {order.customerEmail && <p className="text-muted-foreground">{order.customerEmail}</p>}
              {!scoped && order.customer && (
                <p className="pt-2 text-muted-foreground">
                  Customer record:{" "}
                  <Link href={`/admin/customers/${order.customer.id}`} className="underline underline-offset-4">
                    {order.customer.name}
                  </Link>
                </p>
              )}
              {order.shippingMethod && <p className="pt-2 text-muted-foreground">Method: {order.shippingMethod}</p>}
              {order.warehouse && <p className="text-muted-foreground">Warehouse: {order.warehouse.code}</p>}
            </CardContent>
          </Card>
          {!scoped && shopifyOutbound && <ShopifyOutboundCard orderId={order.id} summary={shopifyOutbound} canSend={canManage} />}
          {!scoped && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Totals</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1 text-sm">
                {[
                  ["Subtotal", order.subtotal],
                  ["Discount", order.discountTotal],
                  ["Shipping", order.shippingTotal],
                  ["Tax", order.taxTotal],
                  ["Total", order.total],
                ].map(([label, v]) => (
                  <div key={label as string} className="flex justify-between">
                    <span className="text-muted-foreground">{label as string}</span>
                    <span className="tabular-nums">{formatMoney(v as never, order.currency)}</span>
                  </div>
                ))}
                {order.invoiceReference && (
                  <div className="flex justify-between pt-2">
                    <span className="text-muted-foreground">Invoice</span>
                    <span>{order.invoiceReference}</span>
                  </div>
                )}
                {(order.notes || order.tags) && (
                  <div className="pt-2 text-muted-foreground">
                    {order.tags && <p>Tags: {order.tags}</p>}
                    {order.notes && <p className="whitespace-pre-line">{order.notes}</p>}
                  </div>
                )}
              </CardContent>
            </Card>
          )}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">History</CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="space-y-3 text-sm">
                {(scoped ? order.events.filter((e) => ["created", "confirmed", "cancelled", "shipment_status", "return_received", "return_inspected"].includes(e.type)) : order.events).map((e) => (
                  <li key={e.id} className="border-l-2 pl-3">
                    <p>{scoped ? SCOPED_EVENT_LABEL[e.type] ?? e.type : e.message}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatDateTime(e.createdAt)}
                      {e.user ? ` · ${e.user.name}` : ""}
                    </p>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
