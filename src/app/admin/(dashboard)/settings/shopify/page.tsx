import type { Metadata } from "next";
import Link from "next/link";
import { AlertTriangle, ChevronLeft, ChevronRight, Store } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/layout/page-header";
import { AddStoreDialog } from "@/components/shopify/add-store-dialog";
import { StoreStatusBadge } from "@/components/shopify/shopify-badges";
import { formatDateTime } from "@/lib/format";
import { requireRole } from "@/server/auth/guards";
import { isShopifyConfigured, shopifyEnvProblems } from "@/server/services/shopify/env";
import { listStores } from "@/server/services/shopify/stores";

export const metadata: Metadata = { title: "Shopify Stores" };

const CALLBACK_ERRORS: Record<string, string> = {
  INVALID_SHOP: "Shopify returned an unexpected store domain. Please start again.",
  NOT_FOUND: "That store was not added from V3PL. Use “Add Shopify Store” first.",
  INVALID_HMAC: "The response from Shopify could not be verified. Please try again.",
  INVALID_STATE: "The connection request expired or did not match. Please start again.",
  MISSING_CODE: "Shopify did not return an authorization code. The request may have been declined.",
  TOKEN_EXCHANGE: "Shopify refused to issue an access token. Check the app's Client ID and secret, then try again.",
  NOT_CONFIGURED: "Shopify is not configured on this server yet.",
  UNKNOWN: "Connecting the store failed unexpectedly. Please try again.",
};

export default async function ShopifyStoresPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  await requireRole("ADMIN");
  const { error } = await searchParams;
  const configured = isShopifyConfigured();
  const stores = configured ? await listStores() : [];

  return (
    <>
      <div>
        <Link href="/admin/settings" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ChevronLeft className="size-4" /> Settings
        </Link>
      </div>
      <PageHeader
        title="Shopify Stores"
        description="Each connected store is a sales channel. Orders are matched to V3PL SKUs line by line; a store never decides who owns a product."
        actions={<AddStoreDialog disabled={!configured} />}
      />

      {!configured && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Shopify is not configured on this server</AlertTitle>
          <AlertDescription>
            Missing or invalid environment variables: <span className="font-mono text-xs">{shopifyEnvProblems().join(", ")}</span>. See docs/shopify-setup.md Part E.
          </AlertDescription>
        </Alert>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Store not connected</AlertTitle>
          <AlertDescription>{CALLBACK_ERRORS[error] ?? CALLBACK_ERRORS.UNKNOWN}</AlertDescription>
        </Alert>
      )}

      {configured && stores.length === 0 ? (
        <EmptyState icon={Store} title="No Shopify stores yet" description="Add the development store first. Live stores follow after the integration passes its test matrix." action={<AddStoreDialog />} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {stores.map((s) => (
            <Link key={s.id} href={`/admin/settings/shopify/${s.id}`} className="group">
              <Card className="h-full transition-colors group-hover:border-primary/50">
                <CardContent className="space-y-3 pt-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{s.name}</p>
                      <p className="truncate text-xs text-muted-foreground">{s.shopDomain}</p>
                    </div>
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <StoreStatusBadge status={s.status} />
                    {s.attentionCount > 0 && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                        <AlertTriangle className="size-3" /> {s.attentionCount} need attention
                      </span>
                    )}
                  </div>
                  <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                    <dt className="text-muted-foreground">Last webhook</dt>
                    <dd className="text-right tabular-nums">{formatDateTime(s.lastWebhookAt)}</dd>
                    <dt className="text-muted-foreground">Orders import</dt>
                    <dd className="text-right">{s.ordersImportEnabled ? "On" : "Off"}</dd>
                    <dt className="text-muted-foreground">Inventory publish</dt>
                    <dd className="text-right">{s.publishEnabled ? "On" : "Off"}</dd>
                  </dl>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
