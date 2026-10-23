/**
 * Shopify connection layer — unit checks that need no database and no network:
 * token encryption, HMAC verification (webhook + OAuth), shop-domain normalisation,
 * environment validation, and the GraphQL transport (throttle retry, auth errors) with a
 * fake fetch.
 *
 * Usage: npm run test:shopify
 */
import { createHmac } from "node:crypto";

const results: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

async function main() {
  const crypto = await import("../src/server/services/shopify/crypto");
  const env = await import("../src/server/services/shopify/env");
  const client = await import("../src/server/services/shopify/client");

  // ---------------------------------------------------------------- encryption
  const key = Buffer.alloc(32, 7).toString("base64");
  const blob = crypto.encryptSecret("shpat_secret_token_value", key);
  check("encrypt: ciphertext is not plaintext", !blob.includes("shpat_secret") && blob.startsWith("v1."));
  check("decrypt: round trip", crypto.decryptSecret(blob, key) === "shpat_secret_token_value");
  check("encrypt: random IV → different blobs", crypto.encryptSecret("x", key) !== crypto.encryptSecret("x", key));
  let tampered = false;
  try {
    const parts = blob.split(".");
    parts[3] = parts[3].slice(0, -2) + (parts[3].endsWith("A") ? "BB" : "AA");
    crypto.decryptSecret(parts.join("."), key);
  } catch {
    tampered = true;
  }
  check("decrypt: tampered ciphertext rejected", tampered);
  let wrongKey = false;
  try {
    crypto.decryptSecret(blob, Buffer.alloc(32, 9).toString("base64"));
  } catch {
    wrongKey = true;
  }
  check("decrypt: wrong key rejected", wrongKey);

  // ---------------------------------------------------------------- safeEqual
  check("safeEqual: equal strings", crypto.safeEqual("abc", "abc"));
  check("safeEqual: different strings", !crypto.safeEqual("abc", "abd"));
  check("safeEqual: different lengths", !crypto.safeEqual("abc", "abcd"));

  // ---------------------------------------------------------------- webhook HMAC
  const secret = "hush";
  const body = '{"id":123,"topic":"orders/create"}';
  const good = createHmac("sha256", secret).update(body).digest("base64");
  check("webhook hmac: valid signature accepted", crypto.verifyWebhookHmac(body, good, secret));
  check("webhook hmac: modified body rejected", !crypto.verifyWebhookHmac(body + " ", good, secret));
  check("webhook hmac: wrong secret rejected", !crypto.verifyWebhookHmac(body, good, "other"));
  check("webhook hmac: missing header rejected", !crypto.verifyWebhookHmac(body, null, secret));

  // ---------------------------------------------------------------- OAuth HMAC (Shopify docs example)
  const params = new URLSearchParams("code=0907a61c0c8d55e99db179b68161bc00&hmac=700e2dadb827fcc8609e9d5ce208b2e9cdaab9df07390d2cbca10d7c328fc4bf&shop=some-shop.myshopify.com&state=0.6784241404160823&timestamp=1337178173");
  check("oauth hmac: message built per Shopify spec", crypto.oauthQueryMessage(params) === "code=0907a61c0c8d55e99db179b68161bc00&shop=some-shop.myshopify.com&state=0.6784241404160823&timestamp=1337178173");
  check("oauth hmac: Shopify documentation vector verifies", crypto.verifyOAuthQueryHmac(params, "hush"));
  const tamperedParams = new URLSearchParams(params);
  tamperedParams.set("shop", "evil-shop.myshopify.com");
  check("oauth hmac: changed shop rejected", !crypto.verifyOAuthQueryHmac(tamperedParams, "hush"));
  const special = new URLSearchParams();
  special.set("a&b", "x=y%z");
  special.set("shop", "s.myshopify.com");
  check("oauth hmac: special characters encoded", crypto.oauthQueryMessage(special) === "a%26b=x=y%25z&shop=s.myshopify.com");

  // ---------------------------------------------------------------- shop domain
  check("domain: bare handle", crypto.normalizeShopDomain("Casabella") === "casabella.myshopify.com");
  check("domain: full domain", crypto.normalizeShopDomain(" casabella.myshopify.com ") === "casabella.myshopify.com");
  check("domain: URL with path", crypto.normalizeShopDomain("https://casabella.myshopify.com/admin") === "casabella.myshopify.com");
  check("domain: custom domain rejected", crypto.normalizeShopDomain("www.casabella.com") === null);
  check("domain: injection rejected", crypto.normalizeShopDomain("evil.com/?x=.myshopify.com") === null);
  check("domain: empty rejected", crypto.normalizeShopDomain("") === null);

  // ---------------------------------------------------------------- env
  const saved = { ...process.env };
  try {
    process.env.SHOPIFY_API_KEY = "cid";
    process.env.SHOPIFY_API_SECRET = "csecret";
    process.env.SHOPIFY_API_VERSION = "";
    process.env.SHOPIFY_SCOPES = "";
    process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY = key;
    env.__resetShopifyEnvCache();
    const e = env.shopifyEnv();
    check("env: defaults applied", e.SHOPIFY_API_VERSION === env.SHOPIFY_DEFAULT_API_VERSION && e.SHOPIFY_SCOPES === env.SHOPIFY_DEFAULT_SCOPES);
    check("env: scopes match D-023 + write_orders (D-062) + read_customers (D-065)", e.SHOPIFY_SCOPES === "read_orders,write_orders,write_merchant_managed_fulfillment_orders,read_fulfillments,read_products,write_inventory,read_locations,read_customers");
    process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY = "short";
    env.__resetShopifyEnvCache();
    check("env: bad encryption key reported", !env.isShopifyConfigured() && env.shopifyEnvProblems().includes("SHOPIFY_TOKEN_ENCRYPTION_KEY"));
    process.env.CRON_SECRET = "tooshort";
    check("env: short CRON_SECRET ignored", env.cronSecret() === null);
    process.env.CRON_SECRET = "a-sufficiently-long-secret-value";
    check("env: CRON_SECRET accepted", env.cronSecret() === "a-sufficiently-long-secret-value");
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    env.__resetShopifyEnvCache();
  }

  // ---------------------------------------------------------------- GraphQL transport
  const target = { shopDomain: "test.myshopify.com", apiVersion: "2026-07", accessToken: "tok" };
  let calls = 0;
  client.__setShopifyFetchForTests(async (input, init) => {
    calls++;
    const url = String(input);
    check(`client: posts to versioned endpoint (call ${calls})`, url === "https://test.myshopify.com/admin/api/2026-07/graphql.json" && (init?.headers as Record<string, string>)["X-Shopify-Access-Token"] === "tok");
    if (calls === 1) {
      return new Response(JSON.stringify({ errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }], extensions: { cost: { requestedQueryCost: 10, actualQueryCost: null, throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 5, restoreRate: 50 } } } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ data: { shop: { name: "Test" } } }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  const t0 = Date.now();
  const r = await client.graphqlRequest<{ shop: { name: string } }>(target, "query { shop { name } }");
  check("client: THROTTLED retried then succeeds", calls === 2 && r.data.shop.name === "Test", `${Date.now() - t0} ms`);

  client.__setShopifyFetchForTests(async () => new Response("{}", { status: 401 }));
  let unauthorized = false;
  try {
    await client.graphqlRequest(target, "query { shop { name } }");
  } catch (err) {
    unauthorized = err instanceof client.ShopifyApiError && err.code === "UNAUTHORIZED";
  }
  check("client: 401 → UNAUTHORIZED", unauthorized);

  client.__setShopifyFetchForTests(async () => new Response(JSON.stringify({ errors: [{ message: "Field 'nope' doesn't exist" }] }), { status: 200 }));
  let gqlErr = false;
  try {
    await client.graphqlRequest(target, "query { nope }");
  } catch (err) {
    gqlErr = err instanceof client.ShopifyApiError && err.code === "GRAPHQL" && err.message.includes("nope");
  }
  check("client: GraphQL errors surfaced", gqlErr);

  client.__setShopifyFetchForTests(async () => {
    throw new Error("ECONNRESET");
  });
  let net = false;
  try {
    await client.graphqlRequest(target, "query { shop { name } }");
  } catch (err) {
    net = err instanceof client.ShopifyApiError && err.code === "NETWORK";
  }
  check("client: network failure → NETWORK", net);
  client.__setShopifyFetchForTests(null);

  check("client: gid helpers", client.gidToId("gid://shopify/Order/12345") === "12345" && client.toGid("Order", "12345") === "gid://shopify/Order/12345" && client.toGid("Order", "gid://shopify/Order/1") === "gid://shopify/Order/1");
  check("client: firstUserError formats field", client.firstUserError({ userErrors: [{ field: ["input", "sku"], message: "is invalid" }] }) === "input.sku: is invalid" && client.firstUserError({ userErrors: [] }) === null);

  // ---------------------------------------------------------------- catalog matching (pure)
  const match = await import("../src/server/services/shopify/catalog-match");
  check("match: normalizeSku trims + upper-cases only", match.normalizeSku("  abc-1 ") === "ABC-1" && match.normalizeSku(null) === "" && match.normalizeSku("a b") === "A B");
  type R = import("../src/server/services/shopify/catalog-match").MatchRow;
  const row = (id: string, sku: string | null, extra: Partial<R> = {}): R => ({ id, shopifyVariantId: `gid://shopify/ProductVariant/${id}`, shopifySku: sku, previousSku: sku, status: "UNMATCHED", matchedBy: null, variantId: null, ...extra });
  const internal = [
    { id: "iA1", sku: "A1", status: "ACTIVE" as const, productStatus: "ACTIVE" as const },
    { id: "iA2", sku: "A2", status: "ACTIVE" as const, productStatus: "ACTIVE" as const },
    { id: "iARCH", sku: "ARCH", status: "ARCHIVED" as const, productStatus: "ACTIVE" as const },
    { id: "iPARCH", sku: "PARCH", status: "ACTIVE" as const, productStatus: "ARCHIVED" as const },
    { id: "iB1", sku: "B1", status: "ACTIVE" as const, productStatus: "ACTIVE" as const },
  ];
  const decisions = match.computeMatches(
    [
      row("1", "A1"),
      row("2", " a2 "),
      row("3", "DUP"),
      row("4", "dup"),
      row("5", null),
      row("6", "ARCH"),
      row("7", "PARCH"),
      row("8", "ORPHAN"),
      row("9", "X-MANUAL", { status: "MATCHED", matchedBy: "MANUAL", variantId: "iB1" }),
      row("10", "B1"),
      row("11", "IGN", { status: "IGNORED", previousSku: "IGN" }),
      row("12", "IGN2", { status: "IGNORED", previousSku: "OLD-IGN" }),
      row("13", "Title Only Should Not Matter"),
      row("14", null, { status: "IGNORED", previousSku: "" }),
      row("15", "GAINED", { status: "IGNORED", previousSku: "" }),
    ],
    internal,
  );
  const d = (id: string) => decisions.find((x) => x.id === id)!;
  check("match: exact SKU → MATCHED SKU_EXACT", d("1").status === "MATCHED" && d("1").matchedBy === "SKU_EXACT" && d("1").variantId === "iA1");
  check("match: trim + case normalisation matches", d("2").status === "MATCHED" && d("2").variantId === "iA2");
  check("match: duplicate Shopify SKUs → CONFLICT (both)", d("3").status === "CONFLICT" && d("4").status === "CONFLICT" && d("3").variantId === null);
  check("match: empty SKU → UNMATCHED", d("5").status === "UNMATCHED" && /no SKU/.test(d("5").reason));
  check("match: archived internal variant not matched", d("6").status === "UNMATCHED" && /archived/.test(d("6").reason));
  check("match: archived internal product not matched", d("7").status === "UNMATCHED" && /archived/.test(d("7").reason));
  check("match: unknown SKU → UNMATCHED", d("8").status === "UNMATCHED");
  check("match: manual mapping preserved", d("9").status === "MATCHED" && d("9").matchedBy === "MANUAL" && d("9").variantId === "iB1" && d("9").changed === false);
  check("match: SKU already mapped manually elsewhere → CONFLICT", d("10").status === "CONFLICT" && /manually/.test(d("10").reason));
  check("match: IGNORED sticky while SKU unchanged", d("11").status === "IGNORED" && d("11").changed === false);
  check("match: IGNORED released when SKU changed", d("12").status === "UNMATCHED");
  check("match: title-like SKU never matches anything", d("13").status === "UNMATCHED");
  check("match: IGNORED no-SKU variant stays ignored", d("14").status === "IGNORED");
  check("match: IGNORED no-SKU variant released once it gains a SKU", d("15").status === "UNMATCHED");
  const summary = match.summarizeDecisions(decisions);
  check("match: summary counts", summary.MATCHED === 3 && summary.CONFLICT === 3 && summary.IGNORED === 2 && summary.UNMATCHED === 7);

  // ---------------------------------------------------------------- orders-in pure helpers
  const oi = await import("../src/server/services/shopify/orders-in");
  type L = import("../src/server/services/shopify/queries").OrderLineNode;
  const ln = (id: string, sku: string | null, qty: number, ship: boolean, extra: Partial<L> = {}): L => ({ id: `gid://shopify/LineItem/${id}`, sku, title: `Item ${id}`, variantTitle: extra.variantTitle ?? "Default Title", quantity: qty, currentQuantity: extra.currentQuantity ?? qty, requiresShipping: ship, variant: extra.variant ?? { id: `gid://shopify/ProductVariant/${id}` }, product: { id: "gid://shopify/Product/1" }, originalUnitPriceSet: { shopMoney: { amount: "10.00" } }, totalDiscountSet: { shopMoney: { amount: "1.00" } }, taxLines: [{ priceSet: { shopMoney: { amount: "0.50" } } }, { priceSet: { shopMoney: { amount: "0.25" } } }] });
  const split = oi.splitLines([ln("1", "A", 2, true), ln("2", null, 1, false), ln("3", "GW", 1, false), ln("4", "B", 3, true, { currentQuantity: 0 })]);
  check("orders: splitLines separates shippable / non-shipping and drops zero-quantity lines", split.shippable.length === 1 && split.shippable[0].sku === "A" && split.nonShipping.length === 2);
  check("orders: describeLine normalises SKU and omits Default Title", oi.describeLine(ln("3", " gw-1 ", 1, false)) === "Item 3 ×1 (SKU GW-1)" && oi.describeLine(ln("2", null, 2, false, { variantTitle: "Large" })) === "Item 2 / Large ×2");
  check("orders: lineTax sums tax lines", oi.lineTax(ln("1", "A", 1, true)) === "0.75");
  const order = { id: "gid://shopify/Order/555", name: "#1001", createdAt: "2026-09-07T01:39:50Z", updatedAt: "2026-09-07T02:00:00Z", cancelledAt: null, cancelReason: null, closedAt: null, test: false, displayFinancialStatus: "PAID", displayFulfillmentStatus: "UNFULFILLED", currencyCode: "USD", note: "leave at door", tags: ["vip", "web"], sourceName: "web", email: "buyer@example.com", phone: "+15550001", currentSubtotalPriceSet: { shopMoney: { amount: "20.00" } }, currentTotalDiscountsSet: { shopMoney: { amount: "1.00" } }, currentTotalTaxSet: { shopMoney: { amount: "0.75" } }, totalShippingPriceSet: { shopMoney: { amount: "5.00" } }, currentTotalPriceSet: { shopMoney: { amount: "24.75" } }, shippingLines: { nodes: [{ title: "Standard", code: "STD" }] }, shippingAddress: { name: "Ayla Gg", firstName: "Ayla", lastName: "Gg", company: "Inc", address1: "W 1 St", address2: "", city: "Rome", province: "Georgia", provinceCode: "GA", zip: "30161", country: "United States", countryCodeV2: "US", phone: null }, lineItems: { nodes: [ln("1", "A", 2, true)] } } as import("../src/server/services/shopify/queries").OrderNode;
  const input = oi.buildCreateInput({ storeId: "st", shopDomain: "shop.myshopify.com", order, resolved: [{ line: order.lineItems.nodes[0], variantId: "vA" }], warehouseId: "wh", eventId: "ev1" });
  check("orders: buildCreateInput identity + sourceRef with domain", input.source === "SHOPIFY" && input.sourceRef === "shop.myshopify.com #1001" && input.shopify?.orderId === "555" && input.shopify?.orderName === "#1001" && input.externalEventId === "ev1:create");
  check("orders: buildCreateInput ship-to snapshot from order fields only", input.customerName === "Ayla Gg" && input.customerEmail === "buyer@example.com" && input.customerPhone === "+15550001" && input.shipProvince === "GA" && input.shipCountry === "US" && input.shipAddress2 === null && input.shipCompany === "Inc");
  check("orders: buildCreateInput totals, tags, shipping method, reserve", input.total === "24.75" && input.shippingTotal === "5.00" && input.tags === "vip, web" && input.shippingMethod === "Standard" && input.reserve === true && input.warehouseId === "wh" && input.lines[0].quantity === 2 && input.lines[0].tax === "0.75" && input.lines[0].externalLineId === "gid://shopify/LineItem/1" && input.lines[0].requiresShipping === true);
  const noWh = oi.buildCreateInput({ storeId: "st", shopDomain: "shop.myshopify.com", order: { ...order, cancelledAt: "2026-09-07T03:00:00Z" }, resolved: [{ line: order.lineItems.nodes[0], variantId: "vA" }], warehouseId: null });
  check("orders: no warehouse / cancelled → reserve false, cancelledAt passed", noWh.reserve === false && noWh.shopify?.cancelledAt instanceof Date && noWh.externalEventId === null);

  // ---------------------------------------------------------------- fulfillment-in status mapping (pure)
  const fin = await import("../src/server/services/shopify/fulfillment-in");
  check("fulfillment: DELIVERED / PICKED_UP → DELIVERED", fin.shipmentStatusFor("DELIVERED", "SUCCESS").status === "DELIVERED" && fin.shipmentStatusFor("PICKED_UP", "SUCCESS").status === "DELIVERED");
  check("fulfillment: IN_TRANSIT / OUT_FOR_DELIVERY / ATTEMPTED_DELIVERY → IN_TRANSIT", ["IN_TRANSIT", "OUT_FOR_DELIVERY", "ATTEMPTED_DELIVERY"].every((d) => fin.shipmentStatusFor(d, "SUCCESS").status === "IN_TRANSIT"));
  check("fulfillment: CANCELLED → attention only, no status change", fin.shipmentStatusFor("CANCELED", "CANCELLED").status === null && /cancelled/.test(fin.shipmentStatusFor(null, "CANCELLED").attention ?? ""));
  check("fulfillment: FAILURE / NOT_DELIVERED → attention only", fin.shipmentStatusFor("FAILURE", "SUCCESS").status === null && /carrier/.test(fin.shipmentStatusFor("NOT_DELIVERED", "SUCCESS").attention ?? ""));
  check("fulfillment: FULFILLED / LABEL_PRINTED → no change", fin.shipmentStatusFor("FULFILLED", "SUCCESS").status === null && fin.shipmentStatusFor("LABEL_PRINTED", "SUCCESS").attention === null);

  // ---------------------------------------------------------------- inventory mutations: @idempotent (Admin API 2026-04+)
  const q = await import("../src/server/services/shopify/queries");
  const pub = await import("../src/server/services/shopify/inventory-publish");
  const hasIdem = (doc: string, field: string) => new RegExp(`\\$idempotencyKey: String!`).test(doc) && new RegExp(`${field}\\([^)]*\\) @idempotent\\(key: \\$idempotencyKey\\)`).test(doc);
  check("inventory: inventoryActivate declares $idempotencyKey and applies @idempotent(key: $idempotencyKey) on the field", hasIdem(q.INVENTORY_ACTIVATE_MUTATION, "inventoryActivate"));
  check("inventory: inventorySetQuantities declares $idempotencyKey and applies @idempotent(key: $idempotencyKey) on the field", hasIdem(q.INVENTORY_SET_QUANTITIES_MUTATION, "inventorySetQuantities"));
  check("inventory: inventoryAdjustQuantities is not used by the integration (state-based set only)", !Object.values(q).some((v) => typeof v === "string" && v.includes("inventoryAdjustQuantities")));
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const intent = { itemId: "gid://shopify/InventoryItem/1", locationId: "gid://shopify/Location/1", quantity: 5, compare: 3, force: false };
  const k1 = pub.chooseIdempotencyKey(undefined, intent);
  const k2 = pub.chooseIdempotencyKey(undefined, intent);
  check("inventory: a fresh execution gets a random UUID key, unique per execution", uuidRe.test(k1) && uuidRe.test(k2) && k1 !== k2);
  check("inventory: retry with the identical intent reuses the remembered key (Shopify replays, no second mutation)", pub.chooseIdempotencyKey({ ...intent, key: k1 }, intent) === k1);
  check("inventory: any change of intent (quantity / compare / force / location) gets a new key", [{ ...intent, quantity: 6 }, { ...intent, compare: 4 }, { ...intent, force: true }, { ...intent, locationId: "gid://shopify/Location/2" }].every((i) => pub.chooseIdempotencyKey({ ...intent, key: k1 }, i) !== k1));
  check("inventory: a malformed remembered key is never reused", pub.chooseIdempotencyKey({ ...intent, key: "not-a-uuid" }, intent) !== "not-a-uuid");
  const setInput = pub.buildSetQuantitiesInput({ storeId: "st", variantId: "v1", ...intent });
  check("inventory: 2026-07 InventorySetQuantitiesInput — name/reason/referenceDocumentUri/quantities only, compare via changeFromQuantity", setInput.name === "available" && setInput.reason === "correction" && setInput.referenceDocumentUri === "v3pl://publish/st/v1" && !("ignoreCompareQuantity" in setInput) && setInput.quantities.length === 1 && setInput.quantities[0].changeFromQuantity === 3 && !("compareQuantity" in setInput.quantities[0]) && setInput.quantities[0].quantity === 5);
  check("inventory: force publish → changeFromQuantity null (CAS skipped), never a removed field", pub.buildSetQuantitiesInput({ storeId: "st", variantId: "v1", ...intent, force: true }).quantities[0].changeFromQuantity === null);
  check("inventory: stale compare recognised by 2026-07 code CHANGE_FROM_QUANTITY_STALE and legacy COMPARE_QUANTITY_STALE, not by other codes", pub.isCompareStale({ code: "CHANGE_FROM_QUANTITY_STALE", message: "x" }) && pub.isCompareStale({ code: "COMPARE_QUANTITY_STALE", message: "x" }) && pub.isCompareStale({ code: null, message: "The changeFromQuantity value does not match persisted value." }) && !pub.isCompareStale({ code: "INVALID_LOCATION", message: "The specified location could not be found." }) && !pub.isCompareStale({ code: "IDEMPOTENCY_PREVIOUS_ATTEMPT_FAILED", message: "retry" }));

  // ---------------------------------------------------------------- manual order → Shopify order: pure mapping (D-062)
  const oo = await import("../src/server/services/shopify/order-out");
  const req: import("../src/server/services/shopify-order-request").ShopifyOrderRequest = {
    version: 1, idempotencyKey: "order:o1", origin: "V3PL_MANUAL",
    order: { id: "o1", orderNumber: "1130", source: "MANUAL", placedAt: "2026-09-15T01:00:00.000Z", currency: "USD", shippingMethod: "Ground", notes: " Ring twice ", tags: "vip, rush", subtotal: "32.50", discountTotal: null, taxTotal: null, shippingTotal: "7.50", total: "40.00" },
    store: { id: "st", shopDomain: "x.myshopify.com", name: "X" },
    customer: { customerId: "c1", name: "Ada Buyer", email: "ada@example.com", phone: "+15125550100" },
    shippingAddress: { name: "Ada Maria Buyer", company: null, address1: "1 Way", address2: null, city: "Austin", province: "Texas", zip: "78701", country: "United States", phone: null },
    billingAddress: { name: "Ada", company: "Co", address1: "PO 9", address2: null, city: "Dallas", province: "TX", zip: "75201", country: "US" },
    lines: [{ orderItemId: "i1", variantId: "v1", sku: "A", title: "A", variantTitle: null, quantity: 2, unitPrice: "10.00", shopifyVariantId: "gid://shopify/ProductVariant/1", shopifyProductId: "gid://shopify/Product/1", shopifyInventoryItemId: null }, { orderItemId: "i2", variantId: "v2", sku: "B", title: "B", variantTitle: null, quantity: 1, unitPrice: "12.50", shopifyVariantId: "gid://shopify/ProductVariant/2", shopifyProductId: "gid://shopify/Product/2", shopifyInventoryItemId: null }],
  };
  const built = oo.buildOrderCreateInput(req);
  const bo = built.order as Record<string, Any>;
  check("order-out: marker tags V3PL + V3PL-<n> first, V3PL tags appended, deduplicated", bo.tags.join(",") === "V3PL,V3PL-1130,vip,rush" && oo.v3plTags("7").join(",") === "V3PL,V3PL-7");
  check("order-out: note 'Created from V3PL order <n>.' + trimmed notes; attributes 'V3PL order' + v3pl_idempotency_key", bo.note === "Created from V3PL order 1130.\n\nRing twice" && oo.v3plNote("5", null) === "Created from V3PL order 5." && bo.customAttributes.find((a: { key: string }) => a.key === "v3pl_idempotency_key").value === "order:o1" && bo.customAttributes.find((a: { key: string }) => a.key === "V3PL order").value === "1130");
  check("order-out: lines use contract variant ids + quantities + V3PL retail priceSet in the order currency", bo.lineItems.length === 2 && bo.lineItems[0].variantId === "gid://shopify/ProductVariant/1" && bo.lineItems[0].quantity === 2 && bo.lineItems[0].priceSet.shopMoney.amount === "10.00" && bo.lineItems[0].priceSet.shopMoney.currencyCode === "USD" && bo.lineItems[1].priceSet.shopMoney.amount === "12.50");
  check("order-out: unpaid → financialStatus PENDING; options BYPASS inventory, no receipts; processedAt = placedAt", bo.financialStatus === "PENDING" && built.options.inventoryBehaviour === "BYPASS" && built.options.sendReceipt === false && built.options.sendFulfillmentReceipt === false && bo.processedAt === "2026-09-15T01:00:00.000Z");
  check("order-out: address — long province/country as text fields, codes as provinceCode/countryCode, name split first/rest", bo.shippingAddress.province === "Texas" && bo.shippingAddress.country === "United States" && bo.shippingAddress.firstName === "Ada" && bo.shippingAddress.lastName === "Maria Buyer" && bo.billingAddress.provinceCode === "TX" && bo.billingAddress.countryCode === "US" && bo.billingAddress.lastName === "Ada" && bo.billingAddress.company === "Co");
  check("order-out: shipping line from method + total; email/phone at order level; no customer object", bo.shippingLines[0].title === "Ground" && bo.shippingLines[0].priceSet.shopMoney.amount === "7.50" && bo.email === "ada@example.com" && bo.phone === "+15125550100" && !("customer" in bo));
  check("order-out: empty address → omitted; parser accepts only 'order:<id>'", oo.mailingAddressInput({ name: null, company: null, address1: null, address2: null, city: null, province: null, zip: null, country: null }) === undefined && oo.v3plOrderIdFromAttributes([{ key: "v3pl_idempotency_key", value: "order:abc" }]) === "abc" && oo.v3plOrderIdFromAttributes([{ key: "v3pl_idempotency_key", value: "fulfillment:abc" }]) === null);

  // ---------------------------------------------------------------- customer sync (D-065) — pure mapping
  const cs = await import("../src/server/services/shopify/customers-sync");
  const qq = await import("../src/server/services/shopify/queries");
  const full = cs.customerValuesFromNode({ id: "gid://shopify/Customer/42", firstName: "Ada", lastName: "Lovelace", displayName: "Ada Lovelace", updatedAt: "2026-09-22T00:00:00Z", defaultEmailAddress: { emailAddress: "Ada@Example.com" }, defaultPhoneNumber: { phoneNumber: "+15125550100" }, defaultAddress: { name: "Ada M. Lovelace", company: "Analytical Co", address1: "1 Engine St", address2: null, city: "Austin", province: "Texas", provinceCode: "TX", zip: "78701", country: "United States", countryCodeV2: "US", phone: "+15125550199" } });
  check("customers: node → name/e-mail/phone + default address as ship-to (codes preferred over names)", full.name === "Ada Lovelace" && full.email === "Ada@Example.com" && full.phone === "+15125550100" && full.ship?.shipName === "Ada M. Lovelace" && full.ship?.shipCompany === "Analytical Co" && full.ship?.shipAddress1 === "1 Engine St" && full.ship?.shipProvince === "TX" && full.ship?.shipCountry === "US" && full.ship?.shipZip === "78701" && full.ship?.shipPhone === "+15125550199");
  const bare = cs.customerValuesFromNode({ id: "gid://shopify/Customer/43", updatedAt: "2026-09-22T00:00:00Z", defaultEmailAddress: null, defaultPhoneNumber: null, defaultAddress: null });
  check("customers: missing name/e-mail/phone/address does not break the mapping — fallback name, nulls, no ship-to", bare.name === "Shopify customer 43" && bare.email === null && bare.phone === null && bare.ship === null);
  const parts = cs.customerValuesFromNode({ id: "gid://shopify/Customer/44", firstName: "Grace", lastName: null, displayName: "   ", updatedAt: "2026-09-22T00:00:00Z", defaultEmailAddress: { emailAddress: "g@example.com" }, defaultPhoneNumber: null, defaultAddress: { firstName: "Grace", lastName: "Hopper", address1: "2 Navy Rd", city: "NYC", province: "New York", provinceCode: null, zip: "10001", country: "United States", countryCodeV2: null, phone: "+12125550100" } });
  check("customers: blank displayName → first/last name; phone falls back to the address phone; province/country names when no codes", parts.name === "Grace" && parts.phone === "+12125550100" && parts.ship?.shipName === "Grace Hopper" && parts.ship?.shipProvince === "New York" && parts.ship?.shipCountry === "United States");
  check("customers: scope guard — read_customers or write_customers grants, anything else does not", cs.hasReadCustomers("read_orders, read_customers") && cs.hasReadCustomers("write_customers") && !cs.hasReadCustomers("read_orders,write_orders") && !cs.hasReadCustomers(null));
  const since = cs.customerSyncQuery(new Date("2026-09-22T12:00:00Z"), false);
  check("customers: incremental query = updated_at since last complete run minus a 10-minute overlap; first/full run = no filter", since === "updated_at:>='2026-09-22T11:50:00.000Z'" && cs.customerSyncQuery(null, false) === null && cs.customerSyncQuery(new Date(), true) === null);
  check("customers: GraphQL documents use the 2026-07 non-deprecated fields (defaultEmailAddress / defaultPhoneNumber), page with cursor, filter with query", /customers\(first: \$first, after: \$after, query: \$query, sortKey: ID\)/.test(qq.CUSTOMERS_QUERY) && qq.CUSTOMERS_QUERY.includes("defaultEmailAddress { emailAddress }") && qq.CUSTOMERS_QUERY.includes("defaultPhoneNumber { phoneNumber }") && !/\bemail\b/.test(qq.CUSTOMER_FIELDS_FRAGMENT.replace(/emailAddress/g, "")) && qq.ORDER_CUSTOMER_QUERY.includes("customer { ...V3plCustomerFields }"));

  const failed = results.filter((x) => !x.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
