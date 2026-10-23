/**
 * Core hook registry per module instance (production bug, 2026-09-15): the handler arrays in
 * fulfillment-hooks.ts / inventory-hooks.ts are module state, and the Turbopack server bundle holds separate
 * instances of them for instrumentation, route handlers and server actions. Registration by instrumentation.ts
 * landed in an instance the shipping server action never used, so a V3PL shipment of a Shopify-linked order
 * enqueued no FULFILLMENT_CREATE job (V3PL 1586 / Shopify #1010 stayed Unfulfilled) and stock changes enqueued no
 * INVENTORY_PUBLISH job. Fix: the hooks lazily import the Shopify registration into THEIR OWN instance before
 * reading the registry (same pattern as jobs.ts `ensureRunnersRegistered`).
 *
 * Proves:
 *  - a fresh process that never imports register.ts starts with empty registries and, on the first stock change,
 *    self-registers and enqueues INVENTORY_PUBLISH for the mapped SKU only;
 *  - a SECOND fresh process (child) that only imports the fulfilment service ships a Shopify-linked manual order and
 *    enqueues FULFILLMENT_CREATE;
 *  - Shopify-originated behaviour unchanged: shipped Shopify order → FULFILLMENT_CREATE; external (mirrored)
 *    shipment → no push; tracking edit → TRACKING_UPDATE; manual order without a Shopify reference → nothing;
 *  - through the BUILT server: `shipFulfillmentAction` (its own bundle instance) enqueues FULFILLMENT_CREATE and
 *    re-enqueues INVENTORY_PUBLISH.
 *
 * Usage: npm run build && npx next start -p 3100 ; npm run e2e:hooks -- http://localhost:3100 vendor3pl@gmail.com
 */
import { execFileSync } from "node:child_process";
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });
loadEnv();

const argv = process.argv.slice(2);
const results: { name: string; ok: boolean; skipped?: boolean }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const skip = (name: string, why: string) => {
  results.push({ name, ok: true, skipped: true });
  console.log(`SKIP  ${name} — ${why}`);
};
const actionRef = (exportName: string) => new RegExp(`createServerReference\\)\\("([0-9a-f]+)"[^)]*"${exportName}"\\)`);

/** Child mode: a genuinely fresh module graph that only knows the fulfilment service. */
async function childShip(fulfillmentId: string) {
  const hooks = await import("../src/server/services/fulfillment-hooks");
  const invHooks = await import("../src/server/services/inventory-hooks");
  const before = { ship: hooks.shipmentHandlerCount(), inv: invHooks.inventoryHandlerCount() };
  const fulfillment = await import("../src/server/services/fulfillment");
  const { prisma } = await import("../src/lib/prisma");
  const admin = await prisma.user.findFirstOrThrow({ where: { role: "ADMIN" }, orderBy: { createdAt: "asc" } });
  const shipment = await fulfillment.shipFulfillment(fulfillmentId, { carrier: "UPS", trackingNumber: `1Z-child-${Date.now()}` }, admin.id);
  const job = await prisma.shopifyOutboundJob.findUnique({ where: { dedupeKey: `fulfillment:${shipment.id}` } });
  console.log(JSON.stringify({ before, after: { ship: hooks.shipmentHandlerCount(), inv: invHooks.inventoryHandlerCount() }, shipmentId: shipment.id, job: job ? { type: job.type, status: job.status, storeId: job.storeId } : null }));
  await prisma.$disconnect();
}

