import type { Metadata } from "next";
import { CheckCircle2, CircleDashed, Database, ShieldAlert, XCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/layout/page-header";
import { PartnerStats } from "@/components/dashboard/partner-stats";
import { FinanceStats } from "@/components/dashboard/finance-stats";
import { StockStats } from "@/components/dashboard/stock-stats";
import { OrderStats } from "@/components/dashboard/order-stats";
import { checkDatabaseConnection } from "@/lib/prisma";
import { ROLE_LABELS } from "@/lib/roles";
import { requireStaff } from "@/server/auth/guards";

export const metadata: Metadata = { title: "Dashboard" };

const FOUNDATION = [
  { label: "Firebase sign-in with server-side session", done: true },
  { label: "Role-based admin access (Admin / Warehouse / Sales)", done: true },
  { label: "Database + migrations (Prisma)", done: true },
  { label: "Audit log foundation", done: true },
  { label: "Vendors, 3PL clients & user management", done: true },
  { label: "Products, warehouses & inventory ledger", done: true },
  { label: "Orders, fulfillment, shipments, returns & CSV import/export", done: true },
  { label: "Shopify stores", phase: 7 },
];

export default async function AdminDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ forbidden?: string }>;
}) {
  const user = await requireStaff();
  const [{ forbidden }, db] = await Promise.all([searchParams, checkDatabaseConnection()]);

  return (
    <>
      <PageHeader title="Dashboard" description={`Signed in as ${user.name} · ${ROLE_LABELS[user.role]}`} />

      {forbidden && (
        <Alert variant="destructive">
          <ShieldAlert />
          <AlertTitle>No access</AlertTitle>
          <AlertDescription>Your role does not have access to that section.</AlertDescription>
        </Alert>
      )}

      <OrderStats />
      <StockStats />
      {user.role === "ADMIN" && <PartnerStats />}
      {user.role === "ADMIN" && <FinanceStats />}

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Database className="size-4 text-muted-foreground" />
              System status
            </CardTitle>
            <CardDescription>Live checks for this deployment.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex items-center justify-between">
              <span>Database</span>
              {db.ok ? (
                <Badge variant="secondary" className="gap-1">
                  <CheckCircle2 className="size-3.5 text-emerald-600" /> Connected
                </Badge>
              ) : (
                <Badge variant="destructive" className="gap-1">
                  <XCircle className="size-3.5" /> Unavailable
                </Badge>
              )}
            </div>
            {!db.ok && <p className="text-xs text-muted-foreground break-all">{db.error}</p>}
            <div className="flex items-center justify-between">
              <span>Authentication</span>
              <Badge variant="secondary" className="gap-1">
                <CheckCircle2 className="size-3.5 text-emerald-600" /> Firebase session active
              </Badge>
            </div>
            <div className="flex items-center justify-between">
              <span>Environment</span>
              <Badge variant="outline">{process.env.VERCEL_ENV ?? process.env.NODE_ENV}</Badge>
            </div>
            <div className="flex items-center justify-between">
              <span>Runtime</span>
              <Badge variant="outline">Node {process.version}</Badge>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Platform build-out</CardTitle>
            <CardDescription>What is live now and what arrives in the next phases.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm">
              {FOUNDATION.map((item) => (
                <li key={item.label} className="flex items-center gap-2">
                  {item.done ? (
                    <CheckCircle2 className="size-4 shrink-0 text-emerald-600" />
                  ) : (
                    <CircleDashed className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className={item.done ? "" : "text-muted-foreground"}>{item.label}</span>
                  {item.phase && (
                    <Badge variant="outline" className="ml-auto">
                      Phase {item.phase}
                    </Badge>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
