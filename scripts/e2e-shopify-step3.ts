/**
 * Shopify Step 3 end-to-end check: inbound order synchronisation through the core order
 * contracts, with Shopify simulated in-process. Covers: multi-owner import + reservation,
 * unknown SKU → no order + Retry after mapping, non-shipping lines (mapped, SKU-less, all
 * non-shipping, mixed), insufficient stock, no default warehouse, test orders, import-since
 * cut-off + backfill, 5× concurrent duplicate deliveries → one order / one set of movements,
 * stale updates, orders/edited quantity changes, refunds before and after shipment, cancellation
 * with release, line added in Shopify, two stores with the same order name, reconciliation,
 * webhook routing over HTTP, and the Orders tab. Removes everything it creates.
 *
 * Usage: npm run e2e:shopify3 -- http://localhost:3100 vendor3pl@gmail.com
 */
import { createHmac } from "node:crypto";
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });
loadEnv();

const [base = "http://localhost:3100", adminEmail = "vendor3pl@gmail.com"] = process.argv.slice(2);
const RUN = `S3${Date.now().toString(36)}`.toUpperCase();
const SHOP = `v3pl-e2e-${RUN.toLowerCase()}.myshopify.com`;
const SHOP2 = `v3pl-e2e-${RUN.toLowerCase()}-b.myshopify.com`;
const results: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Line = import("../src/server/services/shopify/queries").OrderLineNode;
type SOrder = import("../src/server/services/shopify/queries").OrderNode;

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  await import("../src/server/services/shopify/register");
  const shopifyEnv = (await import("../src/server/services/shopify/env")).shopifyEnv();
  const client = await import("../src/server/services/shopify/client");
  const crypto = await import("../src/server/services/shopify/crypto");
  const oauth = await import("../src/server/services/shopify/oauth");
  const ordersIn = await import("../src/server/services/shopify/orders-in");
  const stores = await import("../src/server/services/shopify/stores");
  const webhooks = await import("../src/server/services/shopify/webhooks");
  const owners = await import("../src/server/services/owners");
  const products = await import("../src/server/services/products");
  const warehouses = await import("../src/server/services/warehouses");
  const receiving = await import("../src/server/services/receiving");
  const fulfillment = await import("../src/server/services/fulfillment");
  const inventory = await import("../src/server/services/inventory");

  const admin = await prisma.user.findFirstOrThrow({ where: { email: adminEmail, role: "ADMIN" } });
  const created = { ownerIds: [] as string[], productIds: [] as string[], warehouseIds: [] as string[], storeIds: [] as string[], orderIds: new Set<string>() };
  const secret = shopifyEnv.SHOPIFY_API_SECRET;

  // ---------------------------------------------------------------- simulated Shopify: two shops, mutable order books
  let lineSeq = 100;
  const money = (a: string) => ({ shopMoney: { amount: a } });
  // Like real Shopify, the same SKU always belongs to the same product variant id.
  const variantIds = new Map<string, number>();
  const variantFor = (sku: string | null, fallback: number) => {
    if (!sku) return fallback;
    if (!variantIds.has(sku)) variantIds.set(sku, 5000 + variantIds.size);
    return variantIds.get(sku)!;
  };
  const line = (sku: string | null, qty: number, opts: { ship?: boolean; title?: string; vtitle?: string | null; variant?: boolean; price?: string } = {}): Line => {
    const id = ++lineSeq;
    const vid = variantFor(sku, id);
    return { id: `gid://shopify/LineItem/${id}`, sku, title: opts.title ?? `Item ${sku ?? id}`, variantTitle: opts.vtitle ?? null, quantity: qty, currentQuantity: qty, requiresShipping: opts.ship ?? true, variant: opts.variant === false ? null : { id: `gid://shopify/ProductVariant/${vid}` }, product: { id: `gid://shopify/Product/${vid}` }, originalUnitPriceSet: money(opts.price ?? "10.00"), totalDiscountSet: money("0.00"), taxLines: [] };
  };
  const addr = { name: "Ayla Buyer", firstName: "Ayla", lastName: "Buyer", company: null, address1: "1 Test St", address2: "", city: "Austin", province: "Texas", provinceCode: "TX", zip: "78701", country: "United States", countryCodeV2: "US", phone: "+15550009" };
  const mkOrder = (num: number, lines: Line[], opts: { test?: boolean; createdAt?: string; cancelled?: string | null } = {}): SOrder => ({ id: `gid://shopify/Order/${num}`, name: `#${num}`, createdAt: opts.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString(), cancelledAt: opts.cancelled ?? null, cancelReason: opts.cancelled ? "CUSTOMER" : null, closedAt: null, test: opts.test ?? false, displayFinancialStatus: "PAID", displayFulfillmentStatus: "UNFULFILLED", currencyCode: "USD", note: "ring bell", tags: ["e2e"], sourceName: "web", email: `buyer${num}@example.com`, phone: "+15550001", currentSubtotalPriceSet: money("30.00"), currentTotalDiscountsSet: money("0.00"), currentTotalTaxSet: money("0.00"), totalShippingPriceSet: money("5.00"), currentTotalPriceSet: money("35.00"), shippingLines: { nodes: [{ title: "Standard", code: "STD" }] }, shippingAddress: addr, lineItems: { nodes: lines } });
  const books: Record<string, Map<string, SOrder>> = { [SHOP]: new Map(), [SHOP2]: new Map() };
  // Monotonic Shopify clock: every change moves updatedAt forward by 2 s.
  const clock = { t: Date.now() };
  const touch = (shop: string, o: SOrder) => {
    clock.t = Math.max(clock.t + 2000, Date.now());
    o.updatedAt = new Date(clock.t).toISOString();
    books[shop].set(o.id, o);
    return o;
  };
  const validTokens = new Set<string>();
  let tokenN = 0;
  const calls = { orderQuery: 0, ordersQuery: 0 };
  client.__setShopifyFetchForTests(async (input, init) => {
    const url = String(input);
    const shop = Object.keys(books).find((s) => url.startsWith(`https://${s}/`));
    if (!shop) return new Response("not found", { status: 404 });
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
    if (q.includes("shop {")) return Response.json({ data: { shop: { id: `gid://shopify/Shop/${shop}`, name: `E2E ${shop}`, myshopifyDomain: shop, currencyCode: "USD", ianaTimezone: "UTC", plan: null } } });
    if (q.includes("locations(")) return Response.json({ data: { locations: { nodes: [{ id: "gid://shopify/Location/1", name: "Main", isActive: true, fulfillsOnlineOrders: true, shipsInventory: true, address: null }], pageInfo: { hasNextPage: false, endCursor: null } } } });
    if (q.includes("order(id:")) {
      calls.orderQuery++;
      return Response.json({ data: { order: books[shop].get(String(body.variables?.id)) ?? null } });
    }
    if (q.includes("orders(first")) {
      calls.ordersQuery++;
      const filter = String(body.variables?.query ?? "");
      const m = filter.match(/(updated_at|created_at):>=?'([^']+)'/);
      const field = m?.[1] === "created_at" ? "createdAt" : "updatedAt";
      const since = m ? Date.parse(m[2]) : 0;
      const nodes = [...books[shop].values()].filter((o) => Date.parse(o[field as "updatedAt" | "createdAt"]) > since).sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
      return Response.json({ data: { orders: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } });
    }
    return Response.json({ errors: [{ message: `unexpected query in e2e: ${q.slice(0, 60)}` }] });
  });

  const connect = async (shop: string, name: string) => {
    const begin = await oauth.beginInstall({ shopDomain: shop, name }, admin.id);
    created.storeIds.push(begin.storeId);
    const state = new URL(begin.authorizeUrl).searchParams.get("state")!;
    const p = new URLSearchParams({ code: "c", shop, state, timestamp: String(Math.floor(Date.now() / 1000)) });
    p.set("hmac", crypto.hmacSha256Hex(secret, crypto.oauthQueryMessage(p)));
    await oauth.completeInstall(p, admin.id);
    return begin.storeId;
  };
  const webhookPost = (shop: string, topic: string, payload: unknown, webhookId: string, eventId = `ev-${webhookId}`) => {
    const body = JSON.stringify(payload);
    return fetch(`${base}/api/webhooks/shopify`, { method: "POST", headers: { "Content-Type": "application/json", "X-Shopify-Topic": topic, "X-Shopify-Shop-Domain": shop, "X-Shopify-Webhook-Id": webhookId, "X-Shopify-Event-Id": eventId, "X-Shopify-API-Version": shopifyEnv.SHOPIFY_API_VERSION, "X-Shopify-Triggered-At": new Date().toISOString(), "X-Shopify-Hmac-Sha256": createHmac("sha256", secret).update(body).digest("base64") }, body });
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
  const v3plOrder = (storeId: string, num: number) => prisma.order.findUnique({ where: { shopifyStoreId_shopifyOrderId: { shopifyStoreId: storeId, shopifyOrderId: String(num) } }, include: { items: true, events: { orderBy: { createdAt: "asc" } } } });
  const trackOrders = async () => (await prisma.order.findMany({ where: { shopifyStoreId: { in: created.storeIds } }, select: { id: true } })).forEach((o) => created.orderIds.add(o.id));
  const lastLog = (storeId: string, externalId: string) => prisma.shopifySyncLog.findFirst({ where: { storeId, entityType: "ORDER", externalId }, orderBy: { createdAt: "desc" } });

  try {
    // ---------------------------------------------------------------- V3PL side: owners, warehouse, SKUs, stock
    const A = await owners.createOwner("VENDOR", { code: `${RUN}-A`, businessName: `S3 Vendor A ${RUN}`, contactName: null, email: null, phone: null, addressLine1: null, addressLine2: null, city: null, state: null, postalCode: null, country: null, notes: null }, admin.id);
    const B = await owners.createOwner("VENDOR", { code: `${RUN}-B`, businessName: `S3 Vendor B ${RUN}`, contactName: null, email: null, phone: null, addressLine1: null, addressLine2: null, city: null, state: null, postalCode: null, country: null, notes: null }, admin.id);
    const C = await owners.createOwner("THREEPL_CLIENT", { code: `${RUN}-C`, businessName: `S3 Client C ${RUN}`, contactName: null, email: null, phone: null, addressLine1: null, addressLine2: null, city: null, state: null, postalCode: null, country: null, notes: null }, admin.id);
    created.ownerIds.push(A.id, B.id, C.id);
    const W = await warehouses.createWarehouse({ code: `${RUN}-W`, name: "S3 Warehouse", addressLine1: null, addressLine2: null, city: null, state: null, postalCode: null, country: null, notes: null }, admin.id);
    created.warehouseIds.push(W.id);
    const main = (await warehouses.getDefaultLocation(W.id))!;
    const vin = (sku: string) => ({ sku, name: null, barcode: null, price: "10.00", cost: null, status: "ACTIVE" as const });
    const [A1, A2, B1, C1, GW, LOW] = [`${RUN}-A1`, `${RUN}-A2`, `${RUN}-B1`, `${RUN}-C1`, `${RUN}-GW`, `${RUN}-LOW`];
    const pA = await products.createProduct({ ownerId: A.id, name: "S3 A", category: null, description: null, notes: null, status: "ACTIVE", variants: [vin(A1), vin(A2), vin(LOW)] }, admin.id);
    const pB = await products.createProduct({ ownerId: B.id, name: "S3 B", category: null, description: null, notes: null, status: "ACTIVE", variants: [vin(B1), vin(GW)] }, admin.id);
    const pC = await products.createProduct({ ownerId: C.id, name: "S3 C", category: null, description: null, notes: null, status: "ACTIVE", variants: [vin(C1)] }, admin.id);
    created.productIds.push(pA.id, pB.id, pC.id);
    const vid = (sku: string) => [...pA.variants, ...pB.variants, ...pC.variants].find((v) => v.sku === sku)!.id;
    await receiving.createReceiving({ ownerId: A.id, warehouseId: W.id, reference: `${RUN}-RA`, notes: null, lines: [{ variantId: vid(A1), locationId: main.id, quantity: 100 }, { variantId: vid(A2), locationId: main.id, quantity: 50 }, { variantId: vid(LOW), locationId: main.id, quantity: 1 }] }, admin.id);
    await receiving.createReceiving({ ownerId: B.id, warehouseId: W.id, reference: `${RUN}-RB`, notes: null, lines: [{ variantId: vid(B1), locationId: main.id, quantity: 40 }, { variantId: vid(GW), locationId: main.id, quantity: 5 }] }, admin.id);
    await receiving.createReceiving({ ownerId: C.id, warehouseId: W.id, reference: `${RUN}-RC`, notes: null, lines: [{ variantId: vid(C1), locationId: main.id, quantity: 30 }] }, admin.id);
    const avail = async (sku: string) => (await inventory.availableForVariants([vid(sku)], [W.id])).get(vid(sku)) ?? 0;

    // ---------------------------------------------------------------- stores
    const S = await connect(SHOP, `S3 Store ${RUN}`);
    const S2 = await connect(SHOP2, `S3 Store B ${RUN}`);
    const since = new Date(Date.now() - 3_600_000);
    await stores.updateStoreSettings(S, { name: `S3 Store ${RUN}`, ordersImportEnabled: true, importTestOrders: false, ordersImportSince: since, publishEnabled: false, publishLocationId: null, fulfilLocationId: null, warehouseIds: [W.id] }, admin.id);
    await stores.updateStoreSettings(S2, { name: `S3 Store B ${RUN}`, ordersImportEnabled: true, importTestOrders: false, ordersImportSince: since, publishEnabled: false, publishLocationId: null, fulfilLocationId: null, warehouseIds: [W.id] }, admin.id);
    const storeRow = await prisma.shopifyStore.findUniqueOrThrow({ where: { id: S } });
    check("store: ordersImportSince set at connect and editable", !!storeRow.ordersImportSince && storeRow.ordersImportSince.getTime() === since.getTime());
    const sync = (storeId: string, num: number, cause: import("../src/server/services/shopify/orders-in").SyncCause = "orders/create", eventId = `ev-${RUN}-${num}-${cause}-${Date.now()}`) => ordersIn.syncShopifyOrder(storeId, String(num), { cause, eventId });

    // ---------------------------------------------------------------- 1. multi-owner order
    const o1 = touch(SHOP, mkOrder(1001, [line(A1, 2), line(B1, 3), line(C1, 1), line(A2, 4)]));
    const r1 = await sync(S, 1001);
    let v1 = (await v3plOrder(S, 1001))!;
    await trackOrders();
    check("import: multi-owner Shopify order → one V3PL order with 4 lines / 3 owners", r1.action === "created" && !!v1 && v1.items.length === 4 && new Set(v1.items.map((i) => i.ownerId)).size === 3);
    check("import: every line reserved at the store warehouse; statuses derived", v1.items.every((i) => i.reservedQty === i.quantity && i.warehouseId === W.id) && v1.status === "CONFIRMED" && v1.fulfillmentStatus === "RESERVED" && (await avail(A1)) === 98);
    check("import: identity + ship-to snapshot + Shopify status stored, no Customer object", v1.shopifyOrderId === "1001" && v1.shopifyOrderName === "#1001" && v1.sourceRef === `${SHOP} #1001` && v1.customerName === "Ayla Buyer" && v1.customerEmail === "buyer1001@example.com" && v1.shipProvince === "TX" && v1.shipCountry === "US" && v1.shopifyFinancialStatus === "PAID" && v1.financialStatus === "NOT_INVOICED" && v1.tags === "e2e" && v1.notes === "ring bell");
    check("import: line ids + prices + external event on ledger", v1.items.every((i) => i.shopifyLineItemId?.startsWith("gid://shopify/LineItem/")) && String(v1.items[0].unitPrice) === "10" && (await prisma.inventoryTransaction.count({ where: { orderId: v1.id, type: "RESERVE", externalEventId: { not: null } } })) === 4);
    const l1 = await lastLog(S, "1001");
    check("import: sync log SUCCESS with order link", l1?.status === "SUCCESS" && l1.orderId === v1.id && /4 warehouse lines, 3 owners/.test(l1.message));

    // ---------------------------------------------------------------- 2. duplicate deliveries: 5× concurrent, same event → one order, one set of movements
    const o2 = touch(SHOP, mkOrder(1002, [line(A1, 1), line(B1, 1)]));
    const dup = await Promise.all([1, 2, 3, 4, 5].map(() => ordersIn.syncShopifyOrder(S, "1002", { cause: "orders/create", eventId: `ev-${RUN}-dup` })));
    const v2 = (await v3plOrder(S, 1002))!;
    await trackOrders();
    check("idempotency: 5 concurrent deliveries → exactly one V3PL order", dup.filter((d) => d.action === "created").length === 1 && (await prisma.order.count({ where: { shopifyStoreId: S, shopifyOrderId: "1002" } })) === 1, dup.map((d) => `${d.action}: ${d.message.slice(0, 140)}`).join(" | "));
    if (!v2) throw new Error("order 1002 missing — see detail above");
    check("idempotency: reservation applied once (2 RESERVE rows, available −1 each)", (await prisma.inventoryTransaction.count({ where: { orderId: v2.id, type: "RESERVE" } })) === 2 && (await avail(A1)) === 97 && (await avail(B1)) === 36);
    const again = await ordersIn.syncShopifyOrder(S, "1002", { cause: "orders/updated", eventId: `ev-${RUN}-dup` });
    check("idempotency: replay of the same event id is a no-op", again.action === "skipped" && (await prisma.inventoryTransaction.count({ where: { orderId: v2.id } })) === 2);
    void o2;

    // ---------------------------------------------------------------- 3. unknown SKU → no order; Retry after mapping
    const oX = touch(SHOP, mkOrder(1003, [line(A1, 1), line(`${RUN}-NOPE`, 2, { title: "Mystery" })]));
    const r3 = await sync(S, 1003);
    check("unknown SKU: no V3PL order, nothing reserved, attention names the SKU", r3.action === "unresolved" && (await v3plOrder(S, 1003)) === null && (await avail(A1)) === 97 && (await lastLog(S, "1003"))?.status === "NEEDS_ATTENTION" && /unknown SKU .*-NOPE/.test((await lastLog(S, "1003"))!.message));
    const pN = await products.createProduct({ ownerId: B.id, name: "S3 Nope", category: null, description: null, notes: null, status: "ACTIVE", variants: [vin(`${RUN}-NOPE`)] }, admin.id);
    created.productIds.push(pN.id);
    await receiving.createReceiving({ ownerId: B.id, warehouseId: W.id, reference: `${RUN}-RN`, notes: null, lines: [{ variantId: pN.variants[0].id, locationId: main.id, quantity: 10 }] }, admin.id);
    const r3b = await ordersIn.syncShopifyOrder(S, "1003", { cause: "manual", eventId: `manual-${RUN}-1003`, force: true });
    const v3 = await v3plOrder(S, 1003);
    await trackOrders();
    check("unknown SKU: Retry after creating the SKU imports the order and records the mapping", r3b.action === "created" && !!v3 && v3.items.length === 2 && (await prisma.shopifyVariantMapping.count({ where: { storeId: S, shopifyVariantId: oX.lineItems.nodes[1].variant!.id, status: "MATCHED", variantId: pN.variants[0].id } })) === 1);

    // ---------------------------------------------------------------- 4. non-shipping lines
    const oMixed = touch(SHOP, mkOrder(1004, [line(A1, 2), line(GW, 1, { ship: false, title: "Gift wrap" }), line(null, 1, { ship: false, title: "Digital guide", variant: false })]));
    const r4 = await sync(S, 1004);
    const v4 = (await v3plOrder(S, 1004))!;
    await trackOrders();
    check("non-shipping (mixed): only the shippable line becomes a V3PL line and reserves", r4.action === "created" && v4.items.length === 1 && v4.items[0].sku === A1 && v4.items[0].reservedQty === 2 && (await avail(GW)) === 5);
    check("non-shipping (mixed): mapped non-shipping line not reserved, SKU-less one does not fail; both noted on the order", v4.events.some((e) => e.type === "note" && /Gift wrap ×1 \(SKU .*-GW\)/.test(e.message) && /Digital guide ×1/.test(e.message)) && (await lastLog(S, "1004"))!.message.includes("2 non-shipping items noted, not reserved"));
    check("non-shipping (mixed): not pickable / no fulfilment expected for them", (await fulfillment.pickableQuantities(prisma, v4.id)).length === 1);
    const oAllNS = touch(SHOP, mkOrder(1005, [line(GW, 2, { ship: false, title: "Gift wrap" }), line(null, 1, { ship: false, title: "E-book", variant: false })]));
    const r5 = await sync(S, 1005);
    check("non-shipping (all): no V3PL order, no reservation, SKIPPED log explains 'no warehouse action'", r5.action === "skipped" && (await v3plOrder(S, 1005)) === null && (await avail(GW)) === 5 && (await lastLog(S, "1005"))?.status === "SKIPPED" && /no warehouse action required/.test((await lastLog(S, "1005"))!.message));
    const oNSOnlySku = touch(SHOP, mkOrder(1006, [line(B1, 1), line(null, 3, { ship: false, title: "Tip", variant: false })]));
    const r6 = await sync(S, 1006);
    await trackOrders();
    check("non-shipping (SKU-less): never fails the import", r6.action === "created" && (await v3plOrder(S, 1006))!.items.length === 1);
    void oAllNS;
    void oNSOnlySku;

    // ---------------------------------------------------------------- 5. insufficient stock + no warehouse
    const oLow = touch(SHOP, mkOrder(1007, [line(LOW, 3), line(A1, 1)]));
    const r7 = await sync(S, 1007);
    const v7 = (await v3plOrder(S, 1007))!;
    await trackOrders();
    check("insufficient stock: order created, short line unreserved, attention with SKU, other line reserved, no negative stock", r7.action === "created" && v7.needsAttention && /Insufficient stock/.test(v7.needsAttentionReason ?? "") && v7.items.find((i) => i.sku === LOW)!.reservedQty === 0 && v7.items.find((i) => i.sku === A1)!.reservedQty === 1 && (await avail(LOW)) === 1 && (await lastLog(S, "1007"))?.status === "NEEDS_ATTENTION");
    await stores.updateStoreSettings(S2, { name: `S3 Store B ${RUN}`, ordersImportEnabled: true, importTestOrders: false, ordersImportSince: since, publishEnabled: false, publishLocationId: null, fulfilLocationId: null, warehouseIds: [] }, admin.id);
    touch(SHOP2, mkOrder(1001, [line(A1, 1)]));
    const rNoWh = await sync(S2, 1001);
    const vNoWh = (await v3plOrder(S2, 1001))!;
    await trackOrders();
    check("no warehouse: order created unreserved + attention; same #1001 in store B is a distinct order", rNoWh.action === "created" && vNoWh.items[0].reservedQty === 0 && /no default warehouse/.test(vNoWh.needsAttentionReason ?? "") && vNoWh.id !== v1.id && vNoWh.sourceRef === `${SHOP2} #1001`);
    await stores.updateStoreSettings(S2, { name: `S3 Store B ${RUN}`, ordersImportEnabled: true, importTestOrders: false, ordersImportSince: since, publishEnabled: false, publishLocationId: null, fulfilLocationId: null, warehouseIds: [W.id] }, admin.id);

    // ---------------------------------------------------------------- 6. test orders + import-since cut-off + backfill
    touch(SHOP, mkOrder(1008, [line(A1, 1)], { test: true }));
    check("test order: skipped while 'Import test orders' is off", (await sync(S, 1008)).action === "skipped" && (await v3plOrder(S, 1008)) === null);
    await stores.updateStoreSettings(S, { name: `S3 Store ${RUN}`, ordersImportEnabled: true, importTestOrders: true, ordersImportSince: since, publishEnabled: false, publishLocationId: null, fulfilLocationId: null, warehouseIds: [W.id] }, admin.id);
    check("test order: imported once enabled", (await sync(S, 1008)).action === "created");
    await trackOrders();
    touch(SHOP, mkOrder(1009, [line(A1, 1)], { createdAt: new Date(Date.now() - 7 * 86_400_000).toISOString() }));
    check("import-since: older order skipped by webhook/reconcile", (await sync(S, 1009)).action === "skipped" && (await v3plOrder(S, 1009)) === null);
    const bf = await ordersIn.importOrdersSince(S, new Date(Date.now() - 10 * 86_400_000));
    await trackOrders();
    check("backfill: 'Import orders since' imports it (force) and touches nothing else twice", bf.created === 1 && (await v3plOrder(S, 1009)) !== null && bf.complete && (await prisma.order.count({ where: { shopifyStoreId: S } })) === 8, `created=${bf.created} updated=${bf.updated} skipped=${bf.skipped} orders=${await prisma.order.count({ where: { shopifyStoreId: S } })}`);

    // ---------------------------------------------------------------- 7. updates: header, stale, edit, refund, cancel
    o1.tags = ["e2e", "priority"];
    o1.displayFinancialStatus = "PARTIALLY_REFUNDED";
    touch(SHOP, o1);
    const ru = await sync(S, 1001, "orders/updated");
    v1 = (await v3plOrder(S, 1001))!;
    check("update: header synced (tags, Shopify financial status), lines untouched", ru.action === "updated" && v1.tags === "e2e, priority" && v1.shopifyFinancialStatus === "PARTIALLY_REFUNDED" && v1.items.every((i) => i.reservedQty === i.quantity));
    const stale = { ...o1, updatedAt: new Date(clock.t - 60_000).toISOString(), tags: ["old"] };
    const rs = await ordersIn.syncShopifyOrder(S, "1001", { cause: "orders/updated", eventId: `ev-${RUN}-stale`, prefetched: stale });
    const storedAfterStale = (await v3plOrder(S, 1001))!;
    check("update: stale event (older updatedAt) ignored", rs.action === "skipped" && rs.stale === true && storedAfterStale.tags === "e2e, priority", `${rs.action} stale=${rs.stale} | ${rs.message.slice(0, 120)} | stored=${storedAfterStale.shopifyUpdatedAt?.toISOString()} staleAt=${stale.updatedAt} o1At=${o1.updatedAt} clock=${new Date(clock.t).toISOString()} now=${new Date().toISOString()} tags=${storedAfterStale.tags}`);
    // edit: reduce B1 3 → 1, increase C1 1 → 2
    o1.lineItems.nodes[1].currentQuantity = 1;
    o1.lineItems.nodes[2].currentQuantity = 2;
    touch(SHOP, o1);
    const re = await sync(S, 1001, "orders/edited");
    v1 = (await v3plOrder(S, 1001))!;
    const ib1 = v1.items.find((i) => i.sku === B1)!;
    const ic1 = v1.items.find((i) => i.sku === C1)!;
    check("edit: quantity decrease releases reservation; increase reserves more", re.action === "updated" && ib1.quantity === 1 && ib1.reservedQty === 1 && ic1.quantity === 2 && ic1.reservedQty === 2 && (await avail(B1)) === 37 && (await avail(C1)) === 28, `${re.action} | ${re.message.slice(0, 200)} | B1 q=${ib1.quantity} r=${ib1.reservedQty} C1 q=${ic1.quantity} r=${ic1.reservedQty} availB1=${await avail(B1)} availC1=${await avail(C1)}`);
    touch(SHOP, o1);
    const re2 = await sync(S, 1001, "orders/edited");
    check("edit: re-applying the same quantities changes nothing (state-based)", re2.action === "updated" && (await avail(B1)) === 37 && /no line changes/.test(re2.message), `${re2.action} | ${re2.message.slice(0, 160)}`);
    // line added in Shopify
    o1.lineItems.nodes.push(line(A2, 1, { title: "Added later" }));
    touch(SHOP, o1);
    const ra = await sync(S, 1001, "orders/edited");
    v1 = (await v3plOrder(S, 1001))!;
    check("edit: line added in Shopify → attention, not auto-added", ra.action === "updated" && v1.items.length === 4 && v1.needsAttention && /added in Shopify/.test(v1.needsAttentionReason ?? "") && (await lastLog(S, "1001"))?.status === "NEEDS_ATTENTION", `${ra.action} | ${ra.message.slice(0, 200)} | items=${v1.items.length} attention=${v1.needsAttentionReason?.slice(0, 80)}`);
    o1.lineItems.nodes.pop();
    // refund before shipment: A2 4 → 2
    o1.lineItems.nodes[3].currentQuantity = 2;
    touch(SHOP, o1);
    const rr = await sync(S, 1001, "refunds/create");
    v1 = (await v3plOrder(S, 1001))!;
    check("refund before shipment: line reduced, reservation released, no restock", rr.action === "updated" && v1.items.find((i) => i.sku === A2)!.quantity === 2 && v1.items.find((i) => i.sku === A2)!.reservedQty === 2 && (await avail(A2)) === 48, `${rr.action} | ${rr.message.slice(0, 160)} | availA2=${await avail(A2)} skus=${v1.items.map((i) => i.sku.split("-").pop()).join(",")}`);
    // ship A1 (2 units) then refund it → attention, no stock change
    const f = await fulfillment.startPicking({ orderId: v1.id, warehouseId: W.id, lines: [{ orderItemId: v1.items.find((i) => i.sku === A1)!.id, quantity: 2 }] }, admin.id);
    await fulfillment.shipFulfillment(f.id, { carrier: "UPS", trackingNumber: `1Z${RUN}` }, admin.id);
    const onHandBefore = (await inventory.stockForVariant(vid(A1))).find((s) => s.warehouse.id === W.id)!.onHand;
    o1.lineItems.nodes[0].currentQuantity = 1;
    touch(SHOP, o1);
    const rr2 = await sync(S, 1001, "refunds/create");
    v1 = (await v3plOrder(S, 1001))!;
    const onHandAfter = (await inventory.stockForVariant(vid(A1))).find((s) => s.warehouse.id === W.id)!.onHand;
    check("refund after shipment: order flagged 'record a Return', shipped quantity kept, stock unchanged", rr2.action === "updated" && v1.items.find((i) => i.sku === A1)!.shippedQty === 2 && v1.items.find((i) => i.sku === A1)!.quantity === 2 && /record a Return/.test(v1.needsAttentionReason ?? "") && onHandAfter === onHandBefore);
    // cancel order 1003 (unshipped) → release
    const availNopeFn = async () => (await inventory.availableForVariants([pN.variants[0].id], [W.id])).get(pN.variants[0].id) ?? 0;
    const availNope = await availNopeFn();
    touch(SHOP, { ...oX, cancelledAt: new Date().toISOString(), cancelReason: "CUSTOMER" });
    const rc = await sync(S, 1003, "orders/cancelled");
    const v3c = (await v3plOrder(S, 1003))!;
    check("cancel: V3PL order cancelled, reservations released", rc.action === "cancelled" && v3c.status === "CANCELLED" && v3c.items.every((i) => i.reservedQty === 0) && (await availNopeFn()) === availNope + 2);
    const rc2 = await sync(S, 1003, "orders/cancelled");
    check("cancel: repeated cancellation is a no-op", rc2.action === "cancelled" && (await prisma.inventoryTransaction.count({ where: { orderId: v3c.id, type: "RELEASE" } })) === 2);
    const availA1Before1010 = await avail(A1);
    touch(SHOP, mkOrder(1010, [line(A1, 1)], { cancelled: new Date().toISOString() }));
    const r10 = await sync(S, 1010, "orders/create", `ev-${RUN}-1010`);
    const v10 = await v3plOrder(S, 1010);
    await trackOrders();
    check("cancel: imported-as-cancelled → order created CANCELLED, nothing reserved", r10.action === "created" && !!v10 && v10.status === "CANCELLED" && v10.items.every((i) => i.reservedQty === 0) && (await avail(A1)) === availA1Before1010);

    // ---------------------------------------------------------------- 8. reconciliation (missed webhooks)
    touch(SHOP, mkOrder(1011, [line(C1, 2)]));
    const before = await prisma.shopifyStore.findUniqueOrThrow({ where: { id: S }, select: { lastOrderCheckpointAt: true } });
    const rec = await ordersIn.reconcileOrders(S);
    const after = await prisma.shopifyStore.findUniqueOrThrow({ where: { id: S }, select: { lastOrderCheckpointAt: true } });
    await trackOrders();
    check("reconcile: imports the missed order, advances the checkpoint, logs a summary", rec.created >= 1 && (await v3plOrder(S, 1011)) !== null && !!after.lastOrderCheckpointAt && after.lastOrderCheckpointAt !== before.lastOrderCheckpointAt && (await prisma.shopifySyncLog.count({ where: { storeId: S, operation: "order_reconcile", status: "SUCCESS" } })) >= 1);
    const rec2 = await ordersIn.reconcileOrders(S);
    check("reconcile: second run finds nothing new", rec2.created === 0 && rec2.scanned === 0);

    // ---------------------------------------------------------------- 9. webhook routing over HTTP (server → fake shop fails → in-process retry)
    touch(SHOP, mkOrder(1012, [line(B1, 1)]));
    const whId = `wh-${RUN}-oc`;
    const res = await webhookPost(SHOP, "orders/create", { id: 1012, admin_graphql_api_id: "gid://shopify/Order/1012", name: "#1012" }, whId);
    const ev = await waitForEvent(whId, ["FAILED", "PROCESSED"]);
    const retried = await webhooks.retryWebhookEventNow(ev!.id);
    await trackOrders();
    const v12 = await v3plOrder(S, 1012);
    check("webhook: orders/create routed → handler → order created (event id used as idempotency key)", res.status === 200 && retried === "PROCESSED" && v12 !== null && (await prisma.orderEvent.count({ where: { orderId: v12?.id ?? "", externalEventId: `ev-${whId}:create` } })) >= 1, `http=${res.status} serverStatus=${ev?.status} serverError=${ev?.error?.slice(0, 80)} retried=${retried} order=${!!v12}`);
    const o12 = books[SHOP].get("gid://shopify/Order/1012")!;
    o12.lineItems.nodes[0].currentQuantity = 0; // full refund before shipment
    touch(SHOP, o12);
    const whR = `wh-${RUN}-rf`;
    await webhookPost(SHOP, "refunds/create", { id: 77, order_id: 1012 }, whR);
    const evR = await waitForEvent(whR, ["FAILED", "PROCESSED"]);
    const rR = await webhooks.retryWebhookEventNow(evR!.id);
    const v12r = (await v3plOrder(S, 1012))!;
    check("webhook: refunds/create payload resolves the order via order_id; full refund → line 0, released", rR === "PROCESSED" && v12r.items[0].cancelledQty === 1 && v12r.items[0].reservedQty === 0 && v12r.status === "CANCELLED", `serverStatus=${evR?.status} retried=${rR} cancelledQty=${v12r.items[0].cancelledQty} status=${v12r.status}`);
    o12.tags = ["e2e", "edited"];
    touch(SHOP, o12);
    const whE = `wh-${RUN}-ed`;
    await webhookPost(SHOP, "orders/edited", { order_edit: { id: 5, order_id: 1012 } }, whE);
    const evE = await waitForEvent(whE, ["FAILED", "PROCESSED"]);
    const rE = await webhooks.retryWebhookEventNow(evE!.id);
    check("webhook: orders/edited payload resolves the order via order_edit.order_id", rE === "PROCESSED", `serverStatus=${evE?.status} retried=${rE} err=${(await prisma.shopifyWebhookEvent.findUnique({ where: { id: evE!.id } }))?.error?.slice(0, 120)}`);

    // ---------------------------------------------------------------- 10. Orders tab
    const { firebaseAdminAuth } = await import("../src/lib/firebase/admin");
    const custom = await firebaseAdminAuth().createCustomToken(admin.firebaseUid);
    const signIn = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${process.env.NEXT_PUBLIC_FIREBASE_API_KEY}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: custom, returnSecureToken: true }) });
    const { idToken } = (await signIn.json()) as { idToken: string };
    const sess = await fetch(`${base}/api/auth/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken, audience: "staff" }) });
    const cookie = (sess.headers.get("set-cookie") ?? "").split(";")[0];
    const page = await fetch(`${base}/admin/settings/shopify/${S}?tab=orders`, { headers: { Cookie: cookie } });
    const html = await page.text();
    check("pages: Orders tab renders activity, links and controls", page.status === 200 && html.includes("Sync orders now") && html.includes("Import orders since") && html.includes("#1001") && html.includes("Retry"));
    const settings = await fetch(`${base}/admin/settings/shopify/${S}?tab=settings`, { headers: { Cookie: cookie } });
    check("pages: settings show import-test-orders + import-since", settings.status === 200 && (await settings.text()).includes("Import test orders"));
    await fetch(`${base}/api/auth/session`, { method: "DELETE", headers: { Cookie: cookie } });
  } finally {
    client.__setShopifyFetchForTests(null);
    await trackOrders();
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
    console.log(`Cleanup done (${orderIds.length} orders, ${created.storeIds.length} stores removed).`);
  }
  const failed = results.filter((x) => !x.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