async function main() {
  if (argv[0] === "--child-ship") return childShip(argv[1]);
  const [base = "http://localhost:3100", adminEmail = "vendor3pl@gmail.com"] = argv;
  const RUN = `hk${Date.now().toString(36)}`.toUpperCase();

  // Deliberately NOT importing register.ts / instrumentation: this process must self-register on first use.
  const { prisma } = await import("../src/lib/prisma");
  const fhooks = await import("../src/server/services/fulfillment-hooks");
  const ihooks = await import("../src/server/services/inventory-hooks");
  check("in-process: a fresh instance starts with EMPTY shipment + inventory registries (nothing registered them)", fhooks.shipmentHandlerCount() === 0 && ihooks.inventoryHandlerCount() === 0);

  const owners = await import("../src/server/services/owners");
  const users = await import("../src/server/services/users");
  const products = await import("../src/server/services/products");
  const warehouses = await import("../src/server/services/warehouses");
  const receiving = await import("../src/server/services/receiving");
  const orders = await import("../src/server/services/orders");
  const fulfillment = await import("../src/server/services/fulfillment");
  const { productFormSchema } = await import("../src/lib/validation/products");
  const admin = await prisma.user.findFirstOrThrow({ where: { email: adminEmail, role: "ADMIN" } });
  const created = { ownerIds: [] as string[], warehouseIds: [] as string[], storeIds: [] as string[], userIds: [] as string[], firebaseUids: [] as string[], orderIds: new Set<string>() };
  const sku = (s: string) => `${RUN}-${s}`;
  const shipTo = (n: string) => ({ customerName: `${n} ${RUN}`, customerEmail: `${n.toLowerCase()}.${RUN.toLowerCase()}@example.com`, shipName: `${n} ${RUN}`, shipAddress1: "1 Hook St", shipCity: "Austin", shipCountry: "US" });
  const jobFor = (dedupeKey: string) => prisma.shopifyOutboundJob.findUnique({ where: { dedupeKey } });

  try {
    const V = await owners.createOwner("VENDOR", { code: `${RUN}-V`, businessName: `HK Vendor ${RUN}`, contactName: "Contact", email: null, phone: null, addressLine1: null, addressLine2: null, city: "Austin", state: null, postalCode: null, country: "US", notes: null }, admin.id);
    created.ownerIds.push(V.id);
    const W = await warehouses.createWarehouse({ code: `${RUN}-W`, name: "HK Warehouse", addressLine1: null, addressLine2: null, city: "Dallas", state: null, postalCode: null, country: "US", notes: null }, admin.id);
    created.warehouseIds.push(W.id);
    const main = (await warehouses.getDefaultLocation(W.id))!;
    const p = await products.createProduct(productFormSchema.parse({ ownerId: V.id, name: `HK Widget ${RUN}`, status: "ACTIVE", variants: [{ sku: sku("M"), price: "10.00", status: "ACTIVE" }, { sku: sku("U"), price: "10.00", status: "ACTIVE" }] }), admin.id);
    const M = p.variants.find((v) => v.sku === sku("M"))!;
    const U = p.variants.find((v) => v.sku === sku("U"))!;
    // Store: CONNECTED, publish-enabled, fed by W, SKU M mapped (U unmapped). No network is ever reached (fake domain).
    const S = await prisma.shopifyStore.create({ data: { name: `HK Store ${RUN}`, shopDomain: `${RUN.toLowerCase()}.myshopify.com`, apiVersion: "2026-07", status: "CONNECTED", publishEnabled: true, publishLocationId: "gid://shopify/Location/1", fulfilLocationId: "gid://shopify/Location/1", grantedScopes: "write_orders", warehouses: { create: { warehouseId: W.id } } } });
    created.storeIds.push(S.id);
    await prisma.shopifyVariantMapping.create({ data: { storeId: S.id, shopifyProductId: `gid://shopify/Product/${RUN}`, shopifyVariantId: `gid://shopify/ProductVariant/${RUN}M`, shopifyInventoryItemId: `gid://shopify/InventoryItem/${RUN}M`, shopifySku: sku("M"), variantId: M.id, status: "MATCHED", matchedBy: "SKU_EXACT" } });

    // ---------------------------------------------------------------- inventory path in THIS fresh instance
    await receiving.createReceiving({ ownerId: V.id, warehouseId: W.id, reference: `${RUN}-RC`, notes: null, lines: [{ variantId: M.id, locationId: main.id, quantity: 20 }, { variantId: U.id, locationId: main.id, quantity: 20 }] }, admin.id);
    const pubM = await jobFor(`publish:${S.id}:${M.id}`);
    check("in-process: first stock change self-registers the Shopify handlers into THIS instance (1 shipment + 1 inventory handler)", fhooks.shipmentHandlerCount() === 1 && ihooks.inventoryHandlerCount() === 1, `${fhooks.shipmentHandlerCount()}/${ihooks.inventoryHandlerCount()}`);
    check("in-process: the receipt enqueued INVENTORY_PUBLISH for the mapped SKU (publish:{store}:{variant}) and nothing for the unmapped one", !!pubM && pubM.type === "INVENTORY_PUBLISH" && pubM.status === "PENDING" && pubM.storeId === S.id && (await jobFor(`publish:${S.id}:${U.id}`)) === null);
    await ihooks.ensureInventoryHandlersRegistered();
    await fhooks.ensureShipmentHandlersRegistered();
    check("in-process: ensure* is idempotent (register.ts guard) — still exactly one handler each", fhooks.shipmentHandlerCount() === 1 && ihooks.inventoryHandlerCount() === 1);

    // ---------------------------------------------------------------- shipment path in a SECOND fresh process (child)
    const oManual = await orders.createOrder({ source: "MANUAL", ...shipTo("Ada"), warehouseId: W.id, reserve: true, lines: [{ variantId: M.id, quantity: 2 }] }, admin.id);
    created.orderIds.add(oManual.orderId);
    // Simulate the recorded ORDER_CREATE reference (what happened to V3PL 1586 → Shopify #1010).
    await prisma.order.update({ where: { id: oManual.orderId }, data: { shopifyStoreId: S.id, shopifyOrderId: `gid://shopify/Order/${RUN}1010`, shopifyOrderName: "#1010", shopifyOutboundStatus: "CREATED" } });
    const items = await prisma.orderItem.findMany({ where: { orderId: oManual.orderId } });
    const fManual = await fulfillment.startPicking({ orderId: oManual.orderId, warehouseId: W.id, lines: items.map((i) => ({ orderItemId: i.id, quantity: i.quantity })) }, admin.id);
    let child: { before: { ship: number; inv: number }; after: { ship: number; inv: number }; shipmentId: string; job: { type: string; status: string; storeId: string } | null } | null = null;
    try {
      const out = execFileSync("node_modules/.bin/tsx", ["scripts/e2e-hook-registry-check.ts", "--child-ship", fManual.id], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
      child = JSON.parse(out.trim().split("\n").filter((l) => l.startsWith("{")).pop() ?? "null");
    } catch (err) {
      console.log(`      (child process failed: ${(err as Error).message.slice(0, 200)})`);
    }
    check("child process (fresh module graph, register.ts never imported): registries start empty, shipping the Shopify-linked MANUAL order self-registers and enqueues FULFILLMENT_CREATE (fulfillment:{shipmentId}) for the linked store", !!child && child.before.ship === 0 && child.before.inv === 0 && child.after.ship === 1 && child.after.inv === 1 && child.job?.type === "FULFILLMENT_CREATE" && child.job.status === "PENDING" && child.job.storeId === S.id, child ? JSON.stringify(child) : "no child output");

    // ---------------------------------------------------------------- Shopify-originated behaviour unchanged (this instance)
    const oShop = await orders.createOrder({ source: "SHOPIFY", shopify: { storeId: S.id, orderId: `gid://shopify/Order/${RUN}2001`, orderName: "#2001" }, ...shipTo("Bob"), warehouseId: W.id, reserve: true, lines: [{ variantId: M.id, quantity: 1 }, { variantId: U.id, quantity: 1 }] }, null);
    created.orderIds.add(oShop.orderId);
    const shopItems = await prisma.orderItem.findMany({ where: { orderId: oShop.orderId } });
    const fShop = await fulfillment.startPicking({ orderId: oShop.orderId, warehouseId: W.id, lines: shopItems.filter((i) => i.variantId === M.id).map((i) => ({ orderItemId: i.id, quantity: 1 })) }, admin.id);
    const sShop = await fulfillment.shipFulfillment(fShop.id, { carrier: "UPS", trackingNumber: `1Z${RUN}S` }, admin.id);
    const jShop = await jobFor(`fulfillment:${sShop.id}`);
    check("unchanged: shipping a Shopify-originated order enqueues FULFILLMENT_CREATE exactly as before", !!jShop && jShop.type === "FULFILLMENT_CREATE" && jShop.storeId === S.id);
    await fulfillment.updateShipmentTracking(sShop.id, { carrier: "UPS", trackingNumber: `1Z${RUN}S2` }, admin.id);
    check("unchanged: editing tracking in V3PL enqueues TRACKING_UPDATE (R-2)", (await jobFor(`tracking:${sShop.id}`))?.type === "TRACKING_UPDATE");
    const ext = await fulfillment.recordExternalShipment(oShop.orderId, { lines: shopItems.filter((i) => i.variantId === U.id).map((i) => ({ orderItemId: i.id, quantity: 1 })), carrier: "DHL", trackingNumber: `EXT${RUN}`, externalFulfillmentId: `gid://shopify/Fulfillment/${RUN}`, shopifyStoreId: S.id, externalEventId: `ev-${RUN}` }, null);
    const extShipmentId = (ext as { shipmentId?: string; shipment?: { id: string } }).shipmentId ?? (ext as { shipment?: { id: string } }).shipment?.id ?? (await prisma.shipment.findFirstOrThrow({ where: { orderId: oShop.orderId, trackingNumber: `EXT${RUN}` } })).id;
    check("unchanged: a fulfilment mirrored FROM Shopify (external) is never pushed back — no FULFILLMENT_CREATE job", (await jobFor(`fulfillment:${extShipmentId}`)) === null);
    const oPending = await orders.createOrder({ source: "MANUAL", ...shipTo("Cid"), warehouseId: W.id, reserve: true, lines: [{ variantId: M.id, quantity: 1 }] }, admin.id);
    created.orderIds.add(oPending.orderId);
    await prisma.order.update({ where: { id: oPending.orderId }, data: { shopifyStoreId: S.id, shopifyOutboundStatus: "PENDING" } }); // ORDER_CREATE requested, not yet created
    const pItems = await prisma.orderItem.findMany({ where: { orderId: oPending.orderId } });
    const fPending = await fulfillment.startPicking({ orderId: oPending.orderId, warehouseId: W.id, lines: pItems.map((i) => ({ orderItemId: i.id, quantity: i.quantity })) }, admin.id);
    const sPending = await fulfillment.shipFulfillment(fPending.id, { carrier: "UPS", trackingNumber: `1Z${RUN}P` }, admin.id);
    check("unchanged: a manual order whose Shopify creation is still pending (no shopifyOrderId) is shipped without any push job", (await jobFor(`fulfillment:${sPending.id}`)) === null);

    // ---------------------------------------------------------------- BUILT server: the shipping server action's own bundle instance
    let cookie = "";
    try {
      const { firebaseAdminAuth } = await import("../src/lib/firebase/admin");
      const u = await users.createUserAccount({ name: `HK Admin`, email: `${RUN.toLowerCase()}-admin@example.test`, password: "E2eTestPass123", role: "ADMIN", ownerId: null, phone: null, notes: null }, admin.id);
      created.userIds.push(u.id);
      created.firebaseUids.push(u.firebaseUid);
      const custom = await firebaseAdminAuth().createCustomToken(u.firebaseUid);
      const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${process.env.NEXT_PUBLIC_FIREBASE_API_KEY}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: custom, returnSecureToken: true }) });
      const { idToken } = await r.json();
      const res = await fetch(`${base}/api/auth/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken, audience: "staff" }) });
      cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
    } catch (err) {
      console.log(`      (session unavailable: ${(err as Error).message.slice(0, 100)})`);
    }
    const httpName = "BUILT SERVER: shipFulfillmentAction (server-action bundle instance) ships a Shopify-linked MANUAL order → FULFILLMENT_CREATE enqueued and INVENTORY_PUBLISH re-enqueued for the shipped SKU";
    if (!cookie) skip(httpName, "no session");
    else {
      const oHttp = await orders.createOrder({ source: "MANUAL", ...shipTo("Dee"), warehouseId: W.id, reserve: true, lines: [{ variantId: M.id, quantity: 1 }] }, admin.id);
      created.orderIds.add(oHttp.orderId);
      await prisma.order.update({ where: { id: oHttp.orderId }, data: { shopifyStoreId: S.id, shopifyOrderId: `gid://shopify/Order/${RUN}1011`, shopifyOrderName: "#1011", shopifyOutboundStatus: "CREATED" } });
      const hItems = await prisma.orderItem.findMany({ where: { orderId: oHttp.orderId } });
      const fHttp = await fulfillment.startPicking({ orderId: oHttp.orderId, warehouseId: W.id, lines: hItems.map((i) => ({ orderItemId: i.id, quantity: i.quantity })) }, admin.id);
      await prisma.shopifyOutboundJob.deleteMany({ where: { dedupeKey: `publish:${S.id}:${M.id}` } }); // so the served instance must enqueue it afresh
      const page = await fetch(`${base}/admin/orders/${oHttp.orderId}`, { headers: { Cookie: cookie }, redirect: "manual" });
      const html = await page.text();
      let actionId: string | null = null;
      for (const u of [...new Set([...html.matchAll(/\/_next\/static\/chunks\/[^"'\\\s)]+\.js/g)].map((m) => m[0]))]) {
        const res = await fetch(`${base}${u}`);
        if (!res.ok) continue;
        const m = (await res.text()).match(actionRef("shipFulfillmentAction"));
        if (m) {
          actionId = m[1];
          break;
        }
      }
      if (!actionId) check(httpName, false, `shipFulfillmentAction not found in the chunks served for the order page (status ${page.status})`);
      else {
        const res = await fetch(`${base}/admin/orders/${oHttp.orderId}`, { method: "POST", redirect: "manual", headers: { Cookie: cookie, "Next-Action": actionId, Accept: "text/x-component", "Content-Type": "text/plain;charset=UTF-8" }, body: JSON.stringify([fHttp.id, oHttp.orderId, { carrier: "UPS", trackingNumber: `1Z${RUN}H`, trackingUrl: "" }]) });
        const body = await res.text();
        const shipment = await prisma.shipment.findFirst({ where: { orderId: oHttp.orderId } });
        const jF = shipment ? await jobFor(`fulfillment:${shipment.id}`) : null;
        const jP = await jobFor(`publish:${S.id}:${M.id}`);
        check(httpName, res.status === 200 && !!shipment && !!jF && jF.type === "FULFILLMENT_CREATE" && jF.storeId === S.id && !!jP && jP.type === "INVENTORY_PUBLISH", `status ${res.status} shipment=${shipment ? "yes" : "no"} fulfillment job=${jF?.status ?? "none"} publish job=${jP?.status ?? "none"}${res.status === 404 ? " (404 = action id unknown to this server build: rebuild and restart)" : ""}${!body.includes("shipmentId") && res.status === 200 ? " (no shipmentId in body)" : ""}`);
      }
    }
  } finally {
    // Give the built server's after() drain a moment so cleanup does not race the runner on the fake store.
    await new Promise((r) => setTimeout(r, 1500));
    const { firebaseAdminAuth } = await import("../src/lib/firebase/admin");
    for (const uid of created.firebaseUids) await firebaseAdminAuth().deleteUser(uid).catch(() => undefined);
    const productIds = (await prisma.product.findMany({ where: { ownerId: { in: created.ownerIds } }, select: { id: true } })).map((p) => p.id);
    const all = await prisma.order.findMany({ where: { OR: [{ items: { some: { ownerId: { in: created.ownerIds } } } }, { warehouseId: { in: created.warehouseIds } }] }, select: { id: true } });
    all.forEach((x) => created.orderIds.add(x.id));
    const orderIds = [...created.orderIds];
    await prisma.shopifyOutboundJob.deleteMany({ where: { storeId: { in: created.storeIds } } });
    await prisma.shopifySyncLog.deleteMany({ where: { storeId: { in: created.storeIds } } }).catch(() => undefined);
    await prisma.shopifyVariantMapping.deleteMany({ where: { storeId: { in: created.storeIds } } });
    await prisma.inventoryTransaction.deleteMany({ where: { OR: [{ orderId: { in: orderIds } }, { variant: { productId: { in: productIds } } }, { warehouseId: { in: created.warehouseIds } }] } });
    await prisma.shipmentItem.deleteMany({ where: { shipment: { orderId: { in: orderIds } } } });
    await prisma.shipment.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.fulfillmentItem.deleteMany({ where: { fulfillment: { orderId: { in: orderIds } } } });
    await prisma.fulfillment.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.orderEvent.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await prisma.customer.deleteMany({ where: { email: { endsWith: `${RUN.toLowerCase()}@example.com` } } });
    await prisma.shopifyStore.deleteMany({ where: { id: { in: created.storeIds } } });
    await prisma.inventoryLevel.deleteMany({ where: { OR: [{ variant: { productId: { in: productIds } } }, { warehouseId: { in: created.warehouseIds } }] } });
    await prisma.inventoryBalance.deleteMany({ where: { OR: [{ variant: { productId: { in: productIds } } }, { warehouseId: { in: created.warehouseIds } }] } });
    await prisma.receivingItem.deleteMany({ where: { OR: [{ variant: { productId: { in: productIds } } }, { receiving: { warehouseId: { in: created.warehouseIds } } }] } });
    await prisma.receivingRecord.deleteMany({ where: { OR: [{ ownerId: { in: created.ownerIds } }, { warehouseId: { in: created.warehouseIds } }] } });
    await prisma.productVariant.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.location.deleteMany({ where: { warehouseId: { in: created.warehouseIds } } });
    await prisma.warehouse.deleteMany({ where: { id: { in: created.warehouseIds } } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: [...created.ownerIds, ...productIds, ...created.warehouseIds, ...created.userIds, ...orderIds] } }, { userId: { in: created.userIds } }] } });
    await prisma.user.deleteMany({ where: { id: { in: created.userIds } } });
    await prisma.owner.deleteMany({ where: { id: { in: created.ownerIds } } });
    await prisma.$disconnect();
    console.log("Cleanup done.");
  }
  const failed = results.filter((r) => !r.ok).length;
  const skipped = results.filter((r) => r.skipped).length;
  console.log(`\n${results.length - failed - skipped}/${results.length} checks passed${skipped ? `, ${skipped} skipped` : ""}`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
