import type { Prisma, PrismaClient, ShopifyStoreStatus } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/server/services/audit";
import { fetchAllLocations, refreshShopMetadata } from "./api";
import { attentionCountsByStore, describeError, logSync } from "./sync-log";

/**
 * Shopify store management (Settings → Shopify Stores). Everything returned to UI code is a
 * secret-free projection: encrypted tokens, client-secret overrides and OAuth nonces are
 * never selected.
 */

export type ShopifyStoreErrorCode = "NOT_FOUND" | "BAD_STATUS" | "INVALID_WAREHOUSE" | "INVALID_LOCATION" | "PUBLISH_REQUIRES_LOCATION" | "HAS_HISTORY";

export class ShopifyStoreError extends Error {
  constructor(
    public readonly code: ShopifyStoreErrorCode,
    message: string,
  ) {
    super(message);
  }
}

type Db = PrismaClient | Prisma.TransactionClient;

export const STORE_STATUS_LABEL: Record<ShopifyStoreStatus, string> = {
  PENDING_INSTALL: "Waiting for authorization",
  CONNECTED: "Connected",
  NEEDS_REAUTH: "Needs reconnect",
  UNINSTALLED: "Uninstalled in Shopify",
  DISCONNECTED: "Disconnected",
};

/** Safe projection — no tokens, no secrets, no OAuth state. */
export const storeSafeSelect = {
  id: true,
  name: true,
  shopDomain: true,
  shopGid: true,
  shopName: true,
  currencyCode: true,
  timezone: true,
  status: true,
  apiVersion: true,
  grantedScopes: true,
  accessTokenExpiresAt: true,
  refreshTokenExpiresAt: true,
  installedAt: true,
  uninstalledAt: true,
  ordersImportEnabled: true,
  importTestOrders: true,
  ordersImportSince: true,
  publishEnabled: true,
  publishRule: true,
  publishLocationId: true,
  publishLocationName: true,
  fulfilLocationId: true,
  fulfilLocationName: true,
  lastOrderCheckpointAt: true,
  lastPublishSweepAt: true,
  lastCatalogSyncAt: true,
  lastCustomerSyncAt: true,
  lastWebhookAt: true,
  lastError: true,
  lastErrorAt: true,
  createdAt: true,
  updatedAt: true,
  warehouses: { select: { warehouseId: true, priority: true, warehouse: { select: { id: true, code: true, name: true, status: true } } }, orderBy: { priority: "asc" as const } },
} satisfies Prisma.ShopifyStoreSelect;

export type StoreSafe = Prisma.ShopifyStoreGetPayload<{ select: typeof storeSafeSelect }>;
export type StoreSummary = StoreSafe & { attentionCount: number };

export async function listStores(): Promise<StoreSummary[]> {
  const [stores, attention] = await Promise.all([
    prisma.shopifyStore.findMany({ select: storeSafeSelect, orderBy: [{ status: "asc" }, { name: "asc" }] }),
    attentionCountsByStore(),
  ]);
  return stores.map((s) => ({ ...s, attentionCount: attention.get(s.id) ?? 0 }));
}

export async function getStore(id: string): Promise<StoreSummary | null> {
  const store = await prisma.shopifyStore.findUnique({ where: { id }, select: storeSafeSelect });
  if (!store) return null;
  const attention = await attentionCountsByStore();
  return { ...store, attentionCount: attention.get(id) ?? 0 };
}

export async function storeCounters(): Promise<{ total: number; connected: number; attention: number }> {
  const [total, connected, attention] = await Promise.all([
    prisma.shopifyStore.count(),
    prisma.shopifyStore.count({ where: { status: "CONNECTED" } }),
    attentionCountsByStore().then((m) => [...m.values()].reduce((a, b) => a + b, 0)),
  ]);
  return { total, connected, attention };
}

export type StoreSettingsValues = {
  name: string;
  ordersImportEnabled: boolean;
  importTestOrders: boolean;
  ordersImportSince: Date | null;
  publishEnabled: boolean;
  publishLocationId: string | null;
  fulfilLocationId: string | null;
  /** Ordered: index 0 is the default reservation warehouse. */
  warehouseIds: string[];
};

/**
 * Updates store settings. Location ids are validated against the store's live Shopify
 * locations (names are recorded from Shopify, never from the form). Warehouses must be ACTIVE.
 */
