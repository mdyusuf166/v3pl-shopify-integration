import { registerShipmentHandler } from "@/server/services/fulfillment-hooks";
import { registerInventoryChangeHandler } from "@/server/services/inventory-hooks";
import { enqueueJob } from "./jobs";
import { scheduleAfterResponse } from "./maintenance";
import "./runners";

/**
 * Wires the Shopify integration into the core extension points (D-045, shopify-integration.md §6).
 * Imported once per server process from src/instrumentation.ts (and explicitly by scripts).
 * Handlers run inside core transactions and only insert ShopifyOutboundJob rows — never
 * network calls, never core-table writes.
 */

// Module-instance guard (not `globalThis`): each bundle instance must register into its own copy of the
// core hook arrays; a global flag would let only the first instance register (see runners.ts).
let registered = false;

export function registerShopifyIntegration(): void {
  if (registered) return;
  registered = true;

  // Warehouse shipped an order that exists in Shopify (SHIPPED) or edited its tracking (TRACKING_UPDATED, R-2 / D-051)
  // → push to Shopify. Eligible = the order carries a Shopify reference: Shopify-originated orders always do; a
  // manual V3PL order does once ORDER_CREATE recorded it (D-062). `external` = the change came from Shopify
  // (mirrored fulfilment or an external event): never pushed back, so Shopify-originated fulfillments cannot loop.
  registerShipmentHandler(async (tx, ev) => {
    if (!ev.shopifyStoreId || ev.external) return;
    const order = await tx.order.findUnique({ where: { id: ev.orderId }, select: { shopifyOrderId: true } });
    if (!order?.shopifyOrderId) return; // e.g. manual order whose Shopify creation is still pending / failed
    const store = await tx.shopifyStore.findUnique({ where: { id: ev.shopifyStoreId }, select: { id: true } });
    if (!store) return;
    switch (ev.kind) {
      case "SHIPPED":
        await enqueueJob(tx, { storeId: store.id, type: "FULFILLMENT_CREATE", targetType: "Shipment", targetId: ev.shipmentId, dedupeKey: `fulfillment:${ev.shipmentId}` });
        break;
      case "TRACKING_UPDATED":
        await enqueueJob(tx, { storeId: store.id, type: "TRACKING_UPDATE", targetType: "Shipment", targetId: ev.shipmentId, dedupeKey: `tracking:${ev.shipmentId}` });
        break;
      default:
        return; // unknown future kinds are ignored, never guessed
    }
    // Near-immediate push after the shipping request responds (decision #7); drain/retry remain the fallback.
    scheduleAfterResponse(store.id);
  });

  // Stock changed → re-publish the sellable quantity to every publish-enabled store that
  // maps this SKU and draws from the affected warehouse.
  registerInventoryChangeHandler(async (tx, changes) => {
    const variantIds = [...new Set(changes.map((c) => c.variantId))];
    const warehouseIds = [...new Set(changes.map((c) => c.warehouseId))];
    const mappings = await tx.shopifyVariantMapping.findMany({
      where: {
        variantId: { in: variantIds },
        status: "MATCHED",
        store: { publishEnabled: true, status: "CONNECTED", warehouses: { some: { warehouseId: { in: warehouseIds } } } },
      },
      select: { storeId: true, variantId: true, store: { select: { warehouses: { select: { warehouseId: true } } } } },
    });
    for (const m of mappings) {
      const pool = new Set(m.store.warehouses.map((w) => w.warehouseId));
      const affected = changes.some((c) => c.variantId === m.variantId && pool.has(c.warehouseId));
      if (!affected || !m.variantId) continue;
      await enqueueJob(tx, { storeId: m.storeId, type: "INVENTORY_PUBLISH", targetType: "ProductVariant", targetId: m.variantId, dedupeKey: `publish:${m.storeId}:${m.variantId}` });
      scheduleAfterResponse(m.storeId);
    }
  });
}

registerShopifyIntegration();
