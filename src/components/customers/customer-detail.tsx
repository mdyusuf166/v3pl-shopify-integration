import Link from "next/link";
import { ChevronLeft, Pencil } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusBadge } from "@/components/common/status-badge";
import { PageHeader } from "@/components/layout/page-header";
import { formatDateTime } from "@/lib/format";
import { presentOrderStatus } from "@/lib/order-presentation";
import { CUSTOMER_SOURCE_LABEL } from "@/lib/validation/customers";
import type { getCustomer } from "@/server/services/customers";

type Customer = NonNullable<Awaited<ReturnType<typeof getCustomer>>>;

type Props = {
  customer: Customer;
  basePath: string;
  ordersPath: string;
  canEdit: boolean;
  /** Portal: only orders that contain the viewer's lines are listed. */
  scopeOwnerId?: string;
  showOwner?: boolean;
};

const addr = (c: Customer, p: "ship" | "bill") => [c[`${p}Name`], c[`${p}Company`], c[`${p}Address1`], c[`${p}Address2`], [c[`${p}City`], c[`${p}Province`], c[`${p}Zip`]].filter(Boolean).join(", "), c[`${p}Country`]].filter(Boolean) as string[];

/** Shared customer detail (D-060): contact, addresses, and the orders linked to this record. */
export function CustomerDetail({ customer, basePath, ordersPath, canEdit, scopeOwnerId, showOwner = false }: Props) {
  const orders = scopeOwnerId ? customer.orders.filter((o) => o.items.some((i) => i.ownerId === scopeOwnerId)) : customer.orders;
  const ship = addr(customer, "ship");
  const bill = addr(customer, "bill");
  return (
    <>
      <div>
        <Link href={basePath} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ChevronLeft className="size-4" /> Customers
        </Link>
      </div>
      <PageHeader
        title={customer.name}
        description={
          <>
            {[customer.email, customer.phone].filter(Boolean).join(" · ") || "No contact details"} · {CUSTOMER_SOURCE_LABEL[customer.source] ?? customer.source}
            {showOwner ? ` · ${customer.owner ? customer.owner.businessName : "Company (V3PL)"}` : ""}
          </>
        }
        actions={
          canEdit ? (
            <Button variant="outline" render={<Link href={`${basePath}/${customer.id}/edit`} />}>
              <Pencil /> Edit
            </Button>
          ) : undefined
        }
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Orders ({orders.length})</CardTitle>
            </CardHeader>
            <CardContent>
              {orders.length === 0 ? (
                <p className="text-sm text-muted-foreground">No orders linked to this customer yet. Older orders keep their own customer details and are not linked retroactively.</p>
              ) : (
                <div className="overflow-x-auto rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Order</TableHead>
                        <TableHead>Placed</TableHead>
                        <TableHead>Source</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {orders.map((o) => (
                        <TableRow key={o.id}>
                          <TableCell>
                            <Link href={`${ordersPath}/${o.id}`} className="font-medium hover:underline">
                              {o.orderNumber}
                            </Link>
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-muted-foreground">{formatDateTime(o.placedAt)}</TableCell>
                          <TableCell className="text-muted-foreground">{o.source.toLowerCase().replace("_", " ")}</TableCell>
                          <TableCell>
                            <StatusBadge status={presentOrderStatus(o)} />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Shipping address</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 text-sm">
              {ship.length === 0 ? <p className="text-muted-foreground">Not recorded</p> : ship.map((l, i) => <p key={i}>{l}</p>)}
              {customer.shipPhone && <p className="text-muted-foreground">{customer.shipPhone}</p>}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Billing address</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 text-sm">{bill.length === 0 ? <p className="text-muted-foreground">Not recorded</p> : bill.map((l, i) => <p key={i}>{l}</p>)}</CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {customer.notes && <p className="whitespace-pre-line">{customer.notes}</p>}
              {customer.shopifyCustomerId && <Badge variant="outline">Shopify customer</Badge>}
              <div className="flex justify-between text-muted-foreground">
                <span>Created</span>
                <span>{formatDateTime(customer.createdAt)}</span>
              </div>
              <div className="flex justify-between text-muted-foreground">
                <span>Updated</span>
                <span>{formatDateTime(customer.updatedAt)}</span>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
