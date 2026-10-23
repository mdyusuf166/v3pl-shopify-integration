/**
 * Manual V3PL order → Shopify order, SHOPIFY side (D-062): the ORDER_CREATE runner against a simulated
 * Shopify Admin API (2026-07 `orderCreate`, order search, order fetch, fulfillment orders). Covers the
 * required matrix: runner registration, job execution, store / variant / price / customer / address
 * mapping, V3PL-origin marker, reference recorded once, DONE, repeated execution, adoption, lost response,
 * userErrors, transport failure → retry state, no double reservation, webhook-before-reference race,
 * fulfilment push for the linked manual order, unchanged Shopify-originated behaviour, scope guard.
 *
 * In-process only (no HTTP server, no Firebase): npm run e2e:shopify-order-create -- vendor3pl@gmail.com
 */
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });
loadEnv();

const [adminEmail = "vendor3pl@gmail.com"] = process.argv.slice(2).filter((a) => !a.startsWith("http"));
const RUN = `OC${Date.now().toString(36)}`.toUpperCase();
const SHOP = `v3pl-oc-${RUN.toLowerCase()}.myshopify.com`;
const results: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

type OrderNode = import("../src/server/services/shopify/queries").OrderNode;
type OrderLineNode = import("../src/server/services/shopify/queries").OrderLineNode;
type FO = { id: string; status: string; assignedLocation: { location: { id: string; name: string } }; lineItems: { nodes: { id: string; remainingQuantity: number; totalQuantity: number; lineItem: { id: string; sku: string | null; variant: { id: string } | null } }[] } };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

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
  const out = await import("../src/server/services/shopify/order-out");
  const sor = await import("../src/server/services/shopify-order-request");
  const owners = await import("../src/server/services/owners");
  const products = await import("../src/server/services/products");
  const warehouses = await import("../src/server/services/warehouses");
  const receiving = await import("../src/server/services/receiving");
  const orders = await import("../src/server/services/orders");
  const customers = await import("../src/server/services/customers");
  const fulfillment = await import("../src/server/services/fulfillment");
  const inventory = await import("../src/server/services/inventory");
  const publish = await import("../src/server/services/shopify/inventory-publish");
  const { productFormSchema } = await import("../src/lib/validation/products");
  const { customerFormSchema } = await import("../src/lib/validation/customers");

  const admin = await prisma.user.findFirstOrThrow({ where: { email: adminEmail, role: "ADMIN" } });
  const created = { ownerIds: [] as string[], productIds: [] as string[], warehouseIds: [] as string[], storeIds: [] as string[], customerIds: [] as string[], orderIds: new Set<string>() };
  const secret = shopifyEnv.SHOPIFY_API_SECRET;
  const SCOPES_WITH_WRITE = "read_orders,write_orders,write_merchant_managed_fulfillment_orders,read_fulfillments,read_products,write_inventory,read_locations";

  // ---------------------------------------------------------------- simulated Shopify
  const LOC1 = "gid://shopify/Location/1";
  const money = (a: string) => ({ shopMoney: { amount: a } });
  let seq = 500;
  const variantGid = new Map<string, string>(); // V3PL sku → Shopify variant gid
  const skuByVariantGid = new Map<string, string>();
  const shopOrders = new Map<string, OrderNode>();
  const fos = new Map<string, FO[]>();
  const LOC2 = "gid://shopify/Location/2";
  const calls = { orderCreate: 0, lastOrderVars: null as unknown, lastShop: "", search: 0, fulfillmentCreate: 0, lastFulfillment: null as unknown, orderFetch: 0, inventorySet: 0, lastSet: null as unknown, levelRead: 0 };
  /** Shopify "available" per inventory item (the mock keeps one figure per item; the publish location only matters for the input). */
  const levels = new Map<string, number>();
  const invItemForVariant = (variantGid: string) => `gid://shopify/InventoryItem/${RUN}${skuByVariantGid.get(variantGid)!.slice(RUN.length + 1)}`;
  let failNext: "userError" | "transport" | "lostResponse" | null = null;
  const mkLine = (variantId: string, qty: number): OrderLineNode => {
    const id = ++seq;
    const sku = skuByVariantGid.get(variantId) ?? null;
    return { id: `gid://shopify/LineItem/${id}`, sku, title: `Item ${sku}`, variantTitle: null, quantity: qty, currentQuantity: qty, requiresShipping: true, variant: { id: variantId }, product: { id: `gid://shopify/Product/${id}` }, originalUnitPriceSet: money("10.00"), totalDiscountSet: money("0.00"), taxLines: [] };
  };
  /** Create an order in "Shopify" (used by the orderCreate mock and to pre-seed adoption / race cases). */
  const shopCreate = (input: { lineItems: { variantId: string; quantity: number; priceSet?: { shopMoney: { amount: string } } }[]; tags?: string[]; note?: string; customAttributes?: { key: string; value: string }[]; email?: string; phone?: string; shippingAddress?: Record<string, string>; financialStatus?: string }): OrderNode => {
    const n = ++seq;
    const lines = input.lineItems.map((l) => ({ ...mkLine(l.variantId, l.quantity), originalUnitPriceSet: money(l.priceSet?.shopMoney.amount ?? "10.00") }));
    const a = input.shippingAddress ?? {};
    const o: OrderNode = {
      id: `gid://shopify/Order/${n}`, name: `#V${n}`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), cancelledAt: null, cancelReason: null, closedAt: null, test: false,
      displayFinancialStatus: input.financialStatus ?? "PENDING", displayFulfillmentStatus: "UNFULFILLED", currencyCode: "USD", note: input.note ?? null, tags: input.tags ?? [], sourceName: "v3pl", email: input.email ?? null, phone: input.phone ?? null,
      currentSubtotalPriceSet: money("0.00"), currentTotalDiscountsSet: money("0.00"), currentTotalTaxSet: money("0.00"), totalShippingPriceSet: money("0.00"), currentTotalPriceSet: money("0.00"), shippingLines: { nodes: [] },
      customAttributes: (input.customAttributes ?? []).map((x) => ({ key: x.key, value: x.value })),
      shippingAddress: a.address1 ? { name: [a.firstName, a.lastName].filter(Boolean).join(" "), firstName: a.firstName ?? null, lastName: a.lastName ?? null, company: a.company ?? null, address1: a.address1, address2: a.address2 ?? null, city: a.city ?? null, province: null, provinceCode: a.provinceCode ?? null, zip: a.zip ?? null, country: null, countryCodeV2: a.countryCode ?? null, phone: a.phone ?? null } : null,
      lineItems: { nodes: lines },
    };
    shopOrders.set(o.id, o);
    fos.set(o.id, [{ id: `gid://shopify/FulfillmentOrder/${n}`, status: "OPEN", assignedLocation: { location: { id: LOC1, name: "Main" } }, lineItems: { nodes: lines.map((l, i) => ({ id: `gid://shopify/FulfillmentOrderLineItem/${n}${i}`, remainingQuantity: l.quantity, totalQuantity: l.quantity, lineItem: { id: l.id, sku: l.sku, variant: l.variant } })) } }]);
    return o;
  };
  const validTokens = new Set<string>();
  let tokenN = 0;
  client.__setShopifyFetchForTests(async (input, init) => {
    const url = String(input);
    if (!url.startsWith(`https://${SHOP}/`)) return new Response("not found", { status: 404 });
    calls.lastShop = SHOP;
    if (url.endsWith("/admin/oauth/access_token")) {
      tokenN++;
      const token = `shpat_${RUN}_${tokenN}`;
      validTokens.add(token);
      return Response.json({ access_token: token, scope: SCOPES_WITH_WRITE, expires_in: 86399, refresh_token: `shprt_${RUN}_${tokenN}`, refresh_token_expires_in: 7_776_000 });
    }
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (!validTokens.has(headers["X-Shopify-Access-Token"])) return new Response("{}", { status: 401 });
    const body = JSON.parse(String(init?.body)) as { query: string; variables?: Record<string, unknown> };
    const q = body.query;
    const v = body.variables ?? {};
    if (q.includes("shop {")) return Response.json({ data: { shop: { id: "gid://shopify/Shop/9", name: `OC ${RUN}`, myshopifyDomain: SHOP, currencyCode: "USD", ianaTimezone: "UTC", plan: null } } });
    if (q.includes("locations(")) return Response.json({ data: { locations: { nodes: [{ id: LOC1, name: "Main", isActive: true, fulfillsOnlineOrders: true, shipsInventory: true, address: null }, { id: LOC2, name: "Second", isActive: true, fulfillsOnlineOrders: true, shipsInventory: true, address: null }], pageInfo: { hasNextPage: false, endCursor: null } } } });
    if (q.includes("inventoryItem(id:")) {
      calls.levelRead++;
      const id = String(v.itemId);
      if (!levels.has(id)) return Response.json({ data: { inventoryItem: null } });
      return Response.json({ data: { inventoryItem: { id, tracked: true, inventoryLevel: { id: `gid://shopify/InventoryLevel/${id.split("/").pop()}`, quantities: [{ name: "available", quantity: levels.get(id) }] } } } });
    }
    if (q.includes("inventorySetQuantities")) {
      calls.inventorySet++;
      calls.lastSet = v.input;
      const qty = (v.input as { quantities: { inventoryItemId: string; locationId: string; quantity: number; changeFromQuantity: number | null }[] }).quantities[0];
      const current = levels.get(qty.inventoryItemId) ?? 0;
      if (qty.changeFromQuantity !== null && qty.changeFromQuantity !== current) return Response.json({ data: { inventorySetQuantities: { inventoryAdjustmentGroup: null, userErrors: [{ field: ["input", "quantities", "0", "changeFromQuantity"], message: "The changeFromQuantity value does not match persisted value.", code: "CHANGE_FROM_QUANTITY_STALE" }] } } });
      levels.set(qty.inventoryItemId, qty.quantity);
      return Response.json({ data: { inventorySetQuantities: { inventoryAdjustmentGroup: { id: "g", changes: [{ name: "available", delta: qty.quantity - current, quantityAfterChange: qty.quantity }] }, userErrors: [] } } });
    }
    if (q.includes("orderCreate(")) {
      calls.orderCreate++;
      calls.lastOrderVars = v;
      const mode = failNext;
      failNext = null;
      if (mode === "userError") return Response.json({ data: { orderCreate: { order: null, userErrors: [{ field: ["order", "lineItems", "0", "variantId"], message: "Variant does not exist", code: "INVALID" }] } } });
      if (mode === "transport") return new Response("upstream error", { status: 502 });
      const ord = v.order as Parameters<typeof shopCreate>[0];
      const o = shopCreate(ord);
      // Shopify claims stock for the new order unless the app asked for BYPASS (D-062): the simulation does the same.
      if ((v.options as { inventoryBehaviour?: string } | undefined)?.inventoryBehaviour !== "BYPASS") for (const l of ord.lineItems) levels.set(invItemForVariant(l.variantId), (levels.get(invItemForVariant(l.variantId)) ?? 0) - l.quantity);
      if (mode === "lostResponse") return new Response("gateway timeout", { status: 504 }); // created in Shopify, reply lost
      return Response.json({ data: { orderCreate: { order: { id: o.id, name: o.name, displayFinancialStatus: o.displayFinancialStatus, tags: o.tags, customAttributes: o.customAttributes, lineItems: { nodes: o.lineItems.nodes.map((l) => ({ id: l.id, sku: l.sku, quantity: l.quantity, variant: l.variant })) } }, userErrors: [] } } });
    }
    if (q.includes("orders(first: 10, query:")) {
      calls.search++;
      const tag = /tag:'([^']+)'/.exec(String(v.query))?.[1];
      const nodes = [...shopOrders.values()].filter((o) => tag && o.tags.includes(tag)).map((o) => ({ id: o.id, name: o.name, createdAt: o.createdAt, cancelledAt: o.cancelledAt, tags: o.tags, customAttributes: o.customAttributes ?? [] }));
      return Response.json({ data: { orders: { nodes } } });
    }
    if (q.includes("fulfillmentOrders(first")) {
      const o = shopOrders.get(String(v.id));
      return Response.json({ data: { order: o ? { id: o.id, fulfillmentOrders: { nodes: fos.get(o.id) ?? [] }, fulfillments: [] } : null } });
    }
    if (q.includes("order(id:")) {
      calls.orderFetch++;
      return Response.json({ data: { order: shopOrders.get(String(v.id)) ?? null } });
    }
    if (q.includes("fulfillmentCreate")) {
      calls.fulfillmentCreate++;
      calls.lastFulfillment = v.fulfillment;
      const input = v.fulfillment as { lineItemsByFulfillmentOrder: { fulfillmentOrderId: string; fulfillmentOrderLineItems: { id: string; quantity: number }[] }[] };
      for (const byFo of input.lineItemsByFulfillmentOrder) for (const list of fos.values()) for (const fo of list) if (fo.id === byFo.fulfillmentOrderId) for (const it of byFo.fulfillmentOrderLineItems) { const li = fo.lineItems.nodes.find((x) => x.id === it.id)!; li.remainingQuantity -= it.quantity; }
      return Response.json({ data: { fulfillmentCreate: { fulfillment: { id: `gid://shopify/Fulfillment/${++seq}`, status: "SUCCESS", displayStatus: "FULFILLED", trackingInfo: [] }, userErrors: [] } } });
    }
    return Response.json({ errors: [{ message: `unexpected query in e2e: ${q.slice(0, 80)}` }] });
  });

  try {
    // ---------------------------------------------------------------- V3PL fixtures
    const V = await owners.createOwner("VENDOR", { code: `${RUN}-V`, businessName: `OC Vendor ${RUN}`, contactName: null, email: null, phone: null, addressLine1: null, addressLine2: null, city: null, state: null, postalCode: null, country: null, notes: null }, admin.id);
    created.ownerIds.push(V.id);
    const W = await warehouses.createWarehouse({ code: `${RUN}-W`, name: "OC Warehouse", addressLine1: null, addressLine2: null, city: null, state: null, postalCode: null, country: null, notes: null }, admin.id);
    created.warehouseIds.push(W.id);
    const main = (await warehouses.getDefaultLocation(W.id))!;
    const sku = (s: string) => `${RUN}-${s}`;
    const p = await products.createProduct(productFormSchema.parse({ ownerId: V.id, name: `OC Widget ${RUN}`, status: "ACTIVE", variants: [{ sku: sku("A"), price: "19.99", status: "ACTIVE" }, { sku: sku("B"), price: "29.99", status: "ACTIVE" }, { sku: sku("U"), price: "5.00", status: "ACTIVE" }] }), admin.id);
    created.productIds.push(p.id);
    const vid = (s: string) => p.variants.find((x) => x.sku === sku(s))!.id;
    await receiving.createReceiving({ ownerId: V.id, warehouseId: W.id, reference: `${RUN}-R`, notes: null, lines: p.variants.map((x) => ({ variantId: x.id, locationId: main.id, quantity: 40 })) }, admin.id);
    const cust = await customers.createCustomer({ ownerId: undefined }, customerFormSchema.parse({ name: `Ada Buyer ${RUN}`, email: `ada.${RUN.toLowerCase()}@example.com`, phone: "+15125550100", shipName: "Ada Buyer", shipAddress1: "1 Outbound Way", shipCity: "Austin", shipProvince: "TX", shipZip: "78701", shipCountry: "US", billName: "Ada Buyer", billCompany: "Buyer Co", billAddress1: "PO Box 9", billCity: "Dallas", billProvince: "TX", billZip: "75201", billCountry: "US" }), admin.id);
    created.customerIds.push(cust.id);

    // store: real OAuth flow against the mock → CONNECTED with an encrypted token and granted scopes incl. write_orders
    const begin = await oauth.beginInstall({ shopDomain: SHOP, name: `OC Store ${RUN}` }, admin.id);
    created.storeIds.push(begin.storeId);
    const S = begin.storeId;
    const st = new URL(begin.authorizeUrl).searchParams.get("state")!;
    const prm = new URLSearchParams({ code: "c", shop: SHOP, state: st, timestamp: String(Math.floor(Date.now() / 1000)) });
    prm.set("hmac", crypto.hmacSha256Hex(secret, crypto.oauthQueryMessage(prm)));
    await oauth.completeInstall(prm, admin.id);
    await stores.updateStoreSettings(S, { name: `OC Store ${RUN}`, ordersImportEnabled: true, importTestOrders: false, ordersImportSince: null, publishEnabled: false, publishLocationId: null, fulfilLocationId: LOC1, warehouseIds: [W.id] }, admin.id);
    for (const s of ["A", "B"]) {
      const gid = `gid://shopify/ProductVariant/${RUN}${s}`;
      variantGid.set(sku(s), gid);
      skuByVariantGid.set(gid, sku(s));
      await prisma.shopifyVariantMapping.create({ data: { storeId: S, shopifyProductId: `gid://shopify/Product/${RUN}${s}`, shopifyVariantId: gid, shopifyInventoryItemId: `gid://shopify/InventoryItem/${RUN}${s}`, shopifySku: sku(s), variantId: vid(s), status: "MATCHED", matchedBy: "SKU_EXACT" } });
    }
    const shipTo = { customerId: cust.id, customerName: `Ada Buyer ${RUN}`, customerEmail: `ada.${RUN.toLowerCase()}@example.com`, customerPhone: "+15125550100", shipName: "Ada Buyer", shipCompany: "Buyer Co", shipAddress1: "1 Outbound Way", shipAddress2: "Suite 2", shipCity: "Austin", shipProvince: "TX", shipZip: "78701", shipCountry: "US", shipPhone: "+15125550100" };
    const manualOrder = async (lines: { s: string; q: number; price: string }[], extra: Record<string, unknown> = {}) => {
      const r = await orders.createOrder({ source: "MANUAL", ...shipTo, warehouseId: W.id, reserve: true, currency: "USD", shippingMethod: "Ground", shippingTotal: "7.50", notes: "Leave at the side door", tags: "vip", lines: lines.map((l) => ({ variantId: vid(l.s), quantity: l.q, unitPrice: l.price })), ...extra }, admin.id);
      created.orderIds.add(r.orderId);
      return prisma.order.findUniqueOrThrow({ where: { id: r.orderId }, include: { items: true } });
    };
    const jobFor = (orderId: string) => prisma.shopifyOutboundJob.findUnique({ where: { dedupeKey: `order:${orderId}` } });
    const orderRow = (id: string) => prisma.order.findUniqueOrThrow({ where: { id }, include: { items: true, events: true } });
    const reserveRows = (orderId: string) => prisma.inventoryTransaction.count({ where: { orderId, type: "RESERVE" } });
    const avail = async (s: string) => (await inventory.availableForVariants([vid(s)], [W.id])).get(vid(s)) ?? 0;

    // ---------------------------------------------------------------- 1. registration
    check("1 runner: ORDER_CREATE is registered in the existing job registry (no new queue)", jobs.runnableJobTypes().includes("ORDER_CREATE") && jobs.runnableJobTypes().includes("FULFILLMENT_CREATE"));

    // ---------------------------------------------------------------- 2–11. normal flow
    const o1 = await manualOrder([{ s: "A", q: 2, price: "10.00" }, { s: "B", q: 1, price: "12.50" }]);
    const availBefore = { a: await avail("A"), b: await avail("B") };
    const req1 = await sor.requestShopifyOrder(o1.id, admin.id);
    check("2 request: core queued one PENDING ORDER_CREATE job; runDueJobs executes it", req1.state === "PENDING" && (await jobFor(o1.id))!.status === "PENDING" && (await jobs.runDueJobs({ storeId: S })) >= 1 && (await jobFor(o1.id))!.status === "DONE");
    const vars1 = calls.lastOrderVars as { order: Record<string, Any>; options: Record<string, unknown> };
    const j1 = (await jobFor(o1.id))!;
    check("3 store: the resolved store (req.store) was used — job.storeId = store, call went to its shop domain", j1.storeId === S && calls.lastShop === SHOP && calls.orderCreate === 1);
    check("4 lines: Shopify variant ids come from the contract (mapping), quantities preserved, no SKU lookup", vars1.order.lineItems.length === 2 && vars1.order.lineItems[0].variantId === variantGid.get(sku("A")) && vars1.order.lineItems[0].quantity === 2 && vars1.order.lineItems[1].variantId === variantGid.get(sku("B")) && vars1.order.lineItems[1].quantity === 1 && vars1.order.lineItems.every((l: { requiresShipping: boolean }) => l.requiresShipping === true));
    check("5 prices: V3PL retail unit prices are sent as priceSet (10.00 / 12.50), not the catalog 19.99 / 29.99", Number(vars1.order.lineItems[0].priceSet.shopMoney.amount) === 10 && Number(vars1.order.lineItems[1].priceSet.shopMoney.amount) === 12.5 && vars1.order.lineItems[0].priceSet.shopMoney.currencyCode === "USD");
    check("6 customer: email + phone from req.customer; no Customer object / customer scopes used", vars1.order.email === shipTo.customerEmail && vars1.order.phone === shipTo.customerPhone && vars1.order.customer === undefined);
    check("7 shipping: address mapped to MailingAddressInput (name split, company, address2, provinceCode, countryCode, zip, phone)", vars1.order.shippingAddress.firstName === "Ada" && vars1.order.shippingAddress.lastName === "Buyer" && vars1.order.shippingAddress.company === "Buyer Co" && vars1.order.shippingAddress.address1 === "1 Outbound Way" && vars1.order.shippingAddress.address2 === "Suite 2" && vars1.order.shippingAddress.city === "Austin" && vars1.order.shippingAddress.provinceCode === "TX" && vars1.order.shippingAddress.countryCode === "US" && vars1.order.shippingAddress.zip === "78701" && vars1.order.shippingAddress.phone === "+15125550100");
    check("8 billing: from the linked customer's bill* fields", vars1.order.billingAddress.address1 === "PO Box 9" && vars1.order.billingAddress.city === "Dallas" && vars1.order.billingAddress.company === "Buyer Co" && vars1.order.billingAddress.provinceCode === "TX" && vars1.order.billingAddress.countryCode === "US");
    check("9 marker: tags V3PL + V3PL-<orderNumber> (+ V3PL tags), note 'Created from V3PL order N.' + notes, attributes 'V3PL order' and v3pl_idempotency_key", vars1.order.tags.join(",") === `V3PL,V3PL-${o1.orderNumber},vip` && vars1.order.note === `Created from V3PL order ${o1.orderNumber}.\n\nLeave at the side door` && vars1.order.customAttributes.some((a: { key: string; value: string }) => a.key === "v3pl_idempotency_key" && a.value === `order:${o1.id}`) && vars1.order.customAttributes.some((a: { key: string; value: string }) => a.key === "V3PL order" && a.value === o1.orderNumber));
    check("9b financial + inventory + shipping line: financialStatus PENDING (unpaid), inventoryBehaviour BYPASS, no receipts, shipping line Ground 7.50, processedAt = placedAt", vars1.order.financialStatus === "PENDING" && vars1.options.inventoryBehaviour === "BYPASS" && vars1.options.sendReceipt === false && vars1.order.shippingLines[0].title === "Ground" && Number(vars1.order.shippingLines[0].priceSet.shopMoney.amount) === 7.5 && typeof vars1.order.processedAt === "string", JSON.stringify({ fs: vars1.order.financialStatus, opt: vars1.options, sl: vars1.order.shippingLines, p: vars1.order.processedAt }));
    const shop1 = [...shopOrders.values()].find((o) => o.customAttributes?.some((a) => a.value === `order:${o1.id}`))!;
    let row1 = await orderRow(o1.id);
    check("10 reference: recordShopifyOrderReference persisted id + name + store, status CREATED, event shopify_order_created, job.result carries the id", row1.shopifyOrderId === shop1.id.split("/").pop() && row1.shopifyOrderName === shop1.name && row1.shopifyStoreId === S && row1.shopifyOutboundStatus === "CREATED" && row1.shopifyOutboundError === null && row1.events.filter((e) => e.type === "shopify_order_created").length === 1 && (j1.result as { shopifyOrderId?: string }).shopifyOrderId === row1.shopifyOrderId);
    check("11 job DONE with sync log SUCCESS (entity ORDER)", j1.status === "DONE" && j1.lastError === null && (await prisma.shopifySyncLog.count({ where: { storeId: S, entityType: "ORDER", direction: "OUTBOUND", operation: "order_create", status: "SUCCESS", orderId: o1.id } })) === 1);

    // ---------------------------------------------------------------- 12. repeated execution
    const again = await sor.requestShopifyOrder(o1.id, admin.id);
    const retried = await jobs.retryJobNow(j1.id);
    const ranAgain = await jobs.runDueJobs({ storeId: S });
    check("12 repeat: a second request reuses the DONE job (state CREATED), Retry/runDueJobs do not re-run it, no second orderCreate", again.reused && again.state === "CREATED" && retried === null && ranAgain === 0 && calls.orderCreate === 1 && shopOrders.size === 1 && (await jobFor(o1.id))!.status === "DONE");

    // ---------------------------------------------------------------- 13. adoption (Shopify already has the order, V3PL knows nothing)
    const o2 = await manualOrder([{ s: "A", q: 1, price: "10.00" }]);
    const pre2 = shopCreate({ lineItems: [{ variantId: variantGid.get(sku("A"))!, quantity: 1 }], tags: out.v3plTags(o2.orderNumber), customAttributes: [{ key: "v3pl_idempotency_key", value: `order:${o2.id}` }] });
    await sor.requestShopifyOrder(o2.id, admin.id);
    const createsBefore2 = calls.orderCreate;
    await jobs.runDueJobs({ storeId: S });
    const row2 = await orderRow(o2.id);
    const j2 = (await jobFor(o2.id))!;
    check("13 adoption: existing Shopify order found by tag V3PL-<n> + idempotency attribute → linked, orderCreate NOT called, job DONE", calls.orderCreate === createsBefore2 && row2.shopifyOrderId === pre2.id.split("/").pop() && row2.shopifyOutboundStatus === "CREATED" && j2.status === "DONE" && (j2.result as { adopted?: boolean }).adopted === true, `creates ${calls.orderCreate - createsBefore2} ref ${row2.shopifyOrderId} status ${row2.shopifyOutboundStatus} job ${j2.status} ${JSON.stringify(j2.result)}`);

    // ---------------------------------------------------------------- 14. lost response after creation → retry adopts, never duplicates
    const o3 = await manualOrder([{ s: "B", q: 2, price: "12.50" }]);
    await sor.requestShopifyOrder(o3.id, admin.id);
    failNext = "lostResponse";
    await jobs.runDueJobs({ storeId: S });
    let j3 = (await jobFor(o3.id))!;
    let row3 = await orderRow(o3.id);
    check("14a lost response: Shopify created the order but the reply never arrived → job FAILED (retryable, backoff), order outbound FAILED with the error, no reference yet", j3.status === "FAILED" && j3.attempts === 1 && j3.nextRetryAt !== null && row3.shopifyOutboundStatus === "FAILED" && /504|HTTP/i.test(row3.shopifyOutboundError ?? "") && row3.shopifyOrderId === null && shopOrders.size === 3);
    const createsBefore3 = calls.orderCreate;
    await jobs.retryJobNow(j3.id);
    j3 = (await jobFor(o3.id))!;
    row3 = await orderRow(o3.id);
    const shop3 = [...shopOrders.values()].find((o) => o.customAttributes?.some((a) => a.value === `order:${o3.id}`))!;
    check("14b retry: adoption finds the order Shopify already holds → no second orderCreate, reference recorded, job DONE, exactly one Shopify order for the V3PL order", calls.orderCreate === createsBefore3 && j3.status === "DONE" && row3.shopifyOrderId === shop3.id.split("/").pop() && row3.shopifyOutboundStatus === "CREATED" && [...shopOrders.values()].filter((o) => o.customAttributes?.some((a) => a.value === `order:${o3.id}`)).length === 1);
    // remembered id path (crash between remember and link): a job carrying result.shopifyOrderId links without any Shopify call
    const o4 = await manualOrder([{ s: "A", q: 1, price: "10.00" }]);
    const pre4 = shopCreate({ lineItems: [{ variantId: variantGid.get(sku("A"))!, quantity: 1 }], tags: out.v3plTags(o4.orderNumber), customAttributes: [{ key: "v3pl_idempotency_key", value: `order:${o4.id}` }] });
    const r4 = await sor.requestShopifyOrder(o4.id, admin.id);
    await prisma.shopifyOutboundJob.update({ where: { id: r4.jobId }, data: { result: { shopifyOrderId: pre4.id.split("/").pop(), shopifyOrderName: pre4.name } } });
    const searchBefore4 = calls.search;
    const createsBefore4 = calls.orderCreate;
    await jobs.runDueJobs({ storeId: S });
    const row4 = await orderRow(o4.id);
    check("14c remembered id: an id persisted on the job before the link is reused on retry — no search, no create, reference recorded", calls.orderCreate === createsBefore4 && calls.search === searchBefore4 && row4.shopifyOrderId === pre4.id.split("/").pop() && (await jobFor(o4.id))!.status === "DONE");

    // ---------------------------------------------------------------- 15. userErrors → attention, nothing created
    const o5 = await manualOrder([{ s: "A", q: 1, price: "10.00" }]);
    await sor.requestShopifyOrder(o5.id, admin.id);
    failNext = "userError";
    const shopBefore5 = shopOrders.size;
    await jobs.runDueJobs({ storeId: S });
    const j5 = (await jobFor(o5.id))!;
    const row5 = await orderRow(o5.id);
    check("15 userErrors: surfaced verbatim (field, message, code) → job NEEDS_ATTENTION immediately, order FAILED with the message, sync log NEEDS_ATTENTION, no Shopify order", j5.status === "NEEDS_ATTENTION" && /lineItems\.0\.variantId: Variant does not exist \(INVALID\)/.test(j5.lastError ?? "") && row5.shopifyOutboundStatus === "FAILED" && /Variant does not exist/.test(row5.shopifyOutboundError ?? "") && shopOrders.size === shopBefore5 && (await prisma.shopifySyncLog.count({ where: { storeId: S, entityType: "ORDER", status: "NEEDS_ATTENTION", internalId: o5.id } })) === 1);
    const eligibility5 = await sor.shopifyOutboundSummary(o5.id);
    check("15b core card state after attention: FAILED with the Shopify reason; a new request re-arms the job (core state machine intact)", eligibility5.state === "FAILED" && /Variant does not exist/.test(eligibility5.error ?? "") && (await sor.requestShopifyOrder(o5.id, admin.id)).state === "PENDING" && (await jobFor(o5.id))!.status === "PENDING");
    await jobs.runDueJobs({ storeId: S }); // now succeeds
    check("15c re-armed job succeeds on the next run → CREATED", (await orderRow(o5.id)).shopifyOutboundStatus === "CREATED" && (await jobFor(o5.id))!.status === "DONE");

    // ---------------------------------------------------------------- 16. transport failure → existing retry state
    const o6 = await manualOrder([{ s: "B", q: 1, price: "12.50" }]);
    await sor.requestShopifyOrder(o6.id, admin.id);
    failNext = "transport";
    await jobs.runDueJobs({ storeId: S });
    let j6 = (await jobFor(o6.id))!;
    check("16a API failure (502): job FAILED with attempts 1 + nextRetryAt (jobs.ts backoff), order outbound FAILED + error, event shopify_order_failed", j6.status === "FAILED" && j6.attempts === 1 && j6.nextRetryAt !== null && (await orderRow(o6.id)).shopifyOutboundStatus === "FAILED" && (await orderRow(o6.id)).events.some((e) => e.type === "shopify_order_failed"));
    check("16b not due yet: runDueJobs skips it until nextRetryAt", (await jobs.runDueJobs({ storeId: S })) === 0 && (await jobFor(o6.id))!.status === "FAILED");
    await jobs.retryJobNow(j6.id);
    j6 = (await jobFor(o6.id))!;
    check("16c Retry now → created, DONE, CREATED", j6.status === "DONE" && (await orderRow(o6.id)).shopifyOutboundStatus === "CREATED");

    // ---------------------------------------------------------------- 17. inventory: inbound orders/create for our own order links, never reserves again
    const reserveBefore = await reserveRows(o1.id);
    const ordersBefore = await prisma.order.count({ where: { shopifyStoreId: S } });
    const inbound1 = await ordersIn.syncShopifyOrder(S, shop1.id, { cause: "orders/create", eventId: `ev-${RUN}-1` });
    row1 = await orderRow(o1.id);
    check("17 no double deduction: orders/create webhook for the V3PL-created order → recognised (v3pl_idempotency_key), reference already recorded, no import, RESERVE rows and reservedQty unchanged, available unchanged", inbound1.action === "updated" && /synchronised|linked/i.test(inbound1.message) && (await prisma.order.count({ where: { shopifyStoreId: S } })) === ordersBefore && (await reserveRows(o1.id)) === reserveBefore && row1.items.every((i) => i.reservedQty === i.quantity) && (await avail("A")) === availBefore.a - 3 && (await avail("B")) === availBefore.b - 3, `${inbound1.action} ${inbound1.message} | reserve ${reserveBefore}→${await reserveRows(o1.id)} | availA ${availBefore.a}→${await avail("A")} availB ${availBefore.b}→${await avail("B")}`);
    check("17b inventoryBehaviour BYPASS was sent on every create (Shopify never claims stock for these orders)", (calls.lastOrderVars as { options: { inventoryBehaviour: string } }).options.inventoryBehaviour === "BYPASS");

    // ---------------------------------------------------------------- 18. webhook before reference
    const o7 = await manualOrder([{ s: "A", q: 1, price: "10.00" }]);
    await sor.requestShopifyOrder(o7.id, admin.id); // job PENDING, runner has not run
    const shop7 = shopCreate({ lineItems: [{ variantId: variantGid.get(sku("A"))!, quantity: 1 }], tags: out.v3plTags(o7.orderNumber), customAttributes: [{ key: "v3pl_idempotency_key", value: `order:${o7.id}` }] });
    const ordersBefore7 = await prisma.order.count({ where: { shopifyStoreId: S } });
    const inbound7 = await ordersIn.syncShopifyOrder(S, shop7.id, { cause: "orders/create", eventId: `ev-${RUN}-7` });
    let row7 = await orderRow(o7.id);
    check("18a webhook wins: orders/create arrives before the runner recorded anything → the manual order is linked (CREATED), no second V3PL order, no second reservation", inbound7.action === "updated" && row7.shopifyOrderId === shop7.id.split("/").pop() && row7.shopifyOutboundStatus === "CREATED" && (await prisma.order.count({ where: { shopifyStoreId: S } })) === ordersBefore7 && (await reserveRows(o7.id)) === 1);
    const createsBefore7 = calls.orderCreate;
    await jobs.runDueJobs({ storeId: S });
    row7 = await orderRow(o7.id);
    check("18b runner then finds the reference recorded → 'already created', no orderCreate, job DONE consistently", calls.orderCreate === createsBefore7 && (await jobFor(o7.id))!.status === "DONE" && row7.events.filter((e) => e.type === "shopify_order_created").length === 1);
    // a second Shopify order claiming the same V3PL order (should never happen) is refused, never imported
    const dup7 = shopCreate({ lineItems: [{ variantId: variantGid.get(sku("A"))!, quantity: 1 }], tags: out.v3plTags(o7.orderNumber), customAttributes: [{ key: "v3pl_idempotency_key", value: `order:${o7.id}` }] });
    const inboundDup = await ordersIn.syncShopifyOrder(S, dup7.id, { cause: "orders/create", eventId: `ev-${RUN}-7d` });
    check("18c duplicate Shopify order for an already-linked V3PL order → not imported, attention logged (no stock reserved twice)", inboundDup.action === "skipped" && /Duplicate/.test(inboundDup.message) && (await prisma.order.count({ where: { shopifyStoreId: S } })) === ordersBefore7 && (await prisma.shopifySyncLog.count({ where: { storeId: S, operation: "order_link", status: "NEEDS_ATTENTION" } })) === 1);
    // orders/updated for a V3PL-created order must not zero its lines (items have no shopifyLineItemId)
    shop1.updatedAt = new Date(Date.now() + 5_000).toISOString(); // Shopify bumps updatedAt on every edit
    const upd1 = await ordersIn.syncShopifyOrder(S, shop1.id, { cause: "orders/updated", eventId: `ev-${RUN}-1u` });
    row1 = await orderRow(o1.id);
    check("18d orders/updated on a V3PL-created order: lines matched by variant mapping — quantities untouched, no 'added in Shopify' attention", upd1.action === "updated" && row1.items.every((i) => i.cancelledQty === 0 && i.quantity === (i.sku === sku("A") ? 2 : 1)) && !row1.needsAttention, `${upd1.action} ${upd1.message} | attention ${row1.needsAttention} ${row1.needsAttentionReason ?? ""} | items ${JSON.stringify(row1.items.map((i) => [i.sku, i.quantity, i.cancelledQty]))}`);

    // ---------------------------------------------------------------- 19. fulfilment push for the linked manual order
    const f1 = await fulfillment.startPicking({ orderId: o1.id, warehouseId: W.id, lines: row1.items.map((i) => ({ orderItemId: i.id, quantity: i.quantity })) }, admin.id);
    const s1 = await fulfillment.shipFulfillment(f1.id, { carrier: "UPS", trackingNumber: `1Z${RUN}` }, admin.id);
    const fj = await prisma.shopifyOutboundJob.findUnique({ where: { dedupeKey: `fulfillment:${s1.id}` } });
    check("19a fulfilment hook: shipping the Shopify-linked MANUAL order enqueues FULFILLMENT_CREATE (condition widened from source=SHOPIFY to 'has a Shopify reference')", !!fj && fj.status === "PENDING" && fj.storeId === S);
    await jobs.runDueJobs({ storeId: S });
    const fjDone = (await prisma.shopifyOutboundJob.findUnique({ where: { dedupeKey: `fulfillment:${s1.id}` } }))!;
    const lf = calls.lastFulfillment as { lineItemsByFulfillmentOrder: { fulfillmentOrderId: string; fulfillmentOrderLineItems: { id: string; quantity: number }[] }[]; trackingInfo: { number: string } };
    const vf1 = await prisma.fulfillment.findUniqueOrThrow({ where: { id: f1.id } });
    check("19b fulfilment push: lines allocated by Shopify variant (items have no Shopify line id) → fulfillmentCreate with both lines + tracking, linked via R-1, job DONE", fjDone.status === "DONE" && calls.fulfillmentCreate === 1 && lf.lineItemsByFulfillmentOrder[0].fulfillmentOrderId === fos.get(shop1.id)![0].id && lf.lineItemsByFulfillmentOrder[0].fulfillmentOrderLineItems.map((x) => x.quantity).sort().join() === "1,2" && lf.trackingInfo.number === `1Z${RUN}` && vf1.shopifyFulfillmentId !== null);

    // ---------------------------------------------------------------- 20. existing behaviour unchanged
    const shopImp = shopCreate({ lineItems: [{ variantId: variantGid.get(sku("B"))!, quantity: 3 }], tags: ["web"], email: `buyer.${RUN.toLowerCase()}@example.com`, shippingAddress: { firstName: "Web", lastName: "Buyer", address1: "5 Import Rd", city: "Austin", provinceCode: "TX", countryCode: "US", zip: "78702" }, financialStatus: "PAID" });
    const imp = await ordersIn.syncShopifyOrder(S, shopImp.id, { cause: "orders/create", eventId: `ev-${RUN}-imp` });
    const impRow = await prisma.order.findUniqueOrThrow({ where: { id: imp.orderId! }, include: { items: true } });
    created.orderIds.add(impRow.id);
    check("20a Shopify-originated order still imports + reserves as before (source SHOPIFY, line id kept, RESERVE once)", imp.action === "created" && impRow.source === "SHOPIFY" && impRow.items[0].shopifyLineItemId === shopImp.lineItems.nodes[0].id && impRow.items[0].reservedQty === 3 && (await reserveRows(impRow.id)) === 1);
    const fImp = await fulfillment.startPicking({ orderId: impRow.id, warehouseId: W.id, lines: [{ orderItemId: impRow.items[0].id, quantity: 3 }] }, admin.id);
    const sImp = await fulfillment.shipFulfillment(fImp.id, { carrier: "UPS", trackingNumber: `1Z${RUN}I` }, admin.id);
    const fcBefore = calls.fulfillmentCreate;
    await jobs.runDueJobs({ storeId: S });
    const lfImp = calls.lastFulfillment as { lineItemsByFulfillmentOrder: { fulfillmentOrderLineItems: { id: string; quantity: number }[] }[] };
    check("20b Shopify-originated order ships → FULFILLMENT_CREATE by Shopify line id exactly as before", (await prisma.shopifyOutboundJob.findUnique({ where: { dedupeKey: `fulfillment:${sImp.id}` } }))!.status === "DONE" && calls.fulfillmentCreate === fcBefore + 1 && lfImp.lineItemsByFulfillmentOrder[0].fulfillmentOrderLineItems[0].id === fos.get(shopImp.id)![0].lineItems.nodes[0].id);
    const oLocal = await manualOrder([{ s: "A", q: 1, price: "10.00" }]);
    const fLocal = await fulfillment.startPicking({ orderId: oLocal.id, warehouseId: W.id, lines: [{ orderItemId: oLocal.items[0].id, quantity: 1 }] }, admin.id);
    const sLocal = await fulfillment.shipFulfillment(fLocal.id, { carrier: "UPS", trackingNumber: `1Z${RUN}L` }, admin.id);
    check("20c a manual order never sent to Shopify ships without any Shopify job", (await prisma.shopifyOutboundJob.findUnique({ where: { dedupeKey: `fulfillment:${sLocal.id}` } })) === null);
    const oNotSent = await manualOrder([{ s: "U", q: 1, price: "5.00" }]);
    const elig = await sor.shopifyOrderEligibility(oNotSent.id);
    check("20d unmapped SKU: core refuses (NO_MAPPING) — the runner is never involved, nothing created", !elig.ok && elig.code === "NO_MAPPING" && (await jobFor(oNotSent.id)) === null);

    // ---------------------------------------------------------------- 21. scope guard
    const o8 = await manualOrder([{ s: "A", q: 1, price: "10.00" }]);
    await prisma.shopifyStore.update({ where: { id: S }, data: { grantedScopes: "read_orders,write_merchant_managed_fulfillment_orders,read_fulfillments,read_products,write_inventory,read_locations" } });
    await sor.requestShopifyOrder(o8.id, admin.id);
    const createsBefore8 = calls.orderCreate;
    await jobs.runDueJobs({ storeId: S });
    const j8 = (await jobFor(o8.id))!;
    check("21 scope guard: store without write_orders → NEEDS_ATTENTION 'reconnect the store', no API call, order FAILED with that reason", j8.status === "NEEDS_ATTENTION" && /write_orders/.test(j8.lastError ?? "") && /Reconnect/.test(j8.lastError ?? "") && calls.orderCreate === createsBefore8 && /write_orders/.test((await orderRow(o8.id)).shopifyOutboundError ?? ""));
    await prisma.shopifyStore.update({ where: { id: S }, data: { grantedScopes: SCOPES_WITH_WRITE } });
    await sor.requestShopifyOrder(o8.id, admin.id);
    await jobs.runDueJobs({ storeId: S });
    check("21b after reconnect (scopes granted) a new request succeeds", (await orderRow(o8.id)).shopifyOutboundStatus === "CREATED");

    // ---------------------------------------------------------------- 23. Shopify inventory effect of a V3PL order (D-066)
    // BYPASS keeps the Shopify order itself inventory-neutral; the reservation's INVENTORY_PUBLISH job carries the
    // decrement to Shopify (compare-and-set). Baseline: publishing on, Shopify holding exactly V3PL's available.
    const invItem = (s: string) => `gid://shopify/InventoryItem/${RUN}${s}`;
    const publishJob = (s: string) => prisma.shopifyOutboundJob.findUnique({ where: { dedupeKey: `publish:${S}:${vid(s)}` } });
    const mappingRow = (s: string) => prisma.shopifyVariantMapping.findFirstOrThrow({ where: { storeId: S, variantId: vid(s) } });
    const settings = (over: Partial<import("../src/server/services/shopify/stores").StoreSettingsValues> = {}) => stores.updateStoreSettings(S, { name: `OC Store ${RUN}`, ordersImportEnabled: true, importTestOrders: false, ordersImportSince: null, publishEnabled: true, publishLocationId: LOC1, fulfilLocationId: LOC1, warehouseIds: [W.id], ...over }, admin.id);
    levels.set(invItem("A"), await avail("A"));
    levels.set(invItem("B"), await avail("B"));
    await settings();
    const a0 = { shop: levels.get(invItem("A"))!, v3pl: await avail("A") };
    const b0 = { shop: levels.get(invItem("B"))!, v3pl: await avail("B") };
    const o9 = await manualOrder([{ s: "A", q: 2, price: "10.00" }, { s: "B", q: 1, price: "12.50" }]);
    await sor.requestShopifyOrder(o9.id, admin.id);
    const sets0 = calls.inventorySet;
    await jobs.runDueJobs({ storeId: S });
    check("23a V3PL order → Shopify order created with BYPASS (the order itself claimed nothing) and Shopify available decreased by exactly the ordered quantity per line (A −2, B −1) through publish — one mutation per SKU", (await orderRow(o9.id)).shopifyOutboundStatus === "CREATED" && (calls.lastOrderVars as { options: { inventoryBehaviour: string } }).options.inventoryBehaviour === "BYPASS" && levels.get(invItem("A")) === a0.shop - 2 && levels.get(invItem("B")) === b0.shop - 1 && calls.inventorySet === sets0 + 2, `A ${a0.shop}→${levels.get(invItem("A"))} B ${b0.shop}→${levels.get(invItem("B"))} sets ${calls.inventorySet - sets0}`);
    check("23b V3PL available decreased by the same quantities (one RESERVE per line, no second deduction) and Shopify == V3PL for both SKUs afterwards", (await avail("A")) === a0.v3pl - 2 && (await avail("B")) === b0.v3pl - 1 && levels.get(invItem("A")) === (await avail("A")) && levels.get(invItem("B")) === (await avail("B")) && (await reserveRows(o9.id)) === 2);
    const sets1 = calls.inventorySet;
    const rePub = await publish.publishVariant(S, vid("A"), { verify: true });
    await jobs.runDueJobs({ storeId: S });
    check("23c re-running the publish (verify) and the drain deducts nothing twice: Shopify unchanged, no further mutation, publish jobs DONE", rePub.action === "skipped_equal" && calls.inventorySet === sets1 && levels.get(invItem("A")) === a0.shop - 2 && (await publishJob("A"))!.status === "DONE" && (await publishJob("B"))!.status === "DONE");
    const o10 = await manualOrder([{ s: "A", q: 1, price: "10.00" }]);
    await sor.requestShopifyOrder(o10.id, admin.id);
    await jobs.runDueJobs({ storeId: S });
    check("23d partial quantity: a 1-unit order moves Shopify by exactly 1 (A −3 in total), the other SKU untouched", (await orderRow(o10.id)).shopifyOutboundStatus === "CREATED" && levels.get(invItem("A")) === a0.shop - 3 && levels.get(invItem("B")) === b0.shop - 1 && (await avail("A")) === a0.v3pl - 3);
    // Shopify-originated order: Shopify decrements at checkout, V3PL reserves on import → both sides equal → no conflict.
    const setsNat = calls.inventorySet;
    const shopNat = shopCreate({ lineItems: [{ variantId: variantGid.get(sku("B"))!, quantity: 2 }], tags: ["web"], email: `nat.${RUN.toLowerCase()}@example.com`, shippingAddress: { firstName: "Nat", lastName: "Buyer", address1: "7 Checkout St", city: "Austin", provinceCode: "TX", countryCode: "US", zip: "78703" }, financialStatus: "PAID" });
    levels.set(invItem("B"), levels.get(invItem("B"))! - 2); // native checkout claim
    const nat = await ordersIn.syncShopifyOrder(S, shopNat.id, { cause: "orders/create", eventId: `ev-${RUN}-nat` });
    if (nat.orderId) created.orderIds.add(nat.orderId);
    await jobs.runDueJobs({ storeId: S });
    check("23e Shopify-originated order (unchanged behaviour): Shopify decremented at checkout, V3PL reserved on import → publish sees both equal: no 'changed by hand' conflict, no mutation, job DONE, baseline re-anchored", nat.action === "created" && (await publishJob("B"))!.status === "DONE" && calls.inventorySet === setsNat && levels.get(invItem("B")) === (await avail("B")) && (await mappingRow("B")).lastPublishedAvailable === (await avail("B")), `${nat.action} job ${(await publishJob("B"))?.status} ${(await publishJob("B"))?.lastError ?? ""}`);
    levels.set(invItem("B"), levels.get(invItem("B"))! + 5); // a real manual edit in Shopify
    const conflict = await publish.publishVariant(S, vid("B"), { verify: true }).then(() => null, (e: unknown) => e);
    check("23f a genuine Shopify-side change (differs from both V3PL and the baseline) is still a conflict and is never overwritten", conflict instanceof publish.PublishError && conflict.code === "CONFLICT" && levels.get(invItem("B")) === (await avail("B")) + 5);
    levels.set(invItem("B"), levels.get(invItem("B"))! - 5);
    // Mapping without a Shopify inventory item: the order is still created; publish skips safely; V3PL is untouched by the failure.
    await prisma.shopifyVariantMapping.updateMany({ where: { storeId: S, variantId: vid("B") }, data: { shopifyInventoryItemId: null } });
    const bShop = levels.get(invItem("B"));
    const bV3 = await avail("B");
    const o11 = await manualOrder([{ s: "B", q: 1, price: "12.50" }]);
    await sor.requestShopifyOrder(o11.id, admin.id);
    await jobs.runDueJobs({ storeId: S });
    const pjMissing = (await publishJob("B"))!;
    check("23g mapping without a Shopify inventory item: Shopify order still created, publish skipped as 'no mapping' (job DONE, no attention loop), Shopify untouched, V3PL reserved exactly once", (await orderRow(o11.id)).shopifyOutboundStatus === "CREATED" && pjMissing.status === "DONE" && (pjMissing.result as { action?: string })?.action === "skipped_no_mapping" && levels.get(invItem("B")) === bShop && (await avail("B")) === bV3 - 1 && (await reserveRows(o11.id)) === 1, `${pjMissing.status} ${JSON.stringify(pjMissing.result)}`);
    await prisma.shopifyVariantMapping.updateMany({ where: { storeId: S, variantId: vid("B") }, data: { shopifyInventoryItemId: invItem("B") } });
    // Publish location change (the production trigger): the compare baseline belongs to the old location.
    await settings({ publishLocationId: LOC2 });
    check("23h changing the publish location drops the compare baseline of every SKU (lastPublishedAvailable null) instead of leaving a permanent conflict against the old location's figure", (await prisma.shopifyVariantMapping.findMany({ where: { storeId: S, status: "MATCHED" } })).every((m) => m.lastPublishedAvailable === null && m.lastPublishedAt === null));
    levels.set(invItem("A"), 999); // what the new location happens to hold
    const rNew = await publish.publishVariant(S, vid("A"));
    const lastSet = calls.lastSet as { quantities: { locationId: string; changeFromQuantity: number | null }[] };
    check("23i first publish after the change anchors on the new location's current value (changeFromQuantity 999 @ LOC2) and sets V3PL available — no conflict", rNew.action === "published" && rNew.shopifyBefore === 999 && levels.get(invItem("A")) === (await avail("A")) && lastSet.quantities[0].changeFromQuantity === 999 && lastSet.quantities[0].locationId === LOC2);
    // Publishing off: V3PL orders still reach Shopify as orders; Shopify quantities are then not managed by V3PL at all.
    await settings({ publishEnabled: false, publishLocationId: LOC1 });
    const aShop = levels.get(invItem("A"));
    const aV3 = await avail("A");
    const o12 = await manualOrder([{ s: "A", q: 1, price: "10.00" }]);
    await sor.requestShopifyOrder(o12.id, admin.id);
    await jobs.runDueJobs({ storeId: S });
    check("23j publishing off: Shopify order still created, V3PL reserves once, no publish job re-armed, Shopify quantities left alone", (await orderRow(o12.id)).shopifyOutboundStatus === "CREATED" && (await avail("A")) === aV3 - 1 && levels.get(invItem("A")) === aShop && (await publishJob("A"))!.status === "DONE");

    // ---------------------------------------------------------------- pure mapping edge cases
    const req = await sor.buildShopifyOrderRequest(o8.id);
    const noPrice = out.buildOrderCreateInput({ ...req, lines: [{ ...req.lines[0], unitPrice: null }], billingAddress: null, order: { ...req.order, tags: null, notes: null, shippingMethod: null, shippingTotal: null } });
    check("22 mapping edges: no unit price → no priceSet (Shopify catalog price), no billing → omitted, no shipping → no shippingLines, note without extra paragraph, tags = markers only", !("priceSet" in (noPrice.order.lineItems as Record<string, unknown>[])[0]) && noPrice.order.billingAddress === undefined && noPrice.order.shippingLines === undefined && noPrice.order.note === `Created from V3PL order ${o8.orderNumber}.` && (noPrice.order.tags as string[]).length === 2);
    check("22b attribute parser: 'order:<id>' → id; other / blank → null", out.v3plOrderIdFromAttributes([{ key: "v3pl_idempotency_key", value: "order:abc" }]) === "abc" && out.v3plOrderIdFromAttributes([{ key: "v3pl_idempotency_key", value: "order:" }]) === null && out.v3plOrderIdFromAttributes([{ key: "other", value: "order:x" }]) === null && out.v3plOrderIdFromAttributes(undefined) === null);
  } finally {
    client.__setShopifyFetchForTests(null);
    const all = await prisma.order.findMany({ where: { OR: [{ shopifyStoreId: { in: created.storeIds } }, { id: { in: [...created.orderIds] } }] }, select: { id: true } });
    all.forEach((o) => created.orderIds.add(o.id));
    const orderIds = [...created.orderIds];
    await prisma.shopifyStore.deleteMany({ where: { id: { in: created.storeIds } } });
    await prisma.inventoryTransaction.deleteMany({ where: { OR: [{ orderId: { in: orderIds } }, { variant: { productId: { in: created.productIds } } }] } });
    await prisma.shipmentItem.deleteMany({ where: { shipment: { orderId: { in: orderIds } } } });
    await prisma.shipment.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.fulfillmentItem.deleteMany({ where: { fulfillment: { orderId: { in: orderIds } } } });
    await prisma.fulfillment.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.orderEvent.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await prisma.customer.deleteMany({ where: { id: { in: created.customerIds } } });
    await prisma.inventoryLevel.deleteMany({ where: { variant: { productId: { in: created.productIds } } } });
    await prisma.inventoryBalance.deleteMany({ where: { variant: { productId: { in: created.productIds } } } });
    await prisma.receivingItem.deleteMany({ where: { variant: { productId: { in: created.productIds } } } });
    await prisma.receivingRecord.deleteMany({ where: { ownerId: { in: created.ownerIds } } });
    await prisma.productVariant.deleteMany({ where: { productId: { in: created.productIds } } });
    await prisma.product.deleteMany({ where: { id: { in: created.productIds } } });
    await prisma.location.deleteMany({ where: { warehouseId: { in: created.warehouseIds } } });
    await prisma.warehouse.deleteMany({ where: { id: { in: created.warehouseIds } } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: [...created.ownerIds, ...created.productIds, ...created.warehouseIds, ...created.storeIds, ...created.customerIds, ...orderIds] } }, { entityType: { in: ["ReceivingRecord", "Location", "Shipment", "ShopifyStore", "ShopifyVariantMapping", "Fulfillment"] }, createdAt: { gte: new Date(Date.now() - 30 * 60 * 1000) } }] } }).catch(() => undefined);
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
