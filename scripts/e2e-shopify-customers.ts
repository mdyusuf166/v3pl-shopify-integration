/**
 * Shopify customers → V3PL customer directory (D-065) against a simulated Shopify Admin API (2026-07 `customers`
 * connection, `order { customer }`). Covers: scope guard, initial import, cursor pagination, new customer creation,
 * existing (mapped) customer update without blanking V3PL-only data, adoption of an unmapped company customer by
 * e-mail (once), owner pools untouched, repeat sync = no duplicates + incremental filter, store isolation for the
 * same Shopify id / e-mail, missing e-mail/phone/name, one bad record skipped, time budget → partial, API failure
 * → FAILED log, order relation (mapped customer linked, unknown customer created, no scope → no link), and the
 * existing customer directory (list/search/get/orders) still working with synced records.
 *
 * In-process only (no HTTP server, no Firebase): npm run e2e:shopify-customers -- vendor3pl@gmail.com
 */
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });
loadEnv();

const [adminEmail = "vendor3pl@gmail.com"] = process.argv.slice(2).filter((a) => !a.startsWith("http"));
const RUN = `CS${Date.now().toString(36)}`.toUpperCase();
const SHOP_A = `v3pl-cs-${RUN.toLowerCase()}-a.myshopify.com`;
const SHOP_B = `v3pl-cs-${RUN.toLowerCase()}-b.myshopify.com`;
const results: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

