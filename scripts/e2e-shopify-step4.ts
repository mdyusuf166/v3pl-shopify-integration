/**
 * Shopify Step 4 end-to-end check: fulfillment push/pull, tracking, inventory publishing, with
 * Shopify simulated in-process (fulfillment orders, fulfillments, inventory levels). Covers:
 * normal fulfillment, partial + multiple shipments, tracking update, retry/idempotency (adoption by
 * remembered id and by tracking number), fulfillment-order move (+ refusal), nothing-to-fulfil,
 * Shopify-created fulfillment mirrored once (reservation consumed once, replay no-op), delivery
 * status → shipment status, cancellation attention, inventory compare-and-set, equal skip, mismatch
 * attention, force publish, activation, publishing disabled, hook-driven publish, daily sweep.
 * Adapts to whether the core capability R-1 (recordExternalReference) is deployed.
 *
 * Usage: npm run e2e:shopify4 -- http://localhost:3100 vendor3pl@gmail.com
 */
import { createHmac } from "node:crypto";
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });
loadEnv();

const [base = "http://localhost:3100", adminEmail = "vendor3pl@gmail.com"] = process.argv.slice(2);
const RUN = `S4${Date.now().toString(36)}`.toUpperCase();
const SHOP = `v3pl-e2e-${RUN.toLowerCase()}.myshopify.com`;
const results: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type OrderNode = import("../src/server/services/shopify/queries").OrderNode;
type OrderLineNode = import("../src/server/services/shopify/queries").OrderLineNode;
type FO = { id: string; status: string; assignedLocation: { location: { id: string; name: string } }; lineItems: { nodes: { id: string; remainingQuantity: number; totalQuantity: number; lineItem: { id: string } }[] } };
type SF = { id: string; status: string; displayStatus: string; createdAt: string; updatedAt: string; trackingInfo: { company: string | null; number: string | null; url: string | null }[]; order: { id: string }; fulfillmentLineItems: { nodes: { quantity: number; lineItem: { id: string } }[] } };

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  await import("../src/server/services/shopify/register");
  const shopifyEnv = (await import("../src/server/services/shopify/env")).shopifyEnv();
  const client = await import("../src/server/services/shopify/client");
  const crypto = await import("../src/server/services/shopify/crypto");
  const oauth = await import("../src/server/services/shopify/oauth");
  const ordersIn = await import("../src/server/services/shopify/orders-in");
  const stores = await import("../src/server/services/shopify/stores");
  const jobs = await import("../src/server/services/shopify/jobs");
  const publish = await import("../src/server/services/shopify/inventory-publish");
  const webhooks = await import("../src/server/services/shopify/webhooks");
  const maintenance = await import("../src/server/services/shopify/maintenance");
  const owners = await import("../src/server/services/owners");
  const products = await import("../src/server/services/products");
  const warehouses = await import("../src/server/services/warehouses");
  const receiving = await import("../src/server/services/receiving");
  const fulfillment = await import("../src/server/services/fulfillment");
  const inventory = await import("../src/server/services/inventory");


  const admin = await prisma.user.findFirstOrThrow({ where: { email: adminEmail, role: "ADMIN" } });
  const created = { ownerIds: [] as string[], productIds: [] as string[], warehouseIds: [] as string[], storeIds: [] as string[], orderIds: new Set<string>() };
  const secret = shopifyEnv.SHOPIFY_API_SECRET;

  // ---------------------------------------------------------------- simulated Shopify
  const LOC1 = "gid://shopify/Location/1";
  const LOC2 = "gid://shopify/Location/2";
  const money = (a: string) => ({ shopMoney: { amount: a } });
  let seq = 100;
  const variantIds = new Map<string, number>();
  const vidFor = (sku: string) => {
    if (!variantIds.has(sku)) variantIds.set(sku, 7000 + variantIds.size);
    return variantIds.get(sku)!;
  };
  const invItem = (sku: string) => `gid://shopify/InventoryItem/${vidFor(sku)}`;
  const line = (sku: string, qty: number): OrderLineNode => {
    const id = ++seq;
    return { id: `gid://shopify/LineItem/${id}`, sku, title: `Item ${sku}`, variantTitle: null, quantity: qty, currentQuantity: qty, requiresShipping: true, variant: { id: `gid://shopify/ProductVariant/${vidFor(sku)}` }, product: { id: `gid://shopify/Product/${vidFor(sku)}` }, originalUnitPriceSet: money("10.00"), totalDiscountSet: money("0.00"), taxLines: [] };
  };
  const addr = { name: "Ayla Buyer", firstName: "Ayla", lastName: "Buyer", company: null, address1: "1 Test St", address2: "", city: "Austin", province: "Texas", provinceCode: "TX", zip: "78701", country: "United States", countryCodeV2: "US", phone: null };
  const orders = new Map<string, OrderNode>();
  const fos = new Map<string, FO[]>();
  const fulfillments = new Map<string, SF[]>();
  const levels = new Map<string, number | null>(); // inventoryItemId → available at LOC1 (null = not stocked)
  const calls = { foMove: 0, fulfillmentCreate: 0, trackingUpdate: 0, inventorySet: 0, inventoryActivate: 0, levelRead: 0, lastCreate: null as unknown, lastSet: null as unknown, setByItem: new Map<string, unknown>(), idemKeys: new Set<string>(), idemReplays: 0, idemRejected: 0 };
  // Admin API 2026-07 behaviour: inventory mutations need @idempotent(key: <uuid>); a repeated key replays the stored result.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const idemStore = new Map<string, unknown>();
  let dropNextSetResponse = false;
  const idempotent = (q: string, v: Record<string, unknown>, field: string, run: () => unknown): Response => {
    const key = v.idempotencyKey;
    if (!new RegExp(`${field}\\([^)]*\\) @idempotent\\(key: \\$idempotencyKey\\)`).test(q) || typeof key !== "string" || !UUID_RE.test(key)) {
      calls.idemRejected++;
      return Response.json({ errors: [{ message: "The @idempotent directive is required for this mutation but was not provided." }] });
    }
    if (idemStore.has(key)) {
      calls.idemReplays++;
      return Response.json(idemStore.get(key));
    }
    calls.idemKeys.add(key);
    const body = run();
    idemStore.set(key, body);
    if (field === "inventorySetQuantities" && dropNextSetResponse) {
      dropNextSetResponse = false; // applied in Shopify, but the response never reaches V3PL
      return new Response("bad gateway", { status: 502 });
    }
    return Response.json(body);
  };
  let refuseMove = false;
  let raceBump = false; // when set, the next inventory level read is followed by an out-of-band +1 in Shopify
  let foLocation = LOC1;
  const mkOrder = (num: number, lines: OrderLineNode[]): OrderNode => {
    const o: OrderNode = { id: `gid://shopify/Order/${num}`, name: `#${num}`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), cancelledAt: null, cancelReason: null, closedAt: null, test: false, displayFinancialStatus: "PAID", displayFulfillmentStatus: "UNFULFILLED", currencyCode: "USD", note: null, tags: [], sourceName: "web", email: `b${num}@example.com`, phone: null, currentSubtotalPriceSet: money("10.00"), currentTotalDiscountsSet: money("0.00"), currentTotalTaxSet: money("0.00"), totalShippingPriceSet: money("0.00"), currentTotalPriceSet: money("10.00"), shippingLines: { nodes: [] }, shippingAddress: addr, lineItems: { nodes: lines } };
    orders.set(o.id, o);
    fos.set(o.id, [{ id: `gid://shopify/FulfillmentOrder/${num}`, status: "OPEN", assignedLocation: { location: { id: foLocation, name: foLocation === LOC1 ? "Main" : "Other" } }, lineItems: { nodes: lines.map((l, i) => ({ id: `gid://shopify/FulfillmentOrderLineItem/${num}${i}`, remainingQuantity: l.quantity, totalQuantity: l.quantity, lineItem: { id: l.id } })) } }]);
    fulfillments.set(o.id, []);
    return o;
  };
  const addShopifyFulfillment = (orderGid: string, lineItems: { lineItemId: string; quantity: number }[], tracking: { company: string | null; number: string | null; url: string | null } | null, displayStatus = "FULFILLED"): SF => {
    const f: SF = { id: `gid://shopify/Fulfillment/${++seq}`, status: "SUCCESS", displayStatus, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), trackingInfo: tracking ? [tracking] : [], order: { id: orderGid }, fulfillmentLineItems: { nodes: lineItems.map((l) => ({ quantity: l.quantity, lineItem: { id: l.lineItemId } })) } };
    fulfillments.get(orderGid)!.push(f);
    for (const fo of fos.get(orderGid) ?? []) for (const li of fo.lineItems.nodes) { const used = lineItems.find((x) => x.lineItemId === li.lineItem.id); if (used) li.remainingQuantity = Math.max(0, li.remainingQuantity - used.quantity); }
    return f;
  };
  const findFulfillment = (id: string) => [...fulfillments.values()].flat().find((f) => f.id === id) ?? null;
  const validTokens = new Set<string>();
  let tokenN = 0;
  client.__setShopifyFetchForTests(async (input, init) => {
    const url = String(input);
    if (!url.startsWith(`https://${SHOP}/`)) return new Response("not found", { status: 404 });
    if (url.endsWith("/admin/oauth/access_token")) {
      tokenN++;
      const token = `shpat_${RUN}_${tokenN}`;
      validTokens.add(token);
      return Response.json({ access_token: token, scope: shopifyEnv.SHOPIFY_SCOPES, expires_in: 86399, refresh_token: `shprt_${RUN}_${tokenN}`, refresh_token_expires_in: 7_776_000 });
    }
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (!validTokens.has(headers["X-Shopify-Access-Token"])) return new Response("{}", { status: 401 });
    const body = JSON.parse(String(init?.body)) as { query: string; variables?: Record<string, unknown> };
    const q = body.query;
    const v = body.variables ?? {};
    if (q.includes("shop {")) return Response.json({ data: { shop: { id: "gid://shopify/Shop/4", name: `E2E ${RUN}`, myshopifyDomain: SHOP, currencyCode: "USD", ianaTimezone: "UTC", plan: null } } });
    if (q.includes("locations(")) return Response.json({ data: { locations: { nodes: [{ id: LOC1, name: "Main", isActive: true, fulfillsOnlineOrders: true, shipsInventory: true, address: null }, { id: LOC2, name: "Other", isActive: true, fulfillsOnlineOrders: true, shipsInventory: true, address: null }], pageInfo: { hasNextPage: false, endCursor: null } } } });
    if (q.includes("fulfillmentOrders(first")) {
      const o = orders.get(String(v.id));
      return Response.json({ data: { order: o ? { id: o.id, fulfillmentOrders: { nodes: fos.get(o.id) ?? [] }, fulfillments: fulfillments.get(o.id) ?? [] } : null } });
    }
    if (q.includes("order(id:")) return Response.json({ data: { order: orders.get(String(v.id)) ?? null } });
    if (q.includes("fulfillmentOrderMove")) {
      calls.foMove++;
      if (refuseMove) return Response.json({ data: { fulfillmentOrderMove: { movedFulfillmentOrder: null, remainingFulfillmentOrder: null, userErrors: [{ field: ["newLocationId"], message: "Location cannot fulfil these items" }] } } });
      for (const list of fos.values()) for (const fo of list) if (fo.id === v.id) fo.assignedLocation = { location: { id: String(v.newLocationId), name: "Main" } };
      return Response.json({ data: { fulfillmentOrderMove: { movedFulfillmentOrder: { id: v.id, assignedLocation: { location: { id: v.newLocationId } } }, remainingFulfillmentOrder: null, userErrors: [] } } });
    }
    if (q.includes("fulfillmentCreate")) {
      calls.fulfillmentCreate++;
      calls.lastCreate = v.fulfillment;
      const input = v.fulfillment as { lineItemsByFulfillmentOrder: { fulfillmentOrderId: string; fulfillmentOrderLineItems: { id: string; quantity: number }[] }[]; trackingInfo?: { company?: string; number?: string; url?: string } };
      const items: { lineItemId: string; quantity: number }[] = [];
      let orderGid = "";
      for (const byFo of input.lineItemsByFulfillmentOrder) {
        for (const [og, list] of fos) for (const fo of list) if (fo.id === byFo.fulfillmentOrderId) {
          orderGid = og;
          for (const it of byFo.fulfillmentOrderLineItems) {
            const li = fo.lineItems.nodes.find((x) => x.id === it.id);
            if (!li || li.remainingQuantity < it.quantity) return Response.json({ data: { fulfillmentCreate: { fulfillment: null, userErrors: [{ field: null, message: "Fulfillment order line item has no remaining quantity" }] } } });
            items.push({ lineItemId: li.lineItem.id, quantity: it.quantity });
          }
        }
      }
      const f = addShopifyFulfillment(orderGid, items, input.trackingInfo ? { company: input.trackingInfo.company ?? null, number: input.trackingInfo.number ?? null, url: input.trackingInfo.url ?? null } : null);
      return Response.json({ data: { fulfillmentCreate: { fulfillment: { id: f.id, status: f.status, displayStatus: f.displayStatus, trackingInfo: f.trackingInfo }, userErrors: [] } } });
    }
    if (q.includes("fulfillmentTrackingInfoUpdate")) {
      calls.trackingUpdate++;
      const f = findFulfillment(String(v.fulfillmentId));
      if (!f) return Response.json({ data: { fulfillmentTrackingInfoUpdate: { fulfillment: null, userErrors: [{ field: null, message: "Fulfillment not found" }] } } });
      const t = v.trackingInfoInput as { company?: string; number?: string; url?: string };
      f.trackingInfo = [{ company: t.company ?? null, number: t.number ?? null, url: t.url ?? null }];
      return Response.json({ data: { fulfillmentTrackingInfoUpdate: { fulfillment: { id: f.id, trackingInfo: f.trackingInfo }, userErrors: [] } } });
    }
    if (q.includes("fulfillment(id:")) return Response.json({ data: { fulfillment: findFulfillment(String(v.id)) } });
    if (q.includes("inventoryItem(id:")) {
      calls.levelRead++;
      const id = String(v.itemId);
      if (!levels.has(id)) return Response.json({ data: { inventoryItem: null } });
      const lvl = levels.get(id)!;
      if (raceBump && lvl !== null) {
        raceBump = false;
        levels.set(id, lvl + 1);
      }
      return Response.json({ data: { inventoryItem: { id, tracked: true, inventoryLevel: lvl === null ? null : { id: `gid://shopify/InventoryLevel/${id.split("/").pop()}`, quantities: [{ name: "available", quantity: lvl }] } } } });
    }
    if (q.includes("inventoryActivate")) {
      return idempotent(q, v, "inventoryActivate", () => {
        calls.inventoryActivate++;
        levels.set(String(v.inventoryItemId), 0);
        return { data: { inventoryActivate: { inventoryLevel: { id: "x", quantities: [{ name: "available", quantity: 0 }] }, userErrors: [] } } };
      });
    }
    if (q.includes("inventorySetQuantities")) {
      return idempotent(q, v, "inventorySetQuantities", () => {
        calls.inventorySet++;
        calls.lastSet = v.input;
        calls.setByItem.set((v.input as { quantities: { inventoryItemId: string }[] }).quantities[0].inventoryItemId, v.input);
        const input = v.input as { ignoreCompareQuantity?: unknown; quantities: { inventoryItemId: string; locationId: string; quantity: number; changeFromQuantity?: number | null; compareQuantity?: unknown }[] };
        const qty = input.quantities[0];
        // 2026-07 schema: compareQuantity / ignoreCompareQuantity no longer exist → the API rejects the variables outright.
        if ("ignoreCompareQuantity" in input || "compareQuantity" in qty) return { errors: [{ message: "Variable $input of type InventorySetQuantitiesInput! was provided invalid value for ignoreCompareQuantity (Field is not defined on InventorySetQuantitiesInput), quantities.0.compareQuantity (Field is not defined on InventoryQuantityInput)" }] };
        const current = levels.get(qty.inventoryItemId) ?? 0;
        if (qty.changeFromQuantity !== null && qty.changeFromQuantity !== undefined && qty.changeFromQuantity !== current) return { data: { inventorySetQuantities: { inventoryAdjustmentGroup: null, userErrors: [{ field: ["input", "quantities", "0", "changeFromQuantity"], message: "The changeFromQuantity value does not match persisted value.", code: "CHANGE_FROM_QUANTITY_STALE" }] } } };
        levels.set(qty.inventoryItemId, qty.quantity);
        return { data: { inventorySetQuantities: { inventoryAdjustmentGroup: { id: "g", changes: [{ name: "available", delta: qty.quantity - current, quantityAfterChange: qty.quantity }] }, userErrors: [] } } };
      });
    }
    return Response.json({ errors: [{ message: `unexpected query in e2e: ${q.slice(0, 60)}` }] });
  });

  const webhookPost = (topic: string, payload: unknown, webhookId: string) => {
    const body = JSON.stringify(payload);
    return fetch(`${base}/api/webhooks/shopify`, { method: "POST", headers: { "Content-Type": "application/json", "X-Shopify-Topic": topic, "X-Shopify-Shop-Domain": SHOP, "X-Shopify-Webhook-Id": webhookId, "X-Shopify-Event-Id": `ev-${webhookId}`, "X-Shopify-API-Version": shopifyEnv.SHOPIFY_API_VERSION, "X-Shopify-Triggered-At": new Date().toISOString(), "X-Shopify-Hmac-Sha256": createHmac("sha256", secret).update(body).digest("base64") }, body });
  };
  const waitForEvent = async (webhookId: string, statuses: string[], timeoutMs = 20_000) => {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const ev = await prisma.shopifyWebhookEvent.findUnique({ where: { webhookId } });
      if (ev && statuses.includes(ev.status)) return ev;
      if (Date.now() > until) return ev;
      await sleep(400);
    }
  };
  const deliver = async (topic: string, payload: unknown, id: string) => {
    await webhookPost(topic, payload, id);
    const ev = await waitForEvent(id, ["FAILED", "PROCESSED"]);
    return webhooks.retryWebhookEventNow(ev!.id);
  };

  try {
    // ---------------------------------------------------------------- V3PL side
    const A = await owners.createOwner("VENDOR", { code: `${RUN}-A`, businessName: `S4 Vendor ${RUN}`, contactName: null, email: null, phone: null, addressLine1: null, addressLine2: null, city: null, state: null, postalCode: null, country: null, notes: null }, admin.id);
    created.ownerIds.push(A.id);
    const W = await warehouses.createWarehouse({ code: `${RUN}-W`, name: "S4 Warehouse", addressLine1: null, addressLine2: null, city: null, state: null, postalCode: null, country: null, notes: null }, admin.id);
    created.warehouseIds.push(W.id);
    const main = (await warehouses.getDefaultLocation(W.id))!;
    const [A1, A2, A3, NEW] = [`${RUN}-A1`, `${RUN}-A2`, `${RUN}-A3`, `${RUN}-NEW`];
    const vin = (sku: string) => ({ sku, name: null, barcode: null, price: "10.00", cost: null, status: "ACTIVE" as const });
    const pA = await products.createProduct({ ownerId: A.id, name: "S4 Product", category: null, description: null, notes: null, status: "ACTIVE", variants: [vin(A1), vin(A2), vin(A3), vin(NEW)] }, admin.id);
    created.productIds.push(pA.id);
    const vid = (sku: string) => pA.variants.find((v) => v.sku === sku)!.id;
    await receiving.createReceiving({ ownerId: A.id, warehouseId: W.id, reference: `${RUN}-R`, notes: null, lines: [{ variantId: vid(A1), locationId: main.id, quantity: 20 }, { variantId: vid(A2), locationId: main.id, quantity: 20 }, { variantId: vid(A3), locationId: main.id, quantity: 20 }] }, admin.id);
    const avail = async (sku: string) => (await inventory.availableForVariants([vid(sku)], [W.id])).get(vid(sku)) ?? 0;
    const onHand = async (sku: string) => (await inventory.stockForVariant(vid(sku))).find((s) => s.warehouse.id === W.id)?.onHand ?? 0;

    // ---------------------------------------------------------------- store (connected, warehouse, fulfil location LOC1)
    const begin = await oauth.beginInstall({ shopDomain: SHOP, name: `S4 Store ${RUN}` }, admin.id);
    created.storeIds.push(begin.storeId);
    const S = begin.storeId;
    const st = new URL(begin.authorizeUrl).searchParams.get("state")!;
    const p = new URLSearchParams({ code: "c", shop: SHOP, state: st, timestamp: String(Math.floor(Date.now() / 1000)) });
    p.set("hmac", crypto.hmacSha256Hex(secret, crypto.oauthQueryMessage(p)));
    await oauth.completeInstall(p, admin.id);
    const settings = (over: Partial<import("../src/server/services/shopify/stores").StoreSettingsValues> = {}) => stores.updateStoreSettings(S, { name: `S4 Store ${RUN}`, ordersImportEnabled: true, importTestOrders: false, ordersImportSince: null, publishEnabled: false, publishLocationId: LOC1, fulfilLocationId: LOC1, warehouseIds: [W.id], ...over }, admin.id);
    await settings();
    // mappings for publishing (MATCHED with inventory items)
    for (const sku of [A1, A2, A3, NEW]) await prisma.shopifyVariantMapping.create({ data: { storeId: S, shopifyProductId: `gid://shopify/Product/${vidFor(sku)}`, shopifyVariantId: `gid://shopify/ProductVariant/${vidFor(sku)}`, shopifyInventoryItemId: invItem(sku), shopifySku: sku, variantId: vid(sku), status: "MATCHED", matchedBy: "SKU_EXACT" } });
    levels.set(invItem(A1), 5);
    levels.set(invItem(A2), 20);
    levels.set(invItem(A3), 20);
    levels.set(invItem(NEW), null); // exists in Shopify but not stocked at LOC1 (activation case)

    const importOrder = async (num: number, lines: OrderLineNode[]) => {
      mkOrder(num, lines);
      const r = await ordersIn.syncShopifyOrder(S, String(num), { cause: "orders/create", eventId: `ev-${RUN}-${num}` });
      const o = await prisma.order.findUniqueOrThrow({ where: { id: r.orderId! }, include: { items: true } });
      created.orderIds.add(o.id);
      return o;
    };
    const shipLines = async (orderId: string, lines: { orderItemId: string; quantity: number }[], tracking: { carrier: string; trackingNumber: string; trackingUrl?: string }) => {
      const f = await fulfillment.startPicking({ orderId, warehouseId: W.id, lines }, admin.id);
      const shipment = await fulfillment.shipFulfillment(f.id, tracking, admin.id);
      return { id: shipment.id, fulfillmentId: f.id };
    };
    const jobFor = (dedupeKey: string) => prisma.shopifyOutboundJob.findUnique({ where: { dedupeKey } });
    const v3plFulfillment = (id: string) => prisma.fulfillment.findUniqueOrThrow({ where: { id }, include: { shipment: true } });

    // ---------------------------------------------------------------- 1. normal fulfillment
    const o1 = await importOrder(2001, [line(A1, 2), line(A2, 1)]);
    const s1 = await shipLines(o1.id, o1.items.map((i) => ({ orderItemId: i.id, quantity: i.quantity })), { carrier: "UPS", trackingNumber: `1Z${RUN}A`, trackingUrl: "https://ups.example/1" });
    let job = await jobFor(`fulfillment:${s1.id}`);
    check("outbound: shipping enqueued one FULFILLMENT_CREATE job (hook)", !!job && job.status === "PENDING");
    await jobs.runDueJobs({ storeId: S });
    job = await jobFor(`fulfillment:${s1.id}`);
    const c1 = calls.lastCreate as { lineItemsByFulfillmentOrder: { fulfillmentOrderId: string; fulfillmentOrderLineItems: { id: string; quantity: number }[] }[]; trackingInfo: { company: string; number: string; url: string }; notifyCustomer: boolean };
    check("outbound: fulfillmentCreate called once with both lines, tracking and notifyCustomer", calls.fulfillmentCreate === 1 && c1.lineItemsByFulfillmentOrder[0].fulfillmentOrderLineItems.map((x) => x.quantity).sort().join() === "1,2" && c1.trackingInfo.company === "UPS" && c1.trackingInfo.number === `1Z${RUN}A` && c1.trackingInfo.url === "https://ups.example/1" && c1.notifyCustomer === true);
    const shopF1 = fulfillments.get("gid://shopify/Order/2001")![0];
    const vf1 = await v3plFulfillment(s1.fulfillmentId);
    check("outbound: R-1 reference persisted — V3PL fulfilment carries the Shopify id + store, shipment shopifySyncedAt set, job DONE", job?.status === "DONE" && vf1.shopifyFulfillmentId === shopF1.id && vf1.shopifyStoreId === S && !!vf1.shipment?.shopifySyncedAt && (job.result as { shopifyFulfillmentId?: string })?.shopifyFulfillmentId === shopF1.id);
    check("outbound: core wrote one shopify_synced order event and the sync log SUCCESS row", (await prisma.orderEvent.count({ where: { orderId: o1.id, type: "shopify_synced" } })) === 1 && (await prisma.shopifySyncLog.count({ where: { storeId: S, entityType: "FULFILLMENT", direction: "OUTBOUND", externalId: shopF1.id, status: "SUCCESS" } })) === 1);
    check("outbound: R-1 replay with the same reference → { updated: false }, nothing changes", (await fulfillment.recordExternalReference(s1.fulfillmentId, { shopifyStoreId: S, shopifyFulfillmentId: shopF1.id }, null)).updated === false && (await prisma.orderEvent.count({ where: { orderId: o1.id, type: "shopify_synced" } })) === 1);

    // retry / idempotency: re-run the job → no second fulfillment, no second link
    await jobs.retryJobNow(job!.id);
    job = await jobFor(`fulfillment:${s1.id}`);
    check("outbound: retrying a DONE job never creates a second Shopify fulfillment (already linked → no-op)", job?.status === "DONE" && calls.fulfillmentCreate === 1 && fulfillments.get("gid://shopify/Order/2001")!.length === 1 && (await prisma.orderEvent.count({ where: { orderId: o1.id, type: "shopify_synced" } })) === 1);

    // ---------------------------------------------------------------- 2. partial + multiple shipments
    const o2 = await importOrder(2002, [line(A1, 3), line(A2, 2), line(A3, 1)]);
    const i = (sku: string) => o2.items.find((x) => x.sku === sku)!;
    const s2a = await shipLines(o2.id, [{ orderItemId: i(A1).id, quantity: 2 }, { orderItemId: i(A2).id, quantity: 2 }], { carrier: "FedEx", trackingNumber: `FX${RUN}1` });
    await jobs.runDueJobs({ storeId: S });
    const s2b = await shipLines(o2.id, [{ orderItemId: i(A1).id, quantity: 1 }, { orderItemId: i(A3).id, quantity: 1 }], { carrier: "FedEx", trackingNumber: `FX${RUN}2` });
    await jobs.runDueJobs({ storeId: S });
    const f2 = fulfillments.get("gid://shopify/Order/2002")!;
    const remaining = fos.get("gid://shopify/Order/2002")![0].lineItems.nodes.map((l) => l.remainingQuantity);
    check("outbound: two partial shipments → two Shopify fulfillments with their own lines and tracking", f2.length === 2 && f2[0].trackingInfo[0].number === `FX${RUN}1` && f2[1].trackingInfo[0].number === `FX${RUN}2` && f2[0].fulfillmentLineItems.nodes.reduce((s, n) => s + n.quantity, 0) === 4 && f2[1].fulfillmentLineItems.nodes.reduce((s, n) => s + n.quantity, 0) === 2 && remaining.every((r) => r === 0));
    void s2a;
    void s2b;

    // ---------------------------------------------------------------- 3. tracking update
    const o3 = await importOrder(2003, [line(A1, 1)]);
    const s3 = await shipLines(o3.id, [{ orderItemId: o3.items[0].id, quantity: 1 }], { carrier: "USPS", trackingNumber: `US${RUN}` });
    await jobs.runDueJobs({ storeId: S });
    await fulfillment.updateShipmentTracking(s3.id, { carrier: "USPS", trackingNumber: `US${RUN}-FIXED`, trackingUrl: "https://usps.example/x" }, admin.id);
    let tj = await jobFor(`tracking:${s3.id}`);
    check("tracking: core TRACKING_UPDATED hook (R-2) enqueued one TRACKING_UPDATE job, no second FULFILLMENT_CREATE", !!tj && tj.status === "PENDING" && (await prisma.shopifyOutboundJob.count({ where: { storeId: S, targetId: s3.id } })) === 2);
    await jobs.runDueJobs({ storeId: S });
    tj = await jobFor(`tracking:${s3.id}`);
    const shopF3 = fulfillments.get("gid://shopify/Order/2003")![0];
    check("tracking: V3PL tracking change pushed to Shopify (carrier, number, URL) on the linked fulfillment", tj?.status === "DONE" && calls.trackingUpdate === 1 && shopF3.trackingInfo[0].number === `US${RUN}-FIXED` && shopF3.trackingInfo[0].url === "https://usps.example/x" && shopF3.trackingInfo[0].company === "USPS");
    const unchanged = await fulfillment.updateShipmentTracking(s3.id, { carrier: "USPS", trackingNumber: `US${RUN}-FIXED`, trackingUrl: "https://usps.example/x" }, admin.id);
    check("tracking: re-saving identical tracking is a core no-op → no new job", unchanged.changed === false && (await jobFor(`tracking:${s3.id}`))!.status === "DONE" && calls.trackingUpdate === 1);
    // tracking edited before the fulfilment push has run → carried by the push, tracking job completes without a second call
    const o3b = await importOrder(2013, [line(A2, 1)]);
    const s3b = await shipLines(o3b.id, [{ orderItemId: o3b.items[0].id, quantity: 1 }], { carrier: "USPS", trackingNumber: `US${RUN}-EARLY` });
    await fulfillment.updateShipmentTracking(s3b.id, { trackingNumber: `US${RUN}-LATE` }, admin.id);
    const tUpdatesBefore = calls.trackingUpdate;
    await jobs.runDueJobs({ storeId: S });
    const shopF3b = fulfillments.get("gid://shopify/Order/2013")![0];
    check("tracking: edit before the push ran → push carries the latest tracking; tracking job DONE without a separate call", (await jobFor(`fulfillment:${s3b.id}`))!.status === "DONE" && (await jobFor(`tracking:${s3b.id}`))!.status === "DONE" && shopF3b.trackingInfo[0].number === `US${RUN}-LATE` && calls.trackingUpdate === tUpdatesBefore);

    // ---------------------------------------------------------------- 4. adoption by tracking number (lost response)
    const o4 = await importOrder(2004, [line(A2, 1)]);
    const pre = addShopifyFulfillment("gid://shopify/Order/2004", [{ lineItemId: o4.items[0].shopifyLineItemId!, quantity: 1 }], { company: "DHL", number: `DH${RUN}`, url: null });
    const s4 = await shipLines(o4.id, [{ orderItemId: o4.items[0].id, quantity: 1 }], { carrier: "DHL", trackingNumber: `DH${RUN}` });
    const createsBefore = calls.fulfillmentCreate;
    await jobs.runDueJobs({ storeId: S });
    const j4 = await jobFor(`fulfillment:${s4.id}`);
    const vf4 = await v3plFulfillment(s4.fulfillmentId);
    check("outbound: existing Shopify fulfillment with the same tracking number is adopted and linked, none created", calls.fulfillmentCreate === createsBefore && j4?.status === "DONE" && vf4.shopifyFulfillmentId === pre.id && !!vf4.shipment?.shopifySyncedAt);

    // ---------------------------------------------------------------- 5. fulfillment order at another location → move; refusal → attention
    foLocation = LOC2;
    const o5 = await importOrder(2005, [line(A3, 1)]);
    const s5 = await shipLines(o5.id, [{ orderItemId: o5.items[0].id, quantity: 1 }], { carrier: "UPS", trackingNumber: `MV${RUN}` });
    await jobs.runDueJobs({ storeId: S });
    check("outbound: fulfillment order moved to the store's fulfil location before fulfilling", calls.foMove === 1 && fos.get("gid://shopify/Order/2005")![0].assignedLocation.location.id === LOC1 && fulfillments.get("gid://shopify/Order/2005")!.length === 1);
    refuseMove = true;
    const o6 = await importOrder(2006, [line(A3, 1)]);
    const s6 = await shipLines(o6.id, [{ orderItemId: o6.items[0].id, quantity: 1 }], { carrier: "UPS", trackingNumber: `MV${RUN}B` });
    await jobs.runDueJobs({ storeId: S });
    const j6 = await jobFor(`fulfillment:${s6.id}`);
    check("outbound: Shopify refuses the move → job NEEDS_ATTENTION immediately, nothing created", j6?.status === "NEEDS_ATTENTION" && /refused to move/.test(j6.lastError ?? "") && fulfillments.get("gid://shopify/Order/2006")!.length === 0 && (await prisma.shopifySyncLog.count({ where: { storeId: S, status: "NEEDS_ATTENTION", message: { contains: "refused to move" } } })) === 1);
    refuseMove = false;
    foLocation = LOC1;
    void s5;

    // nothing left to fulfil in Shopify
    const o7 = await importOrder(2007, [line(A1, 1)]);
    addShopifyFulfillment("gid://shopify/Order/2007", [{ lineItemId: o7.items[0].shopifyLineItemId!, quantity: 1 }], null);
    const s7 = await shipLines(o7.id, [{ orderItemId: o7.items[0].id, quantity: 1 }], { carrier: "UPS", trackingNumber: `NL${RUN}` });
    await jobs.runDueJobs({ storeId: S });
    const j7 = await jobFor(`fulfillment:${s7.id}`);
    check("outbound: nothing left to fulfil in Shopify → attention, no duplicate", j7?.status === "NEEDS_ATTENTION" && /Nothing left to fulfil/.test(j7.lastError ?? ""));
    // BAD_STATUS from the core (Shopify id already linked to another V3PL fulfilment): attention, id kept, no Shopify write
    await prisma.shopifyOutboundJob.update({ where: { id: j7!.id }, data: { result: { shopifyFulfillmentId: pre.id } } });
    const createsBefore7 = calls.fulfillmentCreate;
    await jobs.retryJobNow(j7!.id);
    const j7b = await jobFor(`fulfillment:${s7.id}`);
    check("outbound: core BAD_STATUS on link → NEEDS_ATTENTION with the core reason, Shopify id kept on the job, no Shopify call", j7b?.status === "NEEDS_ATTENTION" && /already linked to another V3PL fulfilment/.test(j7b.lastError ?? "") && (j7b.result as { shopifyFulfillmentId?: string })?.shopifyFulfillmentId === pre.id && calls.fulfillmentCreate === createsBefore7 && (await v3plFulfillment(s7.fulfillmentId)).shopifyFulfillmentId === null);

    // ---------------------------------------------------------------- 6. Shopify-created fulfillment mirrored once
    const o8 = await importOrder(2008, [line(A1, 2), line(A2, 1)]);
    const beforeAvail = { a1: await avail(A1), a2: await avail(A2) };
    const beforeOnHand = await onHand(A1);
    const ext = addShopifyFulfillment("gid://shopify/Order/2008", [{ lineItemId: o8.items[0].shopifyLineItemId!, quantity: 2 }, { lineItemId: o8.items[1].shopifyLineItemId!, quantity: 1 }], { company: "Canada Post", number: `CP${RUN}`, url: "https://cp.example" });
    const st1 = await deliver("fulfillments/create", { id: Number(ext.id.split("/").pop()), admin_graphql_api_id: ext.id, order_id: 2008 }, `wh-${RUN}-fc`);
    let v8 = await prisma.order.findUniqueOrThrow({ where: { id: o8.id }, include: { items: true, fulfillments: { include: { shipment: true } } } });
    check("inbound: Shopify fulfillment mirrored into V3PL (external fulfilment + shipment, tracking copied)", st1 === "PROCESSED" && v8.fulfillments.length === 1 && v8.fulfillments[0].type === "EXTERNAL" && v8.fulfillments[0].shopifyFulfillmentId === ext.id && v8.fulfillments[0].shipment?.trackingNumber === `CP${RUN}` && v8.fulfillments[0].shipment?.carrier === "Canada Post");
    check("inbound: reservation consumed exactly once (available unchanged, on-hand −2, items shipped)", (await avail(A1)) === beforeAvail.a1 && (await avail(A2)) === beforeAvail.a2 && (await onHand(A1)) === beforeOnHand - 2 && v8.items.every((it) => it.shippedQty === it.quantity && it.reservedQty === 0) && v8.status === "COMPLETED");
    const ledgerBefore = await prisma.inventoryTransaction.count({ where: { orderId: o8.id } });
    const st2 = await deliver("fulfillments/create", { id: Number(ext.id.split("/").pop()), admin_graphql_api_id: ext.id, order_id: 2008 }, `wh-${RUN}-fc2`);
    v8 = await prisma.order.findUniqueOrThrow({ where: { id: o8.id }, include: { items: true, fulfillments: { include: { shipment: true } } } });
    check("inbound: redelivery of the same fulfillment is a no-op (one fulfilment, ledger unchanged)", st2 === "PROCESSED" && v8.fulfillments.length === 1 && (await onHand(A1)) === beforeOnHand - 2 && (await prisma.inventoryTransaction.count({ where: { orderId: o8.id } })) === ledgerBefore, `ledger ${ledgerBefore} → ${await prisma.inventoryTransaction.count({ where: { orderId: o8.id } })}`);
    check("inbound: no outbound push job for a mirrored fulfilment", (await jobFor(`fulfillment:${v8.fulfillments[0].shipment!.id}`)) === null);

    // ---------------------------------------------------------------- 7. delivery status + cancellation
    ext.displayStatus = "IN_TRANSIT";
    await deliver("fulfillments/update", { id: Number(ext.id.split("/").pop()), admin_graphql_api_id: ext.id }, `wh-${RUN}-fu1`);
    check("inbound: IN_TRANSIT → shipment IN_TRANSIT", (await prisma.shipment.findUniqueOrThrow({ where: { id: v8.fulfillments[0].shipment!.id } })).status === "IN_TRANSIT");
    ext.displayStatus = "DELIVERED";
    await deliver("fulfillments/update", { id: Number(ext.id.split("/").pop()), admin_graphql_api_id: ext.id }, `wh-${RUN}-fu2`);
    const shipped8 = await prisma.shipment.findUniqueOrThrow({ where: { id: v8.fulfillments[0].shipment!.id } });
    check("inbound: DELIVERED → shipment DELIVERED with deliveredAt; order FULFILLED", shipped8.status === "DELIVERED" && !!shipped8.deliveredAt && (await prisma.order.findUniqueOrThrow({ where: { id: o8.id } })).fulfillmentStatus === "FULFILLED");
    // our own fulfillment (order 2001) cancelled in Shopify → attention only
    shopF1.status = "CANCELLED";
    shopF1.displayStatus = "CANCELED";
    const stC = await deliver("fulfillments/update", { id: Number(shopF1.id.split("/").pop()), admin_graphql_api_id: shopF1.id }, `wh-${RUN}-fcx`);
    const o1After = await prisma.order.findUniqueOrThrow({ where: { id: o1.id }, include: { items: true, shipments: true } });
    check("inbound: cancellation of our fulfillment in Shopify → attention only, shipment/stock untouched", stC === "PROCESSED" && o1After.needsAttention && /cancelled in Shopify/.test(o1After.needsAttentionReason ?? "") && o1After.items.every((it) => it.shippedQty === it.quantity) && o1After.shipments[0].status === "SHIPPED");
    // tracking changed in Shopify on the mirrored fulfillment → V3PL updated with the external event id, and it does NOT loop back
    ext.trackingInfo = [{ company: "Canada Post", number: `CP${RUN}-NEW`, url: "https://cp.example/new" }];
    const stT = await deliver("fulfillments/update", { id: Number(ext.id.split("/").pop()), admin_graphql_api_id: ext.id }, `wh-${RUN}-fut`);
    const mirroredShipment = await prisma.shipment.findUniqueOrThrow({ where: { id: v8.fulfillments[0].shipment!.id } });
    check("inbound: Shopify tracking change on a mirrored fulfillment updates V3PL (externalEventId recorded) and enqueues no outbound job", stT === "PROCESSED" && mirroredShipment.trackingNumber === `CP${RUN}-NEW` && (await prisma.orderEvent.count({ where: { orderId: o8.id, type: "tracking_updated", externalEventId: `ev-wh-${RUN}-fut:tracking` } })) === 1 && (await prisma.shopifyOutboundJob.count({ where: { storeId: S, targetId: mirroredShipment.id } })) === 0);
    const tUpdatesBeforeReplay = calls.trackingUpdate;
    const stT2 = await deliver("fulfillments/update", { id: Number(ext.id.split("/").pop()), admin_graphql_api_id: ext.id }, `wh-${RUN}-fut2`);
    check("inbound: redelivered tracking update is a no-op (core diff + event guard), nothing pushed back", stT2 === "PROCESSED" && (await prisma.orderEvent.count({ where: { orderId: o8.id, type: "tracking_updated" } })) === 1 && calls.trackingUpdate === tUpdatesBeforeReplay && (await prisma.shopifyOutboundJob.count({ where: { storeId: S, targetId: mirroredShipment.id } })) === 0);

    // ---------------------------------------------------------------- 8. inventory publishing
    let r = await publish.publishVariant(S, vid(A1));
    check("publish: disabled → skipped, Shopify untouched", r.action === "skipped_disabled" && calls.inventorySet === 0);
    check("publish: disabled → stock changes enqueue no publish jobs (no backlog)", (await prisma.shopifyOutboundJob.count({ where: { storeId: S, type: "INVENTORY_PUBLISH" } })) === 0 && calls.levelRead === 0);
    await settings({ publishEnabled: true });
    await publish.enqueuePublishAll(S);
    await jobs.runDueJobs({ storeId: S });
    const a1Avail = await avail(A1);
    check("publish: initial publish uses Shopify's current value as compare baseline and sets V3PL available", levels.get(invItem(A1)) === a1Avail && (calls.setByItem.get(invItem(A1)) as { quantities: { changeFromQuantity: number | null }[] }).quantities[0].changeFromQuantity === 5 && (await prisma.shopifyVariantMapping.findFirst({ where: { storeId: S, variantId: vid(A1) } }))!.lastPublishedAvailable === a1Avail);
    check("publish: activation when not stocked at the location, then set", calls.inventoryActivate === 1 && levels.get(invItem(NEW)) === (await avail(NEW)) && (await prisma.shopifySyncLog.count({ where: { storeId: S, operation: "inventory_activate" } })) === 1 && (await prisma.shopifyVariantMapping.findFirst({ where: { storeId: S, variantId: vid(NEW) } }))!.lastPublishedAvailable === (await avail(NEW)), `activate calls ${calls.inventoryActivate}, level ${levels.get(invItem(NEW))}`);
    const setsBefore = calls.inventorySet;
    r = await publish.publishVariant(S, vid(A1));
    check("publish: equal quantity → skipped, no mutation", r.action === "skipped_equal" && calls.inventorySet === setsBefore);
    // manual change in Shopify + stock change in V3PL → conflict
    levels.set(invItem(A1), (levels.get(invItem(A1)) ?? 0) + 3);
    await receiving.createReceiving({ ownerId: A.id, warehouseId: W.id, reference: `${RUN}-R2`, notes: null, lines: [{ variantId: vid(A1), locationId: main.id, quantity: 5 }] }, admin.id);
    const pjc = await jobFor(`publish:${S}:${vid(A1)}`);
    check("publish: stock receipt re-armed the publish job", pjc?.status === "PENDING");
    await jobs.runDueJobs({ storeId: S });
    const pjc2 = await jobFor(`publish:${S}:${vid(A1)}`);
    check("publish: mismatch → NEEDS_ATTENTION, Shopify NOT overwritten, both values logged", pjc2?.status === "NEEDS_ATTENTION" && /changed in Shopify by hand/.test(pjc2.lastError ?? "") && levels.get(invItem(A1)) === a1Avail + 3 && (await prisma.shopifySyncLog.count({ where: { storeId: S, operation: "inventory_publish", status: "NEEDS_ATTENTION", previousValue: String(a1Avail + 3) } })) >= 1);
    r = await publish.publishVariant(S, vid(A1), { force: true });
    check("publish: force publish overwrites with changeFromQuantity: null (no compare-and-set)", r.action === "published" && levels.get(invItem(A1)) === (await avail(A1)) && (calls.lastSet as { quantities: { changeFromQuantity: number | null }[] }).quantities[0].changeFromQuantity === null && !("ignoreCompareQuantity" in (calls.lastSet as object)));
    // manual change in Shopify while V3PL is unchanged: hooks/jobs never read Shopify (fast path) — the sweep catches it
    const setsBefore2 = calls.inventorySet;
    const readsBefore = calls.levelRead;
    levels.set(invItem(A2), 99);
    r = await publish.publishVariant(S, vid(A2));
    check("publish: V3PL unchanged since last publish → no Shopify call at all", r.action === "skipped_equal" && calls.levelRead === readsBefore && calls.inventorySet === setsBefore2);
    const sweep = await publish.publishSweep(S);
    check("publish: daily sweep reads every matched SKU and flags the manual Shopify edit as a conflict, never overwriting it", sweep.checked === 4 && sweep.conflicts === 1 && sweep.equal === 3 && levels.get(invItem(A2)) === 99 && calls.levelRead === readsBefore + 4 && (await prisma.shopifyStore.findUniqueOrThrow({ where: { id: S } })).lastPublishSweepAt !== null && (await prisma.shopifySyncLog.count({ where: { storeId: S, operation: "inventory_sweep", status: "NEEDS_ATTENTION" } })) === 1, JSON.stringify(sweep));
    check("publish: every inventory mutation so far carried @idempotent with a distinct UUID key (2026-07 shape), none rejected", calls.idemRejected === 0 && calls.idemReplays === 0 && calls.idemKeys.size === calls.inventorySet + calls.inventoryActivate);
    // lost response: Shopify applied the set but V3PL never saw the reply → job FAILED; the retry reuses the remembered key
    // so Shopify replays the stored result — no second mutation, no false "changed by hand" conflict.
    await receiving.createReceiving({ ownerId: A.id, warehouseId: W.id, reference: `${RUN}-R2a`, notes: null, lines: [{ variantId: vid(A1), locationId: main.id, quantity: 4 }] }, admin.id);
    dropNextSetResponse = true;
    const byHandBefore = await prisma.shopifySyncLog.count({ where: { storeId: S, internalId: vid(A1), operation: "inventory_publish", status: "NEEDS_ATTENTION" } });
    const keysBeforeLost = calls.idemKeys.size;
    const setsBeforeLost = calls.inventorySet;
    await jobs.runDueJobs({ storeId: S });
    let lostJob = await jobFor(`publish:${S}:${vid(A1)}`);
    const rememberedIdem = (lostJob?.result as { idem?: { set?: { key: string; quantity: number } } } | null)?.idem;
    check("publish: lost response → job FAILED (retryable) with the idempotency key + intent remembered on the job", lostJob?.status === "FAILED" && !!rememberedIdem?.set && UUID_RE.test(rememberedIdem.set.key) && rememberedIdem.set.quantity === (await avail(A1)) && levels.get(invItem(A1)) === (await avail(A1)));
    await jobs.retryJobNow(lostJob!.id);
    lostJob = await jobFor(`publish:${S}:${vid(A1)}`);
    check("publish: retry recognises its own applied write → no second mutation, no false conflict, job DONE, keys cleared, lastPublished updated", lostJob?.status === "DONE" && calls.idemKeys.size === keysBeforeLost + 1 && calls.inventorySet === setsBeforeLost + 1 && !(lostJob.result as { idem?: unknown })?.idem && (await prisma.shopifyVariantMapping.findFirst({ where: { storeId: S, variantId: vid(A1) } }))!.lastPublishedAvailable === (await avail(A1)) && (await prisma.shopifySyncLog.count({ where: { storeId: S, internalId: vid(A1), operation: "inventory_publish", status: "NEEDS_ATTENTION" } })) === byHandBefore, `status ${lostJob?.status} sets ${calls.inventorySet - setsBeforeLost} keys ${calls.idemKeys.size - keysBeforeLost} result ${JSON.stringify(lostJob?.result)} lastPublished ${(await prisma.shopifyVariantMapping.findFirst({ where: { storeId: S, variantId: vid(A1) } }))!.lastPublishedAvailable} avail ${await avail(A1)} byHand ${JSON.stringify(await prisma.shopifySyncLog.findMany({ where: { storeId: S, internalId: vid(A1), operation: "inventory_publish", status: "NEEDS_ATTENTION" }, select: { message: true, createdAt: true } }))}`);
    // same key + same intent re-sent (e.g. Shopify's read was itself stale) → Shopify replays the stored result, no second mutation
    const replayIntent = { itemId: invItem(A1), locationId: LOC1, quantity: await avail(A1), compare: null, force: true };
    const replayKey = rememberedIdem!.set!.key;
    const setsBeforeReplay = calls.inventorySet;
    let savedIdem: unknown = null;
    r = await publish.publishVariant(S, vid(A1), { force: true, idem: { prior: { set: { ...replayIntent, key: replayKey } }, save: async (st) => { savedIdem = st; } } });
    check("publish: identical intent with a remembered key → key reused, Shopify replays, inventorySet not executed again", r.action === "published" && calls.idemReplays === 1 && calls.inventorySet === setsBeforeReplay && (savedIdem as { set?: { key: string } })?.set?.key === replayKey);
    // compare-stale race: Shopify changes between our read and our set → Shopify rejects the compare, we flag
    await receiving.createReceiving({ ownerId: A.id, warehouseId: W.id, reference: `${RUN}-R2b`, notes: null, lines: [{ variantId: vid(A3), locationId: main.id, quantity: 2 }] }, admin.id);
    raceBump = true;
    let conflict = false;
    let raceMessage = "";
    try {
      await publish.publishVariant(S, vid(A3));
    } catch (e) {
      conflict = e instanceof publish.PublishError && e.code === "CONFLICT";
      raceMessage = (e as Error).message;
    }
    check("publish: compare-and-set rejected by Shopify (changed mid-flight) → conflict, no overwrite", conflict && /changed while publishing/.test(raceMessage) && levels.get(invItem(A3)) !== (await avail(A3)));
    r = await publish.publishVariant(S, vid(A3), { force: true });
    check("publish: force publish resolves the race conflict", r.action === "published" && levels.get(invItem(A3)) === (await avail(A3)));
    const daily = await maintenance.runDailyMaintenance(60_000);
    check("daily: publish sweep included for the store", daily.publishSweeps.some((s) => s.storeId === S));
    await settings({ publishEnabled: false });
    const setsBefore3 = calls.inventorySet;
    await receiving.createReceiving({ ownerId: A.id, warehouseId: W.id, reference: `${RUN}-R3`, notes: null, lines: [{ variantId: vid(A3), locationId: main.id, quantity: 1 }] }, admin.id);
    await jobs.runDueJobs({ storeId: S });
    check("publish: switched off → stock changes no longer reach Shopify", calls.inventorySet === setsBefore3);
    check("publish: Shopify quantities never written into V3PL", (await avail(A2)) !== 99 && (await onHand(A2)) === 20 - 1 - 2 - 1 - 1 - 1);

    // ---------------------------------------------------------------- 9. Publishing tab
    const { firebaseAdminAuth } = await import("../src/lib/firebase/admin");
    const custom = await firebaseAdminAuth().createCustomToken(admin.firebaseUid);
    const signIn = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${process.env.NEXT_PUBLIC_FIREBASE_API_KEY}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: custom, returnSecureToken: true }) });
    const { idToken } = (await signIn.json()) as { idToken: string };
    const sess = await fetch(`${base}/api/auth/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken, audience: "staff" }) });
    const cookie = (sess.headers.get("set-cookie") ?? "").split(";")[0];
    const page = await fetch(`${base}/admin/settings/shopify/${S}?tab=publishing`, { headers: { Cookie: cookie } });
    const html = await page.text();
    check("pages: Publishing tab renders SKUs, last published values and controls", page.status === 200 && html.includes(A1) && html.includes("Publish all now") && html.includes("Force publish all"));
    const jobsPage = await fetch(`${base}/admin/settings/shopify/${S}?tab=jobs`, { headers: { Cookie: cookie } });
    check("pages: Outbound jobs tab lists fulfillment and publish jobs", jobsPage.status === 200 && (await jobsPage.text()).includes("fulfillment create"));
    await fetch(`${base}/api/auth/session`, { method: "DELETE", headers: { Cookie: cookie } });
  } finally {
    client.__setShopifyFetchForTests(null);
    const all = await prisma.order.findMany({ where: { shopifyStoreId: { in: created.storeIds } }, select: { id: true } });
    all.forEach((o) => created.orderIds.add(o.id));
    const orderIds = [...created.orderIds];
    await prisma.shopifyStore.deleteMany({ where: { id: { in: created.storeIds } } });
    await prisma.shopifyWebhookEvent.deleteMany({ where: { webhookId: { startsWith: `wh-${RUN}` } } });
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
    await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: [...created.ownerIds, ...created.productIds, ...created.warehouseIds, ...created.storeIds, ...orderIds] } }, { entityType: { in: ["ReceivingRecord", "Location", "Shipment", "ShopifyStore", "ShopifyVariantMapping"] }, createdAt: { gte: new Date(Date.now() - 30 * 60 * 1000) } }] } }).catch(() => undefined);
    await prisma.owner.deleteMany({ where: { id: { in: created.ownerIds } } });
    await prisma.$disconnect();
    console.log(`Cleanup done (${orderIds.length} orders, ${created.storeIds.length} store removed).`);
  }
  const failed = results.filter((x) => !x.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