export async function updateStoreSettings(id: string, values: StoreSettingsValues, actorId: string): Promise<void> {
  const current = await prisma.shopifyStore.findUnique({ where: { id }, select: storeSafeSelect });
  if (!current) throw new ShopifyStoreError("NOT_FOUND", "Store not found.");

  const warehouseIds = [...new Set(values.warehouseIds)];
  if (warehouseIds.length) {
    const found = await prisma.warehouse.count({ where: { id: { in: warehouseIds }, status: "ACTIVE" } });
    if (found !== warehouseIds.length) throw new ShopifyStoreError("INVALID_WAREHOUSE", "Choose active warehouses only.");
  }

  let publishLocationName = current.publishLocationName;
  let fulfilLocationName = current.fulfilLocationName;
  const locationChanged = values.publishLocationId !== current.publishLocationId || values.fulfilLocationId !== current.fulfilLocationId;
  if (locationChanged && (values.publishLocationId || values.fulfilLocationId)) {
    if (current.status !== "CONNECTED") throw new ShopifyStoreError("BAD_STATUS", "Connect the store before choosing Shopify locations.");
    const locations = await fetchAllLocations(id);
    const byId = new Map(locations.map((l) => [l.id, l.name]));
    if (values.publishLocationId && !byId.has(values.publishLocationId)) throw new ShopifyStoreError("INVALID_LOCATION", "The selected publish location no longer exists in Shopify.");
    if (values.fulfilLocationId && !byId.has(values.fulfilLocationId)) throw new ShopifyStoreError("INVALID_LOCATION", "The selected fulfilment location no longer exists in Shopify.");
    publishLocationName = values.publishLocationId ? (byId.get(values.publishLocationId) ?? null) : null;
    fulfilLocationName = values.fulfilLocationId ? (byId.get(values.fulfilLocationId) ?? null) : null;
  } else if (!values.publishLocationId) publishLocationName = null;
  if (!values.fulfilLocationId) fulfilLocationName = null;

  if (values.publishEnabled && (!values.publishLocationId || warehouseIds.length === 0)) {
    throw new ShopifyStoreError("PUBLISH_REQUIRES_LOCATION", "Publishing needs a Shopify location and at least one warehouse.");
  }

  await prisma.$transaction(async (tx) => {
    await tx.shopifyStore.update({
      where: { id },
      data: {
        name: values.name,
        ordersImportEnabled: values.ordersImportEnabled,
        importTestOrders: values.importTestOrders,
        ordersImportSince: values.ordersImportSince,
        publishEnabled: values.publishEnabled,
        publishLocationId: values.publishLocationId,
        publishLocationName,
        fulfilLocationId: values.fulfilLocationId,
        fulfilLocationName,
      },
    });
    // The compare-and-set baseline (`lastPublishedAvailable`) belongs to the location it was written to. A new
    // publish location holds its own quantities, so the baseline is dropped: the next publish of every SKU starts
    // from that location's current value (first-publish semantics) instead of failing as a permanent conflict.
    const publishLocationChanged = values.publishLocationId !== current.publishLocationId;
    if (publishLocationChanged) await tx.shopifyVariantMapping.updateMany({ where: { storeId: id }, data: { lastPublishedAvailable: null, lastPublishedAt: null } });
    await tx.shopifyStoreWarehouse.deleteMany({ where: { storeId: id, warehouseId: { notIn: warehouseIds } } });
    for (const [priority, warehouseId] of warehouseIds.entries()) {
      await tx.shopifyStoreWarehouse.upsert({
        where: { storeId_warehouseId: { storeId: id, warehouseId } },
        create: { storeId: id, warehouseId, priority },
        update: { priority },
      });
    }
    await recordAudit(
      {
        userId: actorId,
        action: "shopify_store.settings_changed",
        entityType: "ShopifyStore",
        entityId: id,
        oldValues: {
          name: current.name,
          ordersImportEnabled: current.ordersImportEnabled,
          importTestOrders: current.importTestOrders,
          ordersImportSince: current.ordersImportSince,
          publishEnabled: current.publishEnabled,
          publishLocationId: current.publishLocationId,
          fulfilLocationId: current.fulfilLocationId,
          warehouseIds: current.warehouses.map((w) => w.warehouseId),
        },
        newValues: { ...values, warehouseIds, ...(publishLocationChanged ? { publishBaselineReset: true } : {}) },
      },
      tx,
    );
  });
}

