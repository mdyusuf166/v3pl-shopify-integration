import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, CheckCircle2, ChevronLeft } from "lucide-react";
import type { ShopifyMappingStatus, ShopifySyncStatus, ShopifyWebhookEventStatus } from "@/generated/prisma/client";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/common/empty-state";
import { NativeSelect } from "@/components/common/native-select";
import { Pagination } from "@/components/common/pagination";
import { SearchFilterBar } from "@/components/common/search-filter-bar";
import { PageHeader } from "@/components/layout/page-header";
import { ImportUnmatchedDialog, type DestinationOption, type OwnerOption } from "@/components/shopify/import-unmatched-dialog";
import { MappingActions } from "@/components/shopify/mapping-actions";
import { RetryEventButton, RetryJobButton } from "@/components/shopify/retry-buttons";
import { SyncCatalogButton } from "@/components/shopify/sync-catalog-button";
import { SyncCustomersButton } from "@/components/shopify/sync-customers-button";
import { lastCustomerSyncSummary } from "@/server/services/shopify/customers-sync";
import { ImportOrdersSinceDialog, RetryOrderButton, SyncOrdersButton } from "@/components/shopify/order-sync-controls";
import { ForcePublishAllButton, ForcePublishButton, PublishAllButton } from "@/components/shopify/publish-controls";
import { publishingOverview } from "@/server/services/shopify/inventory-publish";
import { EventStatusBadge, JobStatusBadge, StoreStatusBadge, SyncStatusBadge } from "@/components/shopify/shopify-badges";
import { StoreActions } from "@/components/shopify/store-actions";
import { StoreSettingsForm } from "@/components/shopify/store-settings-form";
import { TabLinks } from "@/components/shopify/tab-links";
import { formatDateTime } from "@/lib/format";
import { requireRole } from "@/server/auth/guards";
import { mappingCounts } from "@/server/services/shopify/catalog";
import { listJobs } from "@/server/services/shopify/jobs";
import { listMappings } from "@/server/services/shopify/mapping";
import { listOwnerOptions } from "@/server/services/owners";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getStore, listLiveLocations } from "@/server/services/shopify/stores";
import { listSyncLogs } from "@/server/services/shopify/sync-log";
import { listWebhookEvents } from "@/server/services/shopify/webhooks";
import { listLocations, listWarehouses } from "@/server/services/warehouses";

export const metadata: Metadata = { title: "Shopify store" };

const TABS = ["overview", "settings", "mapping", "orders", "publishing", "log", "webhooks", "jobs"] as const;
const MAPPING_STATUSES: ShopifyMappingStatus[] = ["MATCHED", "UNMATCHED", "CONFLICT", "IGNORED"];
type Tab = (typeof TABS)[number];
const SYNC_STATUSES: ShopifySyncStatus[] = ["SUCCESS", "FAILED", "NEEDS_ATTENTION", "SKIPPED"];
const EVENT_STATUSES: ShopifyWebhookEventStatus[] = ["RECEIVED", "PROCESSING", "PROCESSED", "FAILED", "SKIPPED_DUPLICATE", "SKIPPED_STALE", "IGNORED"];

type Search = { tab?: string; page?: string; status?: string; q?: string; connected?: string };

