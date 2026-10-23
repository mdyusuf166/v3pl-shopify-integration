/**
 * Core capability requests R-1 (fulfillment.recordExternalReference) and R-2
 * (TRACKING_UPDATED shipment hook). Service-level; no HTTP server needed.
 * Creates temporary data and removes it.
 *
 * Usage: npm run e2e:core-requests -- vendor3pl@gmail.com
 */
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });
loadEnv();

const adminEmail = process.argv[2] && process.argv[2].includes("@") ? process.argv[2] : (process.argv[3] ?? "vendor3pl@gmail.com");
const RUN = `cr${Date.now().toString(36)}`.toUpperCase();
const results: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const expectError = async (fn: () => Promise<unknown>, code: string) => {
  try {
    await fn();
    return { hit: false, message: "" };
  } catch (e) {
    return { hit: (e as { code?: string }).code === code, message: (e as Error).message };
  }
};

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const owners = await import("../src/server/services/owners");
  const products = await import("../src/server/services/products");
  const warehouses = await import("../src/server/services/warehouses");
  const receiving = await import("../src/server/services/receiving");
  const orders = await import("../src/server/services/orders");
  const fulfillment = await import("../src/server/services/fulfillment");
  const hooks = await import("../src/server/services/fulfillment-hooks");

  const admin = await prisma.user.findFirstOrThrow({ where: { email: adminEmail, role: "ADMIN" } });
  const created = { ownerIds: [] as string[], productIds: [] as string[], warehouseIds: [] as string[], orderIds: new Set<string>() };
  const events: import("../src/server/services/fulfillment-hooks").ShipmentEvent[] = [];
  const unregister = hooks.registerShipmentHandler(async (_tx, ev) => {
    events.push(ev);
  });

  try {
    const A = await owners.createOwner("VENDOR", { code: `${RUN}-A`, businessName: `CR Vendor ${RUN}`, contactName: null, email: null, phone: null, addressLine1: null, addressLine2: null, city: null, state: null, postalCode: null, country: null, notes: null }, admin.id);
    created.ownerIds.push(A.id);
    const W = await warehouses.createWarehouse({ code: `${RUN}-W`, name: "CR Warehouse", addressLine1: null, addressLine2: null, city: null, state: null, postalCode: null, country: null, notes: null }, admin.id);
    created.warehouseIds.push(W.id);
    const main = (await warehouses.getDefaultLocation(W.id))!;
    const p = await products.createProduct({ ownerId: A.id, name: "CR Widget", category: null, description: null, notes: null, status: "ACTIVE", variants: [{ sku: `${RUN}-A1`, name: null, barcode: null, price: "5.00", cost: null, status: "ACTIVE" }] }, admin.id);
    created.productIds.push(p.id);
    const v = p.variants[0];
    await receiving.createReceiving({ ownerId: A.id, warehouseId: W.id, reference: `${RUN}-R`, notes: null, lines: [{ variantId: v.id, locationId: main.id, quantity: 50 }] }, admin.id);

    const STORE_A = `${RUN}-STORE-A`;
    const STORE_B = `${RUN}-STORE-B`;
    // Shopify order (store A) shipped in V3PL → SHIPPED hook; then link to Shopify fulfillment (R-1).
    const so = await orders.createExternal({ source: "SHOPIFY", shopify: { storeId: STORE_A, orderId: `${RUN}-7001`, orderName: "#7001" }, warehouseId: W.id, reserve: true, lines: [{ sku: v.sku, quantity: 5, externalLineId: "L1" }] }, null);
    created.orderIds.add(so.orderId);
    const f1 = await fulfillment.startPicking({ orderId: so.orderId, warehouseId: W.id }, admin.id);
    const s1 = await fulfillment.shipFulfillment(f1.id, { carrier: "UPS", trackingNumber: `${RUN}-T1` }, admin.id);
    check("SHIPPED hook carries kind=SHIPPED, external=false, store id", events.length === 1 && events[0].kind === "SHIPPED" && events[0].external === false && events[0].shopifyStoreId === STORE_A && events[0].shipmentId === s1.id);

    // ---------------------------------------------------------------- R-1
    const link1 = await fulfillment.recordExternalReference(f1.id, { shopifyStoreId: STORE_A, shopifyFulfillmentId: "gid://shopify/Fulfillment/9001" }, null);
    const f1db = await prisma.fulfillment.findUniqueOrThrow({ where: { id: f1.id }, include: { shipment: true } });
    const ev1 = await prisma.orderEvent.count({ where: { orderId: so.orderId, type: "shopify_synced" } });
    const audit1 = await prisma.auditLog.count({ where: { entityType: "Fulfillment", entityId: f1.id, action: "shipment.shopify_synced" } });
    check("R-1 valid: link recorded (store, id, shipment.shopifySyncedAt), one order event, one audit row, no stock/status change", link1.updated && f1db.shopifyStoreId === STORE_A && f1db.shopifyFulfillmentId === "gid://shopify/Fulfillment/9001" && !!f1db.shipment?.shopifySyncedAt && f1db.status === "SHIPPED" && ev1 === 1 && audit1 === 1);
    const link2 = await fulfillment.recordExternalReference(f1.id, { shopifyStoreId: STORE_A, shopifyFulfillmentId: "gid://shopify/Fulfillment/9001" }, null);
    const ev2 = await prisma.orderEvent.count({ where: { orderId: so.orderId, type: "shopify_synced" } });
    check("R-1 idempotent: same reference again → updated=false, no second event", link2.updated === false && ev2 === 1);
    const other = await expectError(() => fulfillment.recordExternalReference(f1.id, { shopifyStoreId: STORE_A, shopifyFulfillmentId: "gid://shopify/Fulfillment/9002" }, null), "BAD_STATUS");
    check("R-1 conflict: different id on an already-linked fulfilment → BAD_STATUS", other.hit, other.message);
    const stockBefore = await prisma.inventoryBalance.findUniqueOrThrow({ where: { variantId_warehouseId: { variantId: v.id, warehouseId: W.id } } });
    check("R-1 no stock effect (on hand 45, reserved 0 after shipping 5)", stockBefore.onHand === 45 && stockBefore.reserved === 0);

    // Owner/tenant isolation: another order in store B, ship, try to link with store A's id / store B mismatch.
    const so2 = await orders.createExternal({ source: "SHOPIFY", shopify: { storeId: STORE_B, orderId: `${RUN}-8001`, orderName: "#8001" }, warehouseId: W.id, reserve: true, lines: [{ sku: v.sku, quantity: 2, externalLineId: "L1" }] }, null);
    created.orderIds.add(so2.orderId);
    const f2 = await fulfillment.startPicking({ orderId: so2.orderId, warehouseId: W.id }, admin.id);
    await fulfillment.shipFulfillment(f2.id, { carrier: "DHL" }, admin.id);
    const wrongStore = await expectError(() => fulfillment.recordExternalReference(f2.id, { shopifyStoreId: STORE_A, shopifyFulfillmentId: "gid://shopify/Fulfillment/9100" }, null), "BAD_STATUS");
    check("R-1 isolation: store A reference on a store B order → BAD_STATUS", wrongStore.hit, wrongStore.message);
    const dup = await expectError(() => fulfillment.recordExternalReference(f2.id, { shopifyStoreId: STORE_A, shopifyFulfillmentId: "gid://shopify/Fulfillment/9001" }, null), "BAD_STATUS");
    check("R-1 duplicate: same Shopify fulfillment id cannot be linked to a second fulfilment", dup.hit);
    const okB = await fulfillment.recordExternalReference(f2.id, { shopifyStoreId: STORE_B, shopifyFulfillmentId: "gid://shopify/Fulfillment/9001" }, admin.id);
    check("R-1 same external id is allowed in a different store (unique per store)", okB.updated);
    const so4 = await orders.createExternal({ source: "SHOPIFY", shopify: { storeId: STORE_A, orderId: `${RUN}-7004` }, warehouseId: W.id, reserve: true, lines: [{ sku: v.sku, quantity: 1, externalLineId: "L1" }] }, null);
    created.orderIds.add(so4.orderId);
    const f4 = await fulfillment.startPicking({ orderId: so4.orderId, warehouseId: W.id }, admin.id);
    await fulfillment.shipFulfillment(f4.id, { carrier: "UPS" }, admin.id);
    const dupSameStore = await expectError(() => fulfillment.recordExternalReference(f4.id, { shopifyStoreId: STORE_A, shopifyFulfillmentId: "gid://shopify/Fulfillment/9001" }, null), "BAD_STATUS");
    const f4db = await prisma.fulfillment.findUniqueOrThrow({ where: { id: f4.id } });
    check("R-1 uniqueness: same store + same Shopify id on a second fulfilment → BAD_STATUS via the unique constraint, nothing written", dupSameStore.hit && dupSameStore.message.includes("another V3PL fulfilment") && f4db.shopifyFulfillmentId === null, dupSameStore.message);

    // Manual order (no store) cannot be linked; unshipped fulfilment cannot be linked; invalid inputs.
    const mo = await orders.createOrder({ source: "MANUAL", warehouseId: W.id, reserve: true, lines: [{ variantId: v.id, quantity: 3 }] }, admin.id);
    created.orderIds.add(mo.orderId);
    const f3 = await fulfillment.startPicking({ orderId: mo.orderId, warehouseId: W.id }, admin.id);
    const unshipped = await expectError(() => fulfillment.recordExternalReference(f3.id, { shopifyStoreId: STORE_A, shopifyFulfillmentId: "gid://shopify/Fulfillment/9200" }, null), "BAD_STATUS");
    check("R-1 non-Shopify order / unshipped fulfilment → BAD_STATUS", unshipped.hit, unshipped.message);
    const missing = await expectError(() => fulfillment.recordExternalReference("does-not-exist", { shopifyStoreId: STORE_A, shopifyFulfillmentId: "x" }, null), "NOT_FOUND");
    const blankId = await expectError(() => fulfillment.recordExternalReference(f1.id, { shopifyStoreId: STORE_A, shopifyFulfillmentId: "  " }, null), "INVALID_REFERENCE");
    const blankStore = await expectError(() => fulfillment.recordExternalReference(f1.id, { shopifyStoreId: "", shopifyFulfillmentId: "gid://x" }, null), "INVALID_REFERENCE");
    const noRef = await expectError(() => fulfillment.recordExternalReference(f1.id, undefined as unknown as { shopifyStoreId: string; shopifyFulfillmentId: string }, null), "INVALID_REFERENCE");
    check("R-1 invalid/missing: unknown fulfilment → NOT_FOUND; blank id / blank store / missing ref → INVALID_REFERENCE", missing.hit && blankId.hit && blankStore.hit && noRef.hit);
    check("R-1 authorization: null actor is attributed to the system admin in the audit row", (await prisma.auditLog.findFirst({ where: { entityType: "Fulfillment", entityId: f1.id, action: "shipment.shopify_synced" } }))?.userId === admin.id);

    // ---------------------------------------------------------------- R-2
    events.length = 0;
    const t1 = await fulfillment.updateShipmentTracking(s1.id, { carrier: "UPS", trackingNumber: `${RUN}-T1B`, trackingUrl: "https://example.com/t" }, admin.id);
    check("R-2 tracking change → one TRACKING_UPDATED event with previous/next, external=false", t1.changed && events.length === 1 && events[0].kind === "TRACKING_UPDATED" && events[0].external === false && events[0].tracking?.trackingNumber === `${RUN}-T1B` && events[0].previousTracking?.trackingNumber === `${RUN}-T1` && events[0].shipmentId === s1.id && events[0].shopifyStoreId === STORE_A);
    const t2 = await fulfillment.updateShipmentTracking(s1.id, { carrier: "UPS", trackingNumber: `${RUN}-T1B` }, admin.id);
    const t3 = await fulfillment.updateShipmentTracking(s1.id, { carrier: " UPS ", trackingNumber: ` ${RUN}-T1B ` }, admin.id);
    const evCount = await prisma.orderEvent.count({ where: { orderId: so.orderId, type: "tracking_updated" } });
    check("R-2 idempotent: identical (or whitespace-only) patch → changed=false, no event, no hook", t2.changed === false && t3.changed === false && events.length === 1 && evCount === 1);
    const t4 = await fulfillment.updateShipmentTracking(s1.id, { trackingUrl: "https://example.com/t2" }, null, `${RUN}-EVT-TRK`);
    const t5 = await fulfillment.updateShipmentTracking(s1.id, { trackingUrl: "https://example.com/t3" }, null, `${RUN}-EVT-TRK`);
    const shipDb = await prisma.shipment.findUniqueOrThrow({ where: { id: s1.id } });
    check("R-2 external event: applied once (external=true on hook), replayed event id ignored, other fields untouched", t4.changed && t5.changed === false && events.length === 2 && events[1].external === true && events[1].externalEventId === `${RUN}-EVT-TRK` && shipDb.trackingUrl === "https://example.com/t2" && shipDb.trackingNumber === `${RUN}-T1B` && shipDb.carrier === "UPS");
    const partial = await fulfillment.updateShipmentTracking(s1.id, { service: "Ground" }, admin.id);
    check("R-2 partial patch changes only the given field and fires once", partial.changed && events.length === 3 && events[2].tracking?.service === "Ground" && events[2].tracking?.trackingNumber === `${RUN}-T1B`);
    const nf = await expectError(() => fulfillment.updateShipmentTracking("nope", { carrier: "X" }, admin.id), "NOT_FOUND");
    check("R-2 unknown shipment → NOT_FOUND", nf.hit);
    // External (Shopify-created) fulfilment: hook flagged external so integrations do not push back.
    const so3 = await orders.createExternal({ source: "SHOPIFY", shopify: { storeId: STORE_A, orderId: `${RUN}-7002` }, warehouseId: W.id, reserve: true, lines: [{ sku: v.sku, quantity: 1, externalLineId: "L1" }] }, null);
    created.orderIds.add(so3.orderId);
    const o3 = (await orders.getOrder(so3.orderId))!;
    const ext = await fulfillment.recordExternalShipment(so3.orderId, { lines: [{ orderItemId: o3.items[0].id, quantity: 1 }], carrier: "USPS", externalFulfillmentId: "gid://shopify/Fulfillment/7777", shopifyStoreId: STORE_A, externalEventId: `${RUN}-EVT-EXT` }, null);
    events.length = 0;
    await fulfillment.updateShipmentTracking(ext.shipmentId!, { trackingNumber: `${RUN}-EXT-TRK` }, admin.id);
    check("R-2 tracking edit on an externally created fulfilment is flagged external=true", events.length === 1 && events[0].external === true && events[0].kind === "TRACKING_UPDATED");
    const alreadyLinked = await fulfillment.recordExternalReference(ext.fulfillmentId!, { shopifyStoreId: STORE_A, shopifyFulfillmentId: "gid://shopify/Fulfillment/7777" }, null);
    check("R-1 on a mirrored external fulfilment with the same id is a no-op", alreadyLinked.updated === false);
    // Order source isolation for the hook payload: manual order ships carry shopifyStoreId null.
    // Also: a handler that fails at the DATABASE level must not abort the core transaction.
    const poison = hooks.registerShipmentHandler(async (tx) => {
      await tx.$executeRawUnsafe(`INSERT INTO "TableThatDoesNotExist" VALUES (1)`);
    });
    events.length = 0;
    const sM = await fulfillment.shipFulfillment(f3.id, { carrier: "FedEx", trackingNumber: `${RUN}-M` }, admin.id);
    poison();
    const shippedM = await prisma.shipment.findUnique({ where: { id: sM.id } });
    const moAfter = (await orders.getOrder(mo.orderId))!;
    check("Hook payload for a manual order: shopifyStoreId null, source MANUAL", events.length === 1 && events[0].shopifyStoreId === null && events[0].orderSource === "MANUAL");
    check("A handler failing with a SQL error is rolled back to its savepoint; the shipment still commits", !!shippedM && moAfter.items[0].shippedQty === 3 && moAfter.status === "COMPLETED");
  } finally {
    unregister();
    const all = await prisma.order.findMany({ where: { items: { some: { ownerId: { in: created.ownerIds } } } }, select: { id: true } });
    all.forEach((o) => created.orderIds.add(o.id));
    const orderIds = [...created.orderIds];
    await prisma.inventoryTransaction.deleteMany({ where: { OR: [{ orderId: { in: orderIds } }, { variant: { productId: { in: created.productIds } } }] } });
    await prisma.shipmentItem.deleteMany({ where: { shipment: { orderId: { in: orderIds } } } });
    await prisma.shipment.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.fulfillmentItem.deleteMany({ where: { fulfillment: { orderId: { in: orderIds } } } });
    await prisma.fulfillment.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.orderEvent.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await prisma.inventoryLevel.deleteMany({ where: { variant: { productId: { in: created.productIds } } } });
    await prisma.inventoryBalance.deleteMany({ where: { variant: { productId: { in: created.productIds } } } });
    await prisma.receivingItem.deleteMany({ where: { variant: { productId: { in: created.productIds } } } });
    await prisma.receivingRecord.deleteMany({ where: { ownerId: { in: created.ownerIds } } });
    await prisma.productVariant.deleteMany({ where: { productId: { in: created.productIds } } });
    await prisma.product.deleteMany({ where: { id: { in: created.productIds } } });
    await prisma.location.deleteMany({ where: { warehouseId: { in: created.warehouseIds } } });
    await prisma.warehouse.deleteMany({ where: { id: { in: created.warehouseIds } } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: [...created.ownerIds, ...created.productIds, ...created.warehouseIds, ...orderIds] } }, { entityType: { in: ["ReceivingRecord", "Location", "Shipment", "Fulfillment"] }, createdAt: { gte: new Date(Date.now() - 30 * 60 * 1000) } }] } }).catch(() => undefined);
    await prisma.owner.deleteMany({ where: { id: { in: created.ownerIds } } });
    await prisma.$disconnect();
    console.log("Cleanup done.");
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