/** Admin “Disconnect”: forget the tokens. Does not uninstall the app inside Shopify. */
export async function disconnectStore(id: string, actorId: string): Promise<void> {
  const store = await prisma.shopifyStore.findUnique({ where: { id }, select: { id: true, status: true, shopDomain: true } });
  if (!store) throw new ShopifyStoreError("NOT_FOUND", "Store not found.");
  await prisma.$transaction(async (tx) => {
    await tx.shopifyStore.update({
      where: { id },
      data: { status: "DISCONNECTED", encAccessToken: null, encRefreshToken: null, accessTokenExpiresAt: null, refreshTokenExpiresAt: null, oauthState: null, oauthStateExpiresAt: null, publishEnabled: false },
    });
    await tx.shopifyOutboundJob.updateMany({ where: { storeId: id, status: { in: ["PENDING", "FAILED"] } }, data: { status: "NEEDS_ATTENTION", lastError: "Store disconnected" } });
    await logSync({ storeId: id, direction: "OUTBOUND", entityType: "STORE", operation: "disconnect", status: "SUCCESS", message: `Store disconnected by Admin (${store.shopDomain}). Remove the app in Shopify Admin to revoke access completely.` }, tx);
    await recordAudit({ userId: actorId, action: "shopify_store.disconnected", entityType: "ShopifyStore", entityId: id, oldValues: { status: store.status }, newValues: { status: "DISCONNECTED" } }, tx);
  });
}

/** `app/uninstalled` webhook: the merchant removed the app; tokens are dead. */
export async function markUninstalled(storeId: string, db: Db = prisma): Promise<void> {
  await db.shopifyStore.update({
    where: { id: storeId },
    data: { status: "UNINSTALLED", uninstalledAt: new Date(), encAccessToken: null, encRefreshToken: null, accessTokenExpiresAt: null, refreshTokenExpiresAt: null, oauthState: null, oauthStateExpiresAt: null, publishEnabled: false },
  });
  await db.shopifyOutboundJob.updateMany({ where: { storeId, status: { in: ["PENDING", "FAILED"] } }, data: { status: "NEEDS_ATTENTION", lastError: "App uninstalled in Shopify" } });
}

/** Remove a store that never completed authorization (no history can exist). */
export async function removePendingStore(id: string, actorId: string): Promise<void> {
  const store = await prisma.shopifyStore.findUnique({ where: { id }, select: { status: true, installedAt: true, shopDomain: true } });
  if (!store) throw new ShopifyStoreError("NOT_FOUND", "Store not found.");
  if (store.status !== "PENDING_INSTALL" || store.installedAt) throw new ShopifyStoreError("HAS_HISTORY", "Only stores that were never connected can be removed. Disconnect instead.");
  await prisma.shopifyStore.delete({ where: { id } });
  await recordAudit({ userId: actorId, action: "shopify_store.removed", entityType: "ShopifyStore", entityId: id, oldValues: { shopDomain: store.shopDomain } });
}

/** “Test connection”: live shop + locations query; refreshes the stored snapshot and logs the result. */
export async function testConnection(id: string, actorId: string): Promise<{ shopName: string; locations: { id: string; name: string }[] }> {
  try {
    const { shop, locations } = await refreshShopMetadata(id);
    await logSync({ storeId: id, direction: "OUTBOUND", entityType: "STORE", operation: "test_connection", status: "SUCCESS", message: `Connection OK — ${shop.name} (${locations.length} location${locations.length === 1 ? "" : "s"})` });
    await recordAudit({ userId: actorId, action: "shopify_store.tested", entityType: "ShopifyStore", entityId: id, newValues: { ok: true } });
    return { shopName: shop.name, locations: locations.map((l) => ({ id: l.id, name: l.name })) };
  } catch (err) {
    const detail = describeError(err);
    await prisma.shopifyStore.update({ where: { id }, data: { lastError: detail.slice(0, 1000), lastErrorAt: new Date() } }).catch(() => undefined);
    await logSync({ storeId: id, direction: "OUTBOUND", entityType: "STORE", operation: "test_connection", status: "FAILED", message: "Connection test failed", errorDetail: detail });
    throw err;
  }
}

/** Live Shopify locations for the settings form (empty when not connected). */
export async function listLiveLocations(id: string): Promise<{ id: string; name: string; active: boolean }[]> {
  const store = await prisma.shopifyStore.findUnique({ where: { id }, select: { status: true } });
  if (!store || store.status !== "CONNECTED") return [];
  try {
    return (await fetchAllLocations(id)).map((l) => ({ id: l.id, name: l.name, active: l.isActive }));
  } catch {
    return [];
  }
}