export default async function ShopifyStoreDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Search> }) {
  await requireRole("ADMIN");
  const { id } = await params;
  const sp = await searchParams;
  const store = await getStore(id);
  if (!store) notFound();
  const mapCounts = await mappingCounts(id);

  const tab: Tab = (TABS as readonly string[]).includes(sp.tab ?? "") ? (sp.tab as Tab) : "overview";
  const page = Math.max(1, Number(sp.page) || 1);
  const base = `/admin/settings/shopify/${id}`;
  const hrefFor = (t: string) => `${base}?tab=${t}`;
  const withParams = (extra: Record<string, string | number | undefined>) => {
    const u = new URLSearchParams({ tab });
    for (const [k, v] of Object.entries({ status: sp.status, q: sp.q, ...extra })) if (v !== undefined && v !== "") u.set(k, String(v));
    return `${base}?${u.toString()}`;
  };
  const connected = store.status === "CONNECTED";

  return (
    <>
      <div>
        <Link href="/admin/settings/shopify" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ChevronLeft className="size-4" /> Shopify Stores
        </Link>
      </div>
      <PageHeader
        title={store.name}
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            <span>{store.shopDomain}</span>
            <StoreStatusBadge status={store.status} />
          </span>
        }
        actions={<StoreActions id={store.id} name={store.name} status={store.status} />}
      />

      {sp.connected && (
        <Alert>
          <CheckCircle2 />
          <AlertTitle>{sp.connected === "reconnected" ? "Store reconnected" : "Store connected"}</AlertTitle>
          <AlertDescription>
            {store.shopName ? `${store.shopName} authorised V3PL.` : "Shopify authorised V3PL."} Review the settings tab to choose the Shopify location and the warehouses this store sells from.
          </AlertDescription>
        </Alert>
      )}
      {store.status === "NEEDS_REAUTH" && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>This store needs to be reconnected</AlertTitle>
          <AlertDescription>{store.lastError ?? "Shopify no longer accepts the stored access. Use Reconnect."}</AlertDescription>
        </Alert>
      )}
      {store.status === "UNINSTALLED" && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>The app was uninstalled in Shopify</AlertTitle>
          <AlertDescription>Synchronisation stopped on {formatDateTime(store.uninstalledAt)}. Use Connect to install it again.</AlertDescription>
        </Alert>
      )}
      {store.status === "PENDING_INSTALL" && (
        <Alert>
          <AlertTriangle />
          <AlertTitle>Waiting for authorization</AlertTitle>
          <AlertDescription>Shopify has not called back yet. Use Connect to start the authorization again if the browser window was closed.</AlertDescription>
        </Alert>
      )}

      <TabLinks
        active={tab}
        hrefFor={hrefFor}
        tabs={[
          { key: "overview", label: "Overview" },
          { key: "settings", label: "Settings" },
          { key: "mapping", label: "Product mapping", count: mapCounts.UNMATCHED + mapCounts.CONFLICT },
          { key: "orders", label: "Orders" },
          { key: "publishing", label: "Publishing" },
          { key: "log", label: "Sync log", count: store.attentionCount },
          { key: "webhooks", label: "Webhooks" },
          { key: "jobs", label: "Outbound jobs" },
        ]}
      />

      {tab === "overview" && <Overview store={store} mapCounts={mapCounts} />}
      {tab === "settings" && <SettingsTab store={store} connected={connected} />}
      {tab === "mapping" && <MappingTab store={store} connected={connected} counts={mapCounts} page={page} status={sp.status} q={sp.q} withParams={withParams} />}
      {tab === "orders" && <OrdersTab store={store} connected={connected} page={page} status={sp.status} q={sp.q} withParams={withParams} />}
      {tab === "publishing" && <PublishingTab store={store} connected={connected} />}
      {tab === "log" && <SyncLogTab storeId={store.id} page={page} status={sp.status} q={sp.q} withParams={withParams} />}
      {tab === "webhooks" && <WebhooksTab storeId={store.id} page={page} status={sp.status} withParams={withParams} />}
      {tab === "jobs" && <JobsTab storeId={store.id} page={page} withParams={withParams} />}
    </>
  );
}

type StoreT = NonNullable<Awaited<ReturnType<typeof getStore>>>;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5 text-sm">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}