type CustomerNode = import("../src/server/services/shopify/queries").CustomerNode;
type OrderNode = import("../src/server/services/shopify/queries").OrderNode;

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const shopifyEnv = (await import("../src/server/services/shopify/env")).shopifyEnv();
  const client = await import("../src/server/services/shopify/client");
  const crypto = await import("../src/server/services/shopify/crypto");
  const oauth = await import("../src/server/services/shopify/oauth");
  const stores = await import("../src/server/services/shopify/stores");
  const cs = await import("../src/server/services/shopify/customers-sync");
  const ordersIn = await import("../src/server/services/shopify/orders-in");
  const customers = await import("../src/server/services/customers");
  const owners = await import("../src/server/services/owners");
  const products = await import("../src/server/services/products");
  const warehouses = await import("../src/server/services/warehouses");
  const { productFormSchema } = await import("../src/lib/validation/products");
  const { customerFormSchema } = await import("../src/lib/validation/customers");

  const admin = await prisma.user.findFirstOrThrow({ where: { email: adminEmail, role: "ADMIN" } });
  const created = { ownerIds: [] as string[], productIds: [] as string[], warehouseIds: [] as string[], storeIds: [] as string[], customerIds: new Set<string>(), orderIds: [] as string[] };
  const secret = shopifyEnv.SHOPIFY_API_SECRET;
  const ALL = { ownerId: undefined };
  const email = (s: string) => `${s}.${RUN.toLowerCase()}@example.com`;

  // ---------------------------------------------------------------- simulated Shopify: customers per shop, 3 per page
  const MOCK_PAGE = 3;
  const gid = (n: number) => `gid://shopify/Customer/${n}`;
  const mk = (n: number, o: Partial<CustomerNode> & { email?: string | null; phone?: string | null; city?: string | null }): CustomerNode => ({
    id: gid(n),
    firstName: o.firstName === undefined ? `First${n}` : o.firstName,
    lastName: o.lastName === undefined ? `Last${n}` : o.lastName,
    displayName: o.displayName === undefined ? `First${n} Last${n}` : o.displayName,
    updatedAt: o.updatedAt ?? new Date().toISOString(),
    defaultEmailAddress: o.email === null ? null : { emailAddress: o.email ?? email(`c${n}`) },
    defaultPhoneNumber: o.phone === null ? null : { phoneNumber: o.phone ?? `+1512555${String(1000 + n).slice(-4)}` },
    defaultAddress: o.defaultAddress === null ? null : { name: `First${n} Last${n}`, firstName: `First${n}`, lastName: `Last${n}`, company: null, address1: `${n} Main St`, address2: null, city: o.city ?? "Austin", province: "Texas", provinceCode: "TX", zip: "78701", country: "United States", countryCodeV2: "US", phone: null },
  });
  const shopCustomers: Record<string, CustomerNode[]> = {
    [SHOP_A]: [
      mk(1, {}),
      mk(2, { email: email("shared") }), // same e-mail as an unmapped company customer created in V3PL beforehand → linked
      mk(3, { email: email("owned") }), // same e-mail as a VENDOR-owned customer → never adopted
      mk(4, { email: null, phone: null }), // no contact data at all
      mk(5, { displayName: null, firstName: null, lastName: null, email: null, phone: null, defaultAddress: null }), // nothing but an id
      mk(6, { displayName: "Bad Record" }),
      mk(7, { firstName: "Seven" }),
    ],
    [SHOP_B]: [
      mk(2, { email: email("c2") }), // same Shopify numeric id AND same e-mail as store A's customer 2? no — same id as A#2, e-mail of A#1
      mk(8, {}),
    ],
  };
  let breakRecord: number | null = null; // customer id whose node is corrupted in the next page
  let failCustomersQuery = false;
  const calls = { customers: 0, lastQuery: null as unknown, orderCustomer: 0 };
  const shopOrders = new Map<string, { order: OrderNode; customer: CustomerNode | null }>();
  const validTokens = new Set<string>();
  let tokenN = 0;
  const SCOPES = "read_orders,write_orders,write_merchant_managed_fulfillment_orders,read_fulfillments,read_products,write_inventory,read_locations,read_customers";

  client.__setShopifyFetchForTests(async (input, init) => {
    const url = String(input);
    const shop = [SHOP_A, SHOP_B].find((s) => url.startsWith(`https://${s}/`));
    if (!shop) return new Response("not found", { status: 404 });
    if (url.endsWith("/admin/oauth/access_token")) {
      const token = `shpat_${RUN}_${++tokenN}`;
      validTokens.add(token);
      return Response.json({ access_token: token, scope: SCOPES, expires_in: 86399, refresh_token: `shprt_${RUN}_${tokenN}`, refresh_token_expires_in: 7_776_000 });
    }
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (!validTokens.has(headers["X-Shopify-Access-Token"])) return new Response("{}", { status: 401 });
    const body = JSON.parse(String(init?.body)) as { query: string; variables?: Record<string, unknown> };
    const q = body.query;
    const v = body.variables ?? {};
    if (q.includes("shop {")) return Response.json({ data: { shop: { id: "gid://shopify/Shop/9", name: `CS ${shop}`, myshopifyDomain: shop, currencyCode: "USD", ianaTimezone: "UTC", plan: null } } });
    if (q.includes("locations(")) return Response.json({ data: { locations: { nodes: [{ id: "gid://shopify/Location/1", name: "Main", isActive: true, fulfillsOnlineOrders: true, shipsInventory: true, address: null }], pageInfo: { hasNextPage: false, endCursor: null } } } });
    if (q.includes("customers(first:")) {
      calls.customers++;
      calls.lastQuery = v.query ?? null;
      if (failCustomersQuery) return new Response("upstream error", { status: 502 });
      let all = shopCustomers[shop];
      const since = /updated_at:>='([^']+)'/.exec(String(v.query ?? ""))?.[1];
      if (since) all = all.filter((c) => new Date(c.updatedAt).getTime() >= new Date(since).getTime());
      const start = v.after ? Number(v.after) : 0;
      const nodes = all.slice(start, start + MOCK_PAGE).map((c) => (breakRecord !== null && c.id === gid(breakRecord) ? ({ ...c, id: "gid://shopify/Customer/not-a-number" } as CustomerNode) : c));
      const next = start + MOCK_PAGE;
      return Response.json({ data: { customers: { nodes, pageInfo: { hasNextPage: next < all.length, endCursor: next < all.length ? String(next) : null } } } });
    }
    if (q.includes("customer { ...V3plCustomerFields }")) {
      calls.orderCustomer++;
      const o = shopOrders.get(String(v.id));
      return Response.json({ data: { order: o ? { id: o.order.id, customer: o.customer } : null } });
    }
    return Response.json({ errors: [{ message: `unexpected query in e2e: ${q.slice(0, 80)}` }] });
  });

  const connect = async (shop: string, name: string) => {
    const begin = await oauth.beginInstall({ shopDomain: shop, name }, admin.id);
    created.storeIds.push(begin.storeId);
    const st = new URL(begin.authorizeUrl).searchParams.get("state")!;
    const prm = new URLSearchParams({ code: "c", shop, state: st, timestamp: String(Math.floor(Date.now() / 1000)) });
    prm.set("hmac", crypto.hmacSha256Hex(secret, crypto.oauthQueryMessage(prm)));
    await oauth.completeInstall(prm, admin.id);
    return begin.storeId;
  };
  const byPair = (storeId: string, n: number) => prisma.customer.findUnique({ where: { shopifyStoreId_shopifyCustomerId: { shopifyStoreId: storeId, shopifyCustomerId: String(n) } } });
  const storeCustomers = (storeId: string) => prisma.customer.findMany({ where: { shopifyStoreId: storeId }, orderBy: { shopifyCustomerId: "asc" } });

  try {
    // ---------------------------------------------------------------- fixtures
    const V = await owners.createOwner("VENDOR", { code: `${RUN}-V`, businessName: `CS Vendor ${RUN}`, contactName: null, email: null, phone: null, addressLine1: null, addressLine2: null, city: null, state: null, postalCode: null, country: null, notes: null }, admin.id);
    created.ownerIds.push(V.id);
    const shared = await customers.createCustomer(ALL, customerFormSchema.parse({ name: `Shared Person ${RUN}`, email: email("shared"), phone: "+15125559999", notes: "VIP — call before delivery", billName: "Shared Person", billAddress1: "PO Box 1", billCity: "Dallas", billCountry: "US" }), admin.id);
    created.customerIds.add(shared.id);
    const owned = await customers.createCustomer({ ownerId: V.id }, customerFormSchema.parse({ ownerId: V.id, name: `Owned Person ${RUN}`, email: email("owned") }), admin.id);
    created.customerIds.add(owned.id);
    const A = await connect(SHOP_A, `CS Store A ${RUN}`);
    const B = await connect(SHOP_B, `CS Store B ${RUN}`);
    const track = async () => { for (const c of await prisma.customer.findMany({ where: { shopifyStoreId: { in: [A, B] } }, select: { id: true } })) created.customerIds.add(c.id); };

    // ---------------------------------------------------------------- 1 scope guard
    await prisma.shopifyStore.update({ where: { id: A }, data: { grantedScopes: "read_orders,write_orders" } });
    const guard = await cs.syncCustomers(A, { actorId: admin.id }).then(() => null, (e: unknown) => e);
    check("1 store without read_customers is refused before any API call (MISSING_SCOPE, reconnect hint)", guard instanceof cs.CustomerSyncError && guard.code === "MISSING_SCOPE" && /Reconnect/.test(guard.message) && calls.customers === 0, String((guard as Error)?.message));
    await prisma.shopifyStore.update({ where: { id: A }, data: { grantedScopes: SCOPES } });

    // ---------------------------------------------------------------- 2–7 initial import
    const r1 = await cs.syncCustomers(A, { actorId: admin.id });
    await track();
    const rowsA = await storeCustomers(A);
    check("2 initial import: 7 customers read over 3 cursor pages, full run, no filter", r1.seen === 7 && r1.pages === 3 && r1.full && r1.since === undefined && calls.lastQuery === null && calls.customers === 3, r1.message);
    check("3 counts: 6 created + 1 linked to the existing company customer, 0 failed", r1.created === 6 && r1.linked === 1 && r1.updated === 0 && r1.failed === 0, r1.message);
    check("4 every synced record carries the store + numeric Shopify id, source SHOPIFY / company pool for new ones", rowsA.length === 7 && rowsA.every((c) => c.shopifyStoreId === A && /^\d+$/.test(c.shopifyCustomerId!)) && rowsA.filter((c) => c.id !== shared.id).every((c) => c.source === "SHOPIFY" && c.ownerId === null));
    const c1 = (await byPair(A, 1))!;
    check("5 field mapping: name, lower-cased e-mail, phone (+digits), default address → ship-to with province/country codes", c1.name === "First1 Last1" && c1.email === email("c1") && c1.phone === "+15125551001" && c1.phoneNormalized === "15125551001" && c1.shipName === "First1 Last1" && c1.shipAddress1 === "1 Main St" && c1.shipCity === "Austin" && c1.shipProvince === "TX" && c1.shipZip === "78701" && c1.shipCountry === "US");
    const c4 = (await byPair(A, 4))!;
    const c5 = (await byPair(A, 5))!;
    check("6 missing e-mail/phone does not break the sync; a customer with only an id gets a fallback name and no contact data", c4.email === null && c4.phone === null && c4.name === "First4 Last4" && c5.name === "Shopify customer 5" && c5.email === null && c5.shipAddress1 === null);
    const sharedAfter = (await prisma.customer.findUnique({ where: { id: shared.id } }))!;
    check("7 adoption: the unmapped company customer with the same e-mail was linked (ids set, Shopify name/phone/address filled) and its V3PL-only notes + billing kept", sharedAfter.shopifyStoreId === A && sharedAfter.shopifyCustomerId === "2" && sharedAfter.name === "First2 Last2" && sharedAfter.phone === "+15125551002" && sharedAfter.shipCity === "Austin" && sharedAfter.notes === "VIP — call before delivery" && sharedAfter.billAddress1 === "PO Box 1" && sharedAfter.source === "MANUAL");
    const ownedAfter = (await prisma.customer.findUnique({ where: { id: owned.id } }))!;
    const c3 = (await byPair(A, 3))!;
    check("8 owner pools are never adopted: the vendor's customer with the same e-mail is untouched; a separate company customer was created", ownedAfter.shopifyCustomerId === null && ownedAfter.ownerId === V.id && c3.id !== owned.id && c3.ownerId === null && c3.email === email("owned"));
    const lastSync = (await prisma.shopifyStore.findUniqueOrThrow({ where: { id: A }, select: { lastCustomerSyncAt: true } })).lastCustomerSyncAt;
    check("9 complete run stamps lastCustomerSyncAt and writes a SUCCESS summary to the sync log", lastSync !== null && (await prisma.shopifySyncLog.count({ where: { storeId: A, entityType: "CUSTOMER", operation: "customer_sync", status: "SUCCESS" } })) === 1 && (await cs.lastCustomerSyncSummary(A)) === r1.message);
    check("10 audit: created customers recorded with source SHOPIFY; adoption recorded as customer.shopify_linked", (await prisma.auditLog.count({ where: { action: "customer.created", entityId: { in: rowsA.filter((c) => c.source === "SHOPIFY").map((c) => c.id) } } })) === 6 && (await prisma.auditLog.count({ where: { action: "customer.shopify_linked", entityId: shared.id } })) === 1);

    // ---------------------------------------------------------------- 11–12 repeat sync: no duplicates, incremental
    const r2 = await cs.syncCustomers(A, { actorId: admin.id });
    const countA2 = await prisma.customer.count({ where: { shopifyStoreId: A } });
    check("11 repeat sync creates nothing: 7 unchanged, still 7 records, no duplicates by e-mail", r2.created === 0 && r2.linked === 0 && r2.updated === 0 && r2.unchanged === 7 && countA2 === 7 && (await prisma.customer.count({ where: { email: email("c1") } })) === 1, r2.message);
    check("12 repeat sync is incremental: query filters updated_at since the last complete run minus the overlap", typeof r2.since === "string" && String(calls.lastQuery).startsWith("updated_at:>='") && new Date(r2.since!).getTime() === lastSync!.getTime() - 10 * 60 * 1000, String(calls.lastQuery));

    // ---------------------------------------------------------------- 13–14 existing customer update, V3PL-only data preserved
    await customers.updateCustomer(ALL, c1.id, customerFormSchema.parse({ name: c1.name, email: c1.email, phone: c1.phone, shipCity: c1.shipCity, notes: "Gate code 4321", billName: "Accounts", billAddress1: "9 Ledger Ln", billCity: "Austin", billCountry: "US" }), admin.id);
    shopCustomers[SHOP_A][0] = mk(1, { email: null, phone: "+15125550001", city: "Round Rock", updatedAt: new Date(Date.now() + 1000).toISOString() });
    const r3 = await cs.syncCustomers(A, { actorId: admin.id });
    const c1b = (await byPair(A, 1))!;
    check("13 mapped customer updated in place (phone + city from Shopify), never duplicated", r3.updated === 1 && r3.created === 0 && c1b.id === c1.id && c1b.phone === "+15125550001" && c1b.phoneNormalized === "15125550001" && c1b.shipCity === "Round Rock" && (await prisma.customer.count({ where: { shopifyStoreId: A } })) === 7, r3.message);
    check("14 empty Shopify values never blank V3PL data: e-mail kept; notes and billing address (V3PL-only) untouched", c1b.email === email("c1") && c1b.notes === "Gate code 4321" && c1b.billAddress1 === "9 Ledger Ln" && c1b.billName === "Accounts");

    // ---------------------------------------------------------------- 15 store isolation
    const rB = await cs.syncCustomers(B, { actorId: admin.id });
    await track();
    const b2 = (await byPair(B, 2))!;
    const a2 = (await byPair(A, 2))!;
    check("15 store isolation: same Shopify id 2 in store B is a different record; same e-mail as A's customer 1 is not merged across stores (identity = store + id, not e-mail)", rB.created === 2 && b2.id !== a2.id && b2.shopifyStoreId === B && b2.email === email("c2") && (await prisma.customer.count({ where: { email: email("c2") } })) === 1 && (await prisma.customer.count({ where: { shopifyStoreId: B } })) === 2, rB.message);

    // ---------------------------------------------------------------- 16 one bad record does not break the sync
    breakRecord = 6;
    for (const c of shopCustomers[SHOP_A]) c.updatedAt = new Date(Date.now() + 2000).toISOString();
    const r4 = await cs.syncCustomers(A, { actorId: admin.id });
    breakRecord = null;
    check("16 a corrupt record is counted as failed and logged with attention; the other six on its pages are still processed", r4.failed === 1 && r4.seen === 7 && r4.unchanged === 6 && r4.full && (await prisma.shopifySyncLog.count({ where: { storeId: A, entityType: "CUSTOMER", operation: "customer_sync", status: "NEEDS_ATTENTION", externalId: { not: null } } })) === 1, r4.message);

    // ---------------------------------------------------------------- 17 time budget → partial, checkpoint untouched
    const before = (await prisma.shopifyStore.findUniqueOrThrow({ where: { id: A }, select: { lastCustomerSyncAt: true } })).lastCustomerSyncAt!;
    const r5 = await cs.syncCustomers(A, { actorId: admin.id, budgetMs: 0 });
    const after = (await prisma.shopifyStore.findUniqueOrThrow({ where: { id: A }, select: { lastCustomerSyncAt: true } })).lastCustomerSyncAt!;
    check("17 time budget exhausted → partial result flagged, lastCustomerSyncAt NOT advanced (next run repeats safely)", !r5.full && /partial/.test(r5.message) && after.getTime() === before.getTime(), r5.message);

    // ---------------------------------------------------------------- 18 API failure → FAILED log, error surfaced
    failCustomersQuery = true;
    const fail = await cs.syncCustomers(A, { actorId: admin.id }).then(() => null, (e: unknown) => e);
    failCustomersQuery = false;
    check("18 Shopify 502 → sync throws a ShopifyApiError and writes a FAILED sync-log row", fail instanceof client.ShopifyApiError && (await prisma.shopifySyncLog.count({ where: { storeId: A, entityType: "CUSTOMER", status: "FAILED" } })) === 1, String((fail as Error)?.message));

    // ---------------------------------------------------------------- 19–21 order relation (inbound import links the directory record)
    const W = await warehouses.createWarehouse({ code: `${RUN}-W`, name: "CS Warehouse", addressLine1: null, addressLine2: null, city: null, state: null, postalCode: null, country: null, notes: null }, admin.id);
    created.warehouseIds.push(W.id);
    const p = await products.createProduct(productFormSchema.parse({ ownerId: V.id, name: `CS Widget ${RUN}`, status: "ACTIVE", variants: [{ sku: `${RUN}-A`, price: "19.99", status: "ACTIVE" }] }), admin.id);
    created.productIds.push(p.id);
    await stores.updateStoreSettings(A, { name: `CS Store A ${RUN}`, ordersImportEnabled: true, importTestOrders: false, ordersImportSince: null, publishEnabled: false, publishLocationId: null, fulfilLocationId: "gid://shopify/Location/1", warehouseIds: [W.id] }, admin.id);
    const VG = `gid://shopify/ProductVariant/${RUN}A`;
    await prisma.shopifyVariantMapping.create({ data: { storeId: A, shopifyProductId: `gid://shopify/Product/${RUN}A`, shopifyVariantId: VG, shopifyInventoryItemId: `gid://shopify/InventoryItem/${RUN}A`, shopifySku: `${RUN}-A`, variantId: p.variants[0].id, status: "MATCHED", matchedBy: "SKU_EXACT" } });
    const money = (a: string) => ({ shopMoney: { amount: a } });
    let seq = 900;
    const mkOrder = (customer: CustomerNode | null): OrderNode => {
      const n = ++seq;
      const o: OrderNode = {
        id: `gid://shopify/Order/${n}`, name: `#CS${n}`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), cancelledAt: null, cancelReason: null, closedAt: null, test: false,
        displayFinancialStatus: "PAID", displayFulfillmentStatus: "UNFULFILLED", currencyCode: "USD", note: null, tags: [], sourceName: "web", email: customer?.defaultEmailAddress?.emailAddress ?? null, phone: null,
        currentSubtotalPriceSet: money("19.99"), currentTotalDiscountsSet: money("0.00"), currentTotalTaxSet: money("0.00"), totalShippingPriceSet: money("0.00"), currentTotalPriceSet: money("19.99"), shippingLines: { nodes: [] }, customAttributes: [],
        shippingAddress: { name: "Buyer Person", firstName: "Buyer", lastName: "Person", company: null, address1: "5 Import Rd", address2: null, city: "Austin", province: null, provinceCode: "TX", zip: "78701", country: null, countryCodeV2: "US", phone: null },
        lineItems: { nodes: [{ id: `gid://shopify/LineItem/${n}`, sku: `${RUN}-A`, title: "CS Widget", variantTitle: null, quantity: 1, currentQuantity: 1, requiresShipping: true, variant: { id: VG }, product: { id: `gid://shopify/Product/${RUN}A` }, originalUnitPriceSet: money("19.99"), totalDiscountSet: money("0.00"), taxLines: [] }] },
      };
      shopOrders.set(o.id, { order: o, customer });
      return o;
    };
    const o1 = mkOrder(shopCustomers[SHOP_A][6]); // customer 7 — already synced
    const in1 = await ordersIn.syncShopifyOrder(A, o1.id, { cause: "orders/create", eventId: `ev-${RUN}-1`, prefetched: o1 });
    if (in1.orderId) created.orderIds.push(in1.orderId);
    const v3plO1 = in1.orderId ? await prisma.order.findUnique({ where: { id: in1.orderId }, select: { customerId: true, customerName: true } }) : null;
    const c7 = (await byPair(A, 7))!;
    check("19 imported order whose Shopify customer is already synced links Order.customerId to that record (order snapshot untouched)", in1.action === "created" && v3plO1?.customerId === c7.id && v3plO1?.customerName === "Buyer Person" && calls.orderCustomer === 1, `${in1.action} ${in1.message}`);
    const newCust = mk(99, { displayName: "Ninety Nine", email: email("c99") });
    const o2 = mkOrder(newCust);
    const in2 = await ordersIn.syncShopifyOrder(A, o2.id, { cause: "orders/create", eventId: `ev-${RUN}-2`, prefetched: o2 });
    if (in2.orderId) created.orderIds.push(in2.orderId);
    await track();
    const c99 = await byPair(A, 99);
    const v3plO2 = in2.orderId ? await prisma.order.findUnique({ where: { id: in2.orderId }, select: { customerId: true } }) : null;
    check("20 order for a Shopify customer not yet in the directory: the customer is created (source SHOPIFY, mapped) and the order linked to it", in2.action === "created" && c99 !== null && c99.source === "SHOPIFY" && c99.name === "Ninety Nine" && v3plO2?.customerId === c99.id, `${in2.action} ${in2.message}`);
    await prisma.shopifyStore.update({ where: { id: A }, data: { grantedScopes: "read_orders,write_orders,write_merchant_managed_fulfillment_orders,read_fulfillments,read_products,write_inventory,read_locations" } });
    const o3 = mkOrder(shopCustomers[SHOP_A][0]);
    const callsBefore = calls.orderCustomer;
    const in3 = await ordersIn.syncShopifyOrder(A, o3.id, { cause: "orders/create", eventId: `ev-${RUN}-3`, prefetched: o3 });
    if (in3.orderId) created.orderIds.push(in3.orderId);
    const v3plO3 = in3.orderId ? await prisma.order.findUnique({ where: { id: in3.orderId }, select: { customerId: true } }) : null;
    check("21 store without read_customers: order imported exactly as before — no customer query, no link", in3.action === "created" && v3plO3?.customerId === null && calls.orderCustomer === callsBefore, `${in3.action} ${in3.message}`);
    await prisma.shopifyStore.update({ where: { id: A }, data: { grantedScopes: SCOPES } });

    // ---------------------------------------------------------------- 22–23 the customer directory still works with synced records
    const list = await customers.listCustomers(ALL, { q: email("c7") });
    const found = await customers.searchCustomers(ALL, "512-555-0001");
    const detail = await customers.getCustomer(ALL, c7.id);
    check("22 directory list/search find synced customers (by e-mail, by phone digits) with source SHOPIFY and order counts", list.total === 1 && list.items[0].id === c7.id && list.items[0].source === "SHOPIFY" && list.items[0]._count.orders === 1 && found.some((c) => c.id === c1.id));
    check("23 directory detail shows the linked imported order; portal scope of the vendor does not see company customers", detail?.orders.length === 1 && detail.orders[0].id === in1.orderId && (await customers.getCustomer({ ownerId: V.id }, c7.id)) === null);
  } finally {
    client.__setShopifyFetchForTests(null);
    const orderIds = created.orderIds;
    await prisma.orderEvent.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await prisma.shopifyStore.deleteMany({ where: { id: { in: created.storeIds } } });
    await prisma.customer.deleteMany({ where: { OR: [{ id: { in: [...created.customerIds] } }, { shopifyStoreId: { in: created.storeIds } }] } });
    await prisma.inventoryLevel.deleteMany({ where: { variant: { productId: { in: created.productIds } } } });
    await prisma.inventoryBalance.deleteMany({ where: { variant: { productId: { in: created.productIds } } } });
    await prisma.productVariant.deleteMany({ where: { productId: { in: created.productIds } } });
    await prisma.product.deleteMany({ where: { id: { in: created.productIds } } });
    await prisma.location.deleteMany({ where: { warehouseId: { in: created.warehouseIds } } });
    await prisma.warehouse.deleteMany({ where: { id: { in: created.warehouseIds } } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: [...created.ownerIds, ...created.productIds, ...created.warehouseIds, ...created.storeIds, ...created.customerIds, ...orderIds] } }, { entityType: { in: ["Location", "ShopifyStore", "ShopifyVariantMapping"] }, createdAt: { gte: new Date(Date.now() - 30 * 60 * 1000) } }] } }).catch(() => undefined);
    await prisma.owner.deleteMany({ where: { id: { in: created.ownerIds } } });
    await prisma.$disconnect();
    console.log(`Cleanup done (${orderIds.length} orders, ${created.storeIds.length} stores, ${created.customerIds.size} customers removed).`);
  }
  const failed = results.filter((x) => !x.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