async function Overview({ store, mapCounts }: { store: StoreT; mapCounts: Awaited<ReturnType<typeof mappingCounts>> }) {
  const recent = await listSyncLogs({ storeId: store.id, pageSize: 8 });
  const customerSyncSummary = await lastCustomerSyncSummary(store.id);
  const connected = store.status === "CONNECTED";
  const scopes = store.grantedScopes?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card>
        <CardHeader>
          <CardTitle>Store</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="divide-y">
            <Row label="Shopify name">{store.shopName ?? "—"}</Row>
            <Row label="Domain">
              <span className="font-mono text-xs">{store.shopDomain}</span>
            </Row>
            <Row label="Currency">{store.currencyCode ?? "—"}</Row>
            <Row label="Time zone">{store.timezone ?? "—"}</Row>
            <Row label="API version">
              <span className="font-mono text-xs">{store.apiVersion}</span>
            </Row>
            <Row label="Connected">{formatDateTime(store.installedAt)}</Row>
            <Row label="Access renews">{store.accessTokenExpiresAt ? formatDateTime(store.accessTokenExpiresAt) : "—"}</Row>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Synchronisation</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="divide-y">
            <Row label="Orders import">{store.ordersImportEnabled ? `On${store.importTestOrders ? " (incl. test orders)" : ""}` : "Off"}</Row>
            <Row label="Import orders since">{store.ordersImportSince ? formatDateTime(store.ordersImportSince) : "—"}</Row>
            <Row label="Inventory publish">{store.publishEnabled ? "On" : "Off"}</Row>
            <Row label="Publish location">{store.publishLocationName ?? "—"}</Row>
            <Row label="Fulfil from">{store.fulfilLocationName ?? "—"}</Row>
            <Row label="Warehouses">{store.warehouses.length ? store.warehouses.map((w) => w.warehouse.code).join(", ") : "—"}</Row>
            <Row label="Last webhook">{formatDateTime(store.lastWebhookAt)}</Row>
            <Row label="Last order check">{formatDateTime(store.lastOrderCheckpointAt)}</Row>
            <Row label="Last publish sweep">{formatDateTime(store.lastPublishSweepAt)}</Row>
            <Row label="Product mapping">
              {mapCounts.total === 0 ? "Not synced yet" : `${mapCounts.MATCHED} matched · ${mapCounts.UNMATCHED} unmatched · ${mapCounts.CONFLICT} conflicts`}
            </Row>
            <Row label="Last catalog sync">{formatDateTime(store.lastCatalogSyncAt)}</Row>
            <Row label="Customer sync">
              <div className="space-y-1">
                <div>{store.lastCustomerSyncAt ? `Last complete sync ${formatDateTime(store.lastCustomerSyncAt)}` : "Never synced"}</div>
                {customerSyncSummary && <div className="text-xs text-muted-foreground">{customerSyncSummary}</div>}
                <div className="pt-1">
                  <SyncCustomersButton storeId={store.id} disabled={!connected} />
                </div>
              </div>
            </Row>
          </dl>
          {store.lastError && (
            <p className="mt-3 rounded-md bg-red-50 p-2 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
              Last error ({formatDateTime(store.lastErrorAt)}): {store.lastError}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Permissions granted</CardTitle>
        </CardHeader>
        <CardContent>
          {scopes.length === 0 ? (
            <p className="text-sm text-muted-foreground">Not connected yet.</p>
          ) : (
            <ul className="space-y-1">
              {scopes.map((s) => (
                <li key={s} className="font-mono text-xs">
                  {s}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card className="lg:col-span-3">
        <CardHeader>
          <CardTitle>Recent activity</CardTitle>
        </CardHeader>
        <CardContent>
          {recent.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing yet.</p>
          ) : (
            <ul className="divide-y">
              {recent.rows.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                  <span className="flex min-w-0 items-center gap-2">
                    <SyncStatusBadge status={r.status} />
                    <span className="truncate">{r.message}</span>
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{formatDateTime(r.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

async function SettingsTab({ store, connected }: { store: StoreT; connected: boolean }) {
  const [locations, warehouses] = await Promise.all([listLiveLocations(store.id), listWarehouses(false)]);
  const locOptions = [...locations];
  for (const [id, name] of [
    [store.publishLocationId, store.publishLocationName],
    [store.fulfilLocationId, store.fulfilLocationName],
  ] as const) {
    if (id && !locOptions.some((l) => l.id === id)) locOptions.push({ id, name: name ?? id, active: false });
  }
  return (
    <StoreSettingsForm
      storeId={store.id}
      connected={connected}
      locations={locOptions}
      warehouses={warehouses.map((w) => ({ id: w.id, code: w.code, name: w.name }))}
      initial={{
        name: store.name,
        ordersImportEnabled: store.ordersImportEnabled,
        importTestOrders: store.importTestOrders,
        ordersImportSince: store.ordersImportSince ? store.ordersImportSince.toISOString().slice(0, 10) : "",
        publishEnabled: store.publishEnabled,
        publishLocationId: store.publishLocationId ?? "",
        fulfilLocationId: store.fulfilLocationId ?? "",
        warehouseIds: store.warehouses.map((w) => w.warehouseId),
        defaultWarehouseId: store.warehouses[0]?.warehouseId ?? "",
      }}
    />
  );
}

async function MappingTab({ store, connected, counts, page, status, q, withParams }: { store: StoreT; connected: boolean; counts: Awaited<ReturnType<typeof mappingCounts>>; page: number; status?: string; q?: string; withParams: (e: Record<string, string | number | undefined>) => string }) {
  const statusFilter = MAPPING_STATUSES.includes(status as ShopifyMappingStatus) ? (status as ShopifyMappingStatus) : undefined;
  const [result, vendors, clients, activeWarehouses] = await Promise.all([listMappings({ storeId: store.id, page, status: statusFilter, q }), listOwnerOptions("VENDOR"), listOwnerOptions("THREEPL_CLIENT"), listWarehouses(false)]);
  // Import destinations (D-067): every active V3PL warehouse with its active locations; the store's default
  // reservation warehouse is pre-selected. Shopify locations are deliberately not offered here.
  const destinations: DestinationOption[] = await Promise.all(activeWarehouses.map(async (w) => ({ id: w.id, label: `${w.code} — ${w.name}`, locations: await listLocations(w.id) })));
  const owners: OwnerOption[] = [
    ...vendors.map((o) => ({ id: o.id, label: `${o.businessName} (${o.code})`, group: "Vendors" as const })),
    ...clients.map((o) => ({ id: o.id, label: `${o.businessName} (${o.code})`, group: "3PL clients" as const })),
  ];
  const pills: { key: ShopifyMappingStatus | ""; label: string; n: number }[] = [
    { key: "", label: "All", n: counts.total },
    { key: "MATCHED", label: "Matched", n: counts.MATCHED },
    { key: "UNMATCHED", label: "Unmatched", n: counts.UNMATCHED },
    { key: "CONFLICT", label: "Conflicts", n: counts.CONFLICT },
    { key: "IGNORED", label: "Ignored", n: counts.IGNORED },
  ];
  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap gap-2">
          {pills.map((p) => (
            <Link key={p.key} href={withParams({ status: p.key || undefined, page: undefined })} className={`rounded-full border px-3 py-1 text-xs font-medium ${(statusFilter ?? "") === p.key ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground"}`}>
              {p.label} <span className="tabular-nums">{p.n}</span>
            </Link>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SyncCatalogButton storeId={store.id} disabled={!connected} />
          <ImportUnmatchedDialog storeId={store.id} owners={owners} unmatchedCount={counts.UNMATCHED} destinations={destinations} defaultWarehouseId={store.warehouses[0]?.warehouseId ?? null} />
          <Button variant="outline" render={<a href={`/api/shopify/stores/${store.id}/unmatched`} />} disabled={counts.UNMATCHED + counts.CONFLICT === 0}>
            <Download /> Unmatched CSV
          </Button>
        </div>
      </div>
      <SearchFilterBar q={q} placeholder="Search Shopify SKU, product, variant or V3PL SKU…">
        <input type="hidden" name="tab" value="mapping" />
        {statusFilter && <input type="hidden" name="status" value={statusFilter} />}
      </SearchFilterBar>
      <p className="text-xs text-muted-foreground">
        Matching uses the SKU only (trimmed, upper-cased). Titles are never used. Manual mappings are kept across syncs; ignored variants stay ignored until their Shopify SKU changes. Last catalog sync: {formatDateTime(store.lastCatalogSyncAt)}.
      </p>
      {result.rows.length === 0 ? (
        <EmptyState title={counts.total === 0 ? "No Shopify products synced yet" : "No variants match this filter"} description={counts.total === 0 ? "Press “Sync products now” to read the store's products and variants. Nothing is created in V3PL by a sync." : undefined} />
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Shopify product / variant</TableHead>
                <TableHead>Shopify SKU</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden md:table-cell">V3PL SKU · owner</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.rows.map((m) => (
                <TableRow key={m.id}>
                  <TableCell>
                    <p className="font-medium">{m.shopifyProductTitle ?? "Untitled product"}</p>
                    {m.shopifyVariantTitle && <p className="text-xs text-muted-foreground">{m.shopifyVariantTitle}</p>}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{m.shopifySku ?? <span className="text-muted-foreground">— none —</span>}</TableCell>
                  <TableCell>
                    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${m.status === "MATCHED" ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300" : m.status === "CONFLICT" ? "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300" : m.status === "IGNORED" ? "border-border bg-muted text-muted-foreground" : "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300"}`}>
                      {m.status === "MATCHED" ? (m.matchedBy === "MANUAL" ? "Matched (manual)" : "Matched") : m.status === "CONFLICT" ? "Conflict" : m.status === "IGNORED" ? "Ignored" : "Unmatched"}
                    </span>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    {m.variant ? (
                      <Link href={`/admin/products/${m.variant.product.id}`} className="hover:underline">
                        <span className="font-mono text-xs">{m.variant.sku}</span>
                        <span className="block text-xs text-muted-foreground">
                          {m.variant.product.name} · {m.variant.product.owner.businessName}
                        </span>
                      </Link>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <MappingActions storeId={store.id} mappingId={m.id} status={m.status} shopifyLabel={`${m.shopifyProductTitle ?? "Untitled"}${m.shopifyVariantTitle ? ` / ${m.shopifyVariantTitle}` : ""}`} shopifySku={m.shopifySku} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <Pagination page={result.page} pageCount={result.pages} total={result.total} pageSize={result.pageSize} hrefFor={(p) => withParams({ page: p })} />
    </div>
  );
}

async function OrdersTab({ store, connected, page, status, q, withParams }: { store: StoreT; connected: boolean; page: number; status?: string; q?: string; withParams: (e: Record<string, string | number | undefined>) => string }) {
  const statusFilter = SYNC_STATUSES.includes(status as ShopifySyncStatus) ? (status as ShopifySyncStatus) : undefined;
  const result = await listSyncLogs({ storeId: store.id, page, status: statusFilter, q, entityType: "ORDER" });
  const defaultSince = (store.ordersImportSince ?? store.installedAt ?? new Date()).toISOString().slice(0, 10);
  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <p className="text-sm text-muted-foreground">
          Shopify orders become V3PL orders line by line through the product mapping. Orders import is <span className="font-medium text-foreground">{store.ordersImportEnabled ? "on" : "off"}</span>; last reconciliation checkpoint {formatDateTime(store.lastOrderCheckpointAt)}.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <SyncOrdersButton storeId={store.id} disabled={!connected || !store.ordersImportEnabled} />
          <ImportOrdersSinceDialog storeId={store.id} disabled={!connected || !store.ordersImportEnabled} defaultSince={defaultSince} />
        </div>
      </div>
      <SearchFilterBar q={q} placeholder="Search Shopify order name, SKU, message…">
        <input type="hidden" name="tab" value="orders" />
        <NativeSelect name="status" defaultValue={statusFilter ?? ""} className="w-44" aria-label="Status">
          <option value="">All statuses</option>
          {SYNC_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s === "NEEDS_ATTENTION" ? "Needs attention" : s.charAt(0) + s.slice(1).toLowerCase()}
            </option>
          ))}
        </NativeSelect>
      </SearchFilterBar>
      {result.rows.length === 0 ? (
        <EmptyState title="No order activity yet" description="Imports, updates, cancellations and refunds from Shopify appear here as soon as they arrive." />
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>What</TableHead>
                <TableHead className="hidden lg:table-cell">V3PL order</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">{formatDateTime(r.createdAt)}</TableCell>
                  <TableCell>
                    <SyncStatusBadge status={r.status} />
                  </TableCell>
                  <TableCell>
                    <p className="text-sm">{r.message}</p>
                    <p className="text-xs text-muted-foreground">
                      {r.operation.replace("order_", "")}
                      {r.externalId ? ` · Shopify order id ${r.externalId}` : ""}
                    </p>
                  </TableCell>
                  <TableCell className="hidden text-xs lg:table-cell">
                    {r.order ? (
                      <Link href={`/admin/orders/${r.order.id}`} className="underline underline-offset-4">
                        Order {r.order.orderNumber}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className="text-right">{(r.status === "NEEDS_ATTENTION" || r.status === "FAILED") && r.externalId && connected && <RetryOrderButton storeId={store.id} shopifyOrderId={r.externalId} />}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <Pagination page={result.page} pageCount={result.pages} total={result.total} pageSize={result.pageSize} hrefFor={(p) => withParams({ page: p })} />
    </div>
  );
}

async function PublishingTab({ store, connected }: { store: StoreT; connected: boolean }) {
  const view = await publishingOverview(store.id);
  const publishable = view.rows.filter((r) => r.publishable);
  const drifted = view.rows.filter((r) => r.drift !== null && r.drift !== 0).length;
  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <p className="text-sm text-muted-foreground">
          Inventory publishing is <span className="font-medium text-foreground">{view.publishEnabled ? "on" : "off"}</span>
          {view.locationName ? <> → Shopify location <span className="font-medium text-foreground">{view.locationName}</span></> : null}. Published quantity = available across the store&apos;s warehouses. Shopify never changes V3PL stock. Last sweep {formatDateTime(store.lastPublishSweepAt)}.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <PublishAllButton storeId={store.id} disabled={!connected || !view.publishEnabled || publishable.length === 0} />
          <ForcePublishAllButton storeId={store.id} count={publishable.length} disabled={!connected || !view.publishEnabled || publishable.length === 0} />
        </div>
      </div>
      {!view.publishEnabled && (
        <Alert>
          <AlertTriangle />
          <AlertTitle>Publishing is off</AlertTitle>
          <AlertDescription>Switch it on in the Settings tab once the product mapping has been reviewed. Enabling it publishes every matched SKU once, using Shopify&apos;s current quantities as the safety baseline.</AlertDescription>
        </Alert>
      )}
      {view.rows.length === 0 ? (
        <EmptyState title="No matched SKUs" description="Only matched product mappings can be published. Sync and map products first." />
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>V3PL SKU</TableHead>
                <TableHead className="hidden md:table-cell">Shopify product</TableHead>
                <TableHead className="text-right">V3PL available</TableHead>
                <TableHead className="text-right">Last published</TableHead>
                <TableHead className="hidden lg:table-cell">Published at</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-xs">{r.variant?.sku ?? "—"}</TableCell>
                  <TableCell className="hidden text-sm md:table-cell">
                    {r.shopifyProductTitle ?? "—"}
                    {r.shopifyVariantTitle ? <span className="text-muted-foreground"> / {r.shopifyVariantTitle}</span> : null}
                    {!r.publishable && <span className="ml-2 text-xs text-amber-700">no Shopify inventory item</span>}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{r.available}</TableCell>
                  <TableCell className={`text-right tabular-nums ${r.drift ? "text-amber-700" : ""}`}>{r.lastPublishedAvailable ?? "—"}{r.drift ? ` (${r.drift > 0 ? "+" : ""}${r.drift})` : ""}</TableCell>
                  <TableCell className="hidden text-xs text-muted-foreground lg:table-cell">{formatDateTime(r.lastPublishedAt)}</TableCell>
                  <TableCell className="text-right">{connected && view.publishEnabled && r.publishable && r.variantId && <ForcePublishButton storeId={store.id} variantId={r.variantId} sku={r.variant?.sku ?? ""} />}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {drifted > 0 && <p className="text-xs text-muted-foreground">{drifted} SKU{drifted === 1 ? "" : "s"} differ from the last published value; they are republished automatically after each stock change and by the daily sweep.</p>}
    </div>
  );
}

async function SyncLogTab({ storeId, page, status, q, withParams }: { storeId: string; page: number; status?: string; q?: string; withParams: (e: Record<string, string | number | undefined>) => string }) {
  const statusFilter = SYNC_STATUSES.includes(status as ShopifySyncStatus) ? (status as ShopifySyncStatus) : undefined;
  const result = await listSyncLogs({ storeId, page, status: statusFilter, q });
  return (
    <div className="space-y-4">
      <SearchFilterBar q={q} placeholder="Search messages, SKUs, order ids…">
        <input type="hidden" name="tab" value="log" />
        <NativeSelect name="status" defaultValue={statusFilter ?? ""} className="w-44" aria-label="Status">
          <option value="">All statuses</option>
          {SYNC_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s === "NEEDS_ATTENTION" ? "Needs attention" : s.charAt(0) + s.slice(1).toLowerCase()}
            </option>
          ))}
        </NativeSelect>
      </SearchFilterBar>
      {result.rows.length === 0 ? (
        <EmptyState title="No sync activity" description="Connection events, order imports, fulfilment pushes and inventory publishes will appear here." />
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>What</TableHead>
                <TableHead className="hidden md:table-cell">Direction</TableHead>
                <TableHead className="hidden lg:table-cell">References</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">{formatDateTime(r.createdAt)}</TableCell>
                  <TableCell>
                    <SyncStatusBadge status={r.status} />
                  </TableCell>
                  <TableCell>
                    <p className="text-sm">{r.message}</p>
                    <p className="text-xs text-muted-foreground">
                      {r.entityType.toLowerCase()} · {r.operation}
                      {r.previousValue !== null || r.newValue !== null ? ` · ${r.previousValue ?? "—"} → ${r.newValue ?? "—"}` : ""}
                    </p>
                    {r.errorDetail && <p className="mt-1 max-w-xl truncate font-mono text-[11px] text-muted-foreground" title={r.errorDetail}>{r.errorDetail}</p>}
                  </TableCell>
                  <TableCell className="hidden text-xs md:table-cell">{r.direction === "INBOUND" ? "Shopify → V3PL" : "V3PL → Shopify"}</TableCell>
                  <TableCell className="hidden text-xs lg:table-cell">
                    {r.order ? (
                      <Link href={`/admin/orders/${r.order.id}`} className="underline underline-offset-4">
                        Order {r.order.orderNumber}
                      </Link>
                    ) : (
                      <span className="font-mono">{r.externalId ?? r.internalId ?? "—"}</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <Pagination page={result.page} pageCount={result.pages} total={result.total} pageSize={result.pageSize} hrefFor={(p) => withParams({ page: p })} />
    </div>
  );
}

async function WebhooksTab({ storeId, page, status, withParams }: { storeId: string; page: number; status?: string; withParams: (e: Record<string, string | number | undefined>) => string }) {
  const statusFilter = EVENT_STATUSES.includes(status as ShopifyWebhookEventStatus) ? (status as ShopifyWebhookEventStatus) : undefined;
  const result = await listWebhookEvents({ storeId, page, status: statusFilter });
  return (
    <div className="space-y-4">
      <form method="get" className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="tab" value="webhooks" />
        <NativeSelect name="status" defaultValue={statusFilter ?? ""} className="w-44" aria-label="Status" onChange={undefined}>
          <option value="">All statuses</option>
          {EVENT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s.charAt(0) + s.slice(1).toLowerCase().replace("_", " ")}
            </option>
          ))}
        </NativeSelect>
        <button type="submit" className="h-8 rounded-lg border px-3 text-sm">
          Apply
        </button>
      </form>
      {result.rows.length === 0 ? (
        <EmptyState title="No webhooks received" description="Deliveries from Shopify appear here as soon as the webhook subscriptions are configured in the Dev Dashboard." />
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Received</TableHead>
                <TableHead>Topic</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden md:table-cell">Attempts</TableHead>
                <TableHead className="hidden lg:table-cell">Detail</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.rows.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">{formatDateTime(e.receivedAt)}</TableCell>
                  <TableCell className="font-mono text-xs">{e.topic}</TableCell>
                  <TableCell>
                    <EventStatusBadge status={e.status} />
                  </TableCell>
                  <TableCell className="hidden text-xs tabular-nums md:table-cell">
                    {e.attempts}
                    {e.nextRetryAt ? ` · retry ${formatDateTime(e.nextRetryAt)}` : ""}
                  </TableCell>
                  <TableCell className="hidden max-w-md truncate text-xs text-muted-foreground lg:table-cell" title={e.error ?? undefined}>
                    {e.error ?? (e.processedAt ? `Processed ${formatDateTime(e.processedAt)}` : "—")}
                  </TableCell>
                  <TableCell className="text-right">{(e.status === "FAILED" || e.status === "IGNORED") && <RetryEventButton eventId={e.id} storeId={storeId} />}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <Pagination page={result.page} pageCount={result.pages} total={result.total} pageSize={result.pageSize} hrefFor={(p) => withParams({ page: p })} />
    </div>
  );
}

async function JobsTab({ storeId, page, withParams }: { storeId: string; page: number; withParams: (e: Record<string, string | number | undefined>) => string }) {
  const result = await listJobs({ storeId, page });
  return (
    <div className="space-y-4">
      {result.rows.length === 0 ? (
        <EmptyState title="No outbound jobs" description="Fulfilment pushes and inventory publishes queued for Shopify appear here." />
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Created</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden md:table-cell">Target</TableHead>
                <TableHead className="hidden lg:table-cell">Detail</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.rows.map((j) => (
                <TableRow key={j.id}>
                  <TableCell className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">{formatDateTime(j.createdAt)}</TableCell>
                  <TableCell className="text-xs">{j.type.toLowerCase().replace("_", " ")}</TableCell>
                  <TableCell>
                    <JobStatusBadge status={j.status} />
                  </TableCell>
                  <TableCell className="hidden font-mono text-xs md:table-cell">
                    {j.targetType} {j.targetId}
                  </TableCell>
                  <TableCell className="hidden max-w-md truncate text-xs text-muted-foreground lg:table-cell" title={j.lastError ?? undefined}>
                    {j.lastError ?? `${j.attempts} attempt${j.attempts === 1 ? "" : "s"}`}
                  </TableCell>
                  <TableCell className="text-right">{(j.status === "FAILED" || j.status === "NEEDS_ATTENTION") && <RetryJobButton jobId={j.id} storeId={storeId} />}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <Pagination page={result.page} pageCount={result.pages} total={result.total} pageSize={result.pageSize} hrefFor={(p) => withParams({ page: p })} />
    </div>
  );
}
