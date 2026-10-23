/**
 * Shopify Step 1 end-to-end check: store connection layer against a running server + database.
 * Shopify itself is simulated in-process (token endpoint, shop/locations queries); webhook and
 * cron routes are exercised over HTTP. Creates temporary owners/warehouses/products/orders and a
 * fake store, then removes everything it created.
 *
 * Usage: npm run e2e:shopify1 -- http://localhost:3100 vendor3pl@gmail.com
 */
import { createHmac, randomBytes } from "node:crypto";
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });
loadEnv();

const [base = "http://localhost:3100", adminEmail = "vendor3pl@gmail.com"] = process.argv.slice(2);
const RUN = `S1${Date.now().toString(36)}`.toUpperCase();
const SHOP = `v3pl-e2e-${RUN.toLowerCase()}.myshopify.com`;
const results: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const expectError = async (fn: () => Promise<unknown>, code: string) => {
  try {
    await fn();
    return { hit: false, code: undefined as string | undefined };
  } catch (e) {
    const c = (e as { code?: string }).code;
    return { hit: c === code, code: c };
  }
};

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { appUrl } = await import("../src/lib/env");
  await import("../src/server/services/shopify/register");
  const shopifyEnv = (await import("../src/server/services/shopify/env")).shopifyEnv();
  const client = await import("../src/server/services/shopify/client");
  const crypto = await import("../src/server/services/shopify/crypto");
  const oauth = await import("../src/server/services/shopify/oauth");
  const api = await import("../src/server/services/shopify/api");
  const stores = await import("../src/server/services/shopify/stores");
  const jobs = await import("../src/server/services/shopify/jobs");
  const webhooks = await import("../src/server/services/shopify/webhooks");
  const syncLog = await import("../src/server/services/shopify/sync-log");
  const owners = await import("../src/server/services/owners");
  const products = await import("../src/server/services/products");
  const warehouses = await import("../src/server/services/warehouses");
  const receiving = await import("../src/server/services/receiving");
  const orders = await import("../src/server/services/orders");
  const fulfillment = await import("../src/server/services/fulfillment");

  const admin = await prisma.user.findFirstOrThrow({ where: { email: adminEmail, role: "ADMIN" } });
  const created = { ownerIds: [] as string[], productIds: [] as string[], warehouseIds: [] as string[], orderIds: new Set<string>(), storeIds: [] as string[] };
  const secret = shopifyEnv.SHOPIFY_API_SECRET;

  // ---------------------------------------------------------------- simulated Shopify
  const shopify = { validTokens: new Set<string>(), tokenCalls: [] as Record<string, string>[], graphqlCalls: 0 };
  client.__setShopifyFetchForTests(async (input, init) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (url === `https://${SHOP}/admin/oauth/access_token`) {
      const body = JSON.parse(String(init?.body)) as Record<string, string>;
      shopify.tokenCalls.push(body);
      if (body.client_id !== shopifyEnv.SHOPIFY_API_KEY || body.client_secret !== secret) return new Response('{"error":"invalid_client"}', { status: 401 });
      const n = shopify.tokenCalls.length;
      const token = `shpat_${RUN}_${n}`;
      shopify.validTokens.add(token);
      if (body.grant_type === "refresh_token") {
        if (!body.refresh_token?.startsWith(`shprt_${RUN}`)) return new Response('{"error":"invalid_grant"}', { status: 400 });
        return Response.json({ access_token: token, scope: shopifyEnv.SHOPIFY_SCOPES, expires_in: 86399, refresh_token: `shprt_${RUN}_${n}`, refresh_token_expires_in: 7_776_000 });
      }
      if (body.code !== `code-${RUN}` || body.expiring !== "1") return new Response('{"error":"invalid_request"}', { status: 400 });
      return Response.json({ access_token: token, scope: shopifyEnv.SHOPIFY_SCOPES, expires_in: 86399, refresh_token: `shprt_${RUN}_${n}`, refresh_token_expires_in: 7_776_000 });
    }
    if (url === `https://${SHOP}/admin/api/${shopifyEnv.SHOPIFY_API_VERSION}/graphql.json`) {
      shopify.graphqlCalls++;
      if (!shopify.validTokens.has(headers["X-Shopify-Access-Token"])) return new Response('{"errors":"[API] Invalid API key or access token"}', { status: 401 });
      const q = JSON.parse(String(init?.body)) as { query: string };
      if (q.query.includes("shop {")) return Response.json({ data: { shop: { id: "gid://shopify/Shop/1", name: `E2E Shop ${RUN}`, myshopifyDomain: SHOP, currencyCode: "USD", ianaTimezone: "America/New_York", plan: { displayName: "Developer Preview", partnerDevelopment: true, shopifyPlus: false } } } });
      if (q.query.includes("locations(")) return Response.json({ data: { locations: { nodes: [{ id: "gid://shopify/Location/1001", name: "Main warehouse", isActive: true, fulfillsOnlineOrders: true, shipsInventory: true, address: { city: "Austin", country: "US" } }], pageInfo: { hasNextPage: false, endCursor: null } } } });
      return Response.json({ errors: [{ message: "unexpected query in e2e" }] });
    }
    return new Response("not found", { status: 404 });
  });

  const signedCallback = (state: string, code: string) => {
    const p = new URLSearchParams({ code, shop: SHOP, state, timestamp: String(Math.floor(Date.now() / 1000)), host: Buffer.from(`${SHOP}/admin`).toString("base64url") });
    p.set("hmac", crypto.hmacSha256Hex(secret, crypto.oauthQueryMessage(p)));
    return p;
  };
  const webhookPost = (path: string, topic: string, payload: unknown, opts: { shop?: string; secret?: string; webhookId?: string; eventId?: string } = {}) => {
    const body = JSON.stringify(payload);
    return fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Topic": topic,
        "X-Shopify-Shop-Domain": opts.shop ?? SHOP,
        "X-Shopify-Webhook-Id": opts.webhookId ?? `wh-${RUN}-${randomBytes(6).toString("hex")}`,
        "X-Shopify-Event-Id": opts.eventId ?? `ev-${RUN}-${randomBytes(6).toString("hex")}`,
        "X-Shopify-API-Version": shopifyEnv.SHOPIFY_API_VERSION,
        "X-Shopify-Triggered-At": new Date().toISOString(),
        "X-Shopify-Hmac-Sha256": createHmac("sha256", opts.secret ?? secret).update(body).digest("base64"),
      },
      body,
    });
  };
  const waitForEvent = async (webhookId: string, statuses: string[], timeoutMs = 8000) => {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const ev = await prisma.shopifyWebhookEvent.findUnique({ where: { webhookId } });
      if (ev && statuses.includes(ev.status)) return ev;
      if (Date.now() > until) return ev;
      await sleep(300);
    }
  };

  try {
    // ---------------------------------------------------------------- begin install
    const begin = await oauth.beginInstall({ shopDomain: SHOP.replace(".myshopify.com", ""), name: `E2E Store ${RUN}` }, admin.id);
    created.storeIds.push(begin.storeId);
    const authorize = new URL(begin.authorizeUrl);
    check("install: authorize URL targets the shop", authorize.origin === `https://${SHOP}` && authorize.pathname === "/admin/oauth/authorize");
    check("install: authorize URL carries client id, scopes, redirect, state", authorize.searchParams.get("client_id") === shopifyEnv.SHOPIFY_API_KEY && authorize.searchParams.get("scope") === shopifyEnv.SHOPIFY_SCOPES && authorize.searchParams.get("redirect_uri") === `${appUrl()}/api/shopify/oauth/callback` && (authorize.searchParams.get("state")?.length ?? 0) >= 24);
    let row = await prisma.shopifyStore.findUniqueOrThrow({ where: { id: begin.storeId } });
    check("install: store row PENDING_INSTALL with nonce", row.status === "PENDING_INSTALL" && row.oauthState === authorize.searchParams.get("state") && !!row.oauthStateExpiresAt);
    const again = await oauth.beginInstall({ shopDomain: SHOP }, admin.id);
    check("install: restarting reuses the same store row", again.storeId === begin.storeId && again.reconnect === true);
    const bad = await expectError(() => oauth.beginInstall({ shopDomain: "www.example.com" }, admin.id), "INVALID_SHOP");
    check("install: custom domain rejected", bad.hit, bad.code);
    const state = new URL(again.authorizeUrl).searchParams.get("state")!;

    // ---------------------------------------------------------------- callback
    const wrongState = await expectError(() => oauth.completeInstall(signedCallback("not-the-state", `code-${RUN}`), admin.id), "INVALID_STATE");
    check("callback: wrong state rejected", wrongState.hit, wrongState.code);
    const forged = signedCallback(state, `code-${RUN}`);
    forged.set("hmac", "00".repeat(32));
    const badHmac = await expectError(() => oauth.completeInstall(forged, admin.id), "INVALID_HMAC");
    check("callback: bad HMAC rejected", badHmac.hit, badHmac.code);
    const unknownShop = signedCallback(state, `code-${RUN}`);
    unknownShop.set("shop", "someone-else.myshopify.com");
    unknownShop.set("hmac", crypto.hmacSha256Hex(secret, crypto.oauthQueryMessage(unknownShop)));
    const nf = await expectError(() => oauth.completeInstall(unknownShop, admin.id), "NOT_FOUND");
    check("callback: unknown shop rejected", nf.hit, nf.code);

    const done = await oauth.completeInstall(signedCallback(state, `code-${RUN}`), admin.id);
    row = await prisma.shopifyStore.findUniqueOrThrow({ where: { id: begin.storeId } });
    check("callback: store CONNECTED", done.storeId === begin.storeId && row.status === "CONNECTED" && !!row.installedAt && row.oauthState === null);
    check("callback: expiring=1 requested", shopify.tokenCalls[0]?.expiring === "1");
    check("callback: tokens stored encrypted", !!row.encAccessToken && !row.encAccessToken.includes("shpat_") && !!row.encRefreshToken && !row.encRefreshToken.includes("shprt_"));
    check("callback: token decrypts to the issued value", crypto.decryptSecret(row.encAccessToken!, shopifyEnv.SHOPIFY_TOKEN_ENCRYPTION_KEY) === `shpat_${RUN}_1`);
    check("callback: expiries + scopes recorded", !!row.accessTokenExpiresAt && !!row.refreshTokenExpiresAt && row.grantedScopes === shopifyEnv.SHOPIFY_SCOPES);
    const replay = await expectError(() => oauth.completeInstall(signedCallback(state, `code-${RUN}`), admin.id), "INVALID_STATE");
    check("callback: replaying the callback rejected", replay.hit, replay.code);

    // ---------------------------------------------------------------- metadata + token use
    const meta = await api.refreshShopMetadata(begin.storeId);
    row = await prisma.shopifyStore.findUniqueOrThrow({ where: { id: begin.storeId } });
    check("metadata: shop identity stored", meta.shop.name === `E2E Shop ${RUN}` && row.shopName === meta.shop.name && row.currencyCode === "USD" && row.shopGid === "gid://shopify/Shop/1");
    check("metadata: single location auto-selected", row.publishLocationId === "gid://shopify/Location/1001" && row.publishLocationName === "Main warehouse" && row.fulfilLocationId === "gid://shopify/Location/1001");

    const safe = await stores.getStore(begin.storeId);
    check("stores: safe projection has no secrets", !!safe && !("encAccessToken" in safe) && !("encRefreshToken" in safe) && !("oauthState" in safe) && safe.attentionCount === 0);

    await prisma.shopifyStore.update({ where: { id: begin.storeId }, data: { accessTokenExpiresAt: new Date(Date.now() + 60_000) } });
    const callsBefore = shopify.tokenCalls.length;
    const target = await oauth.getAccessToken(begin.storeId);
    row = await prisma.shopifyStore.findUniqueOrThrow({ where: { id: begin.storeId } });
    check("tokens: near-expiry access token refreshed before use", shopify.tokenCalls.length === callsBefore + 1 && shopify.tokenCalls.at(-1)?.grant_type === "refresh_token" && target.accessToken === `shpat_${RUN}_${callsBefore + 1}` && (row.accessTokenExpiresAt?.getTime() ?? 0) > Date.now() + 80_000_000);
    const test = await stores.testConnection(begin.storeId, admin.id);
    check("stores: test connection OK + logged", test.shopName === `E2E Shop ${RUN}` && (await prisma.shopifySyncLog.count({ where: { storeId: begin.storeId, operation: "test_connection", status: "SUCCESS" } })) === 1);

    // ---------------------------------------------------------------- settings
    const W = await warehouses.createWarehouse({ code: `${RUN}-W`, name: "S1 Warehouse", addressLine1: null, addressLine2: null, city: null, state: null, postalCode: null, country: null, notes: null }, admin.id);
    const W2 = await warehouses.createWarehouse({ code: `${RUN}-W2`, name: "S1 Warehouse 2", addressLine1: null, addressLine2: null, city: null, state: null, postalCode: null, country: null, notes: null }, admin.id);
    created.warehouseIds.push(W.id, W2.id);
    const needsLoc = await expectError(() => stores.updateStoreSettings(begin.storeId, { name: "x", ordersImportEnabled: true, importTestOrders: false, ordersImportSince: null, publishEnabled: true, publishLocationId: null, fulfilLocationId: null, warehouseIds: [W.id] }, admin.id), "PUBLISH_REQUIRES_LOCATION");
    check("settings: publishing requires a location", needsLoc.hit, needsLoc.code);
    const badLoc = await expectError(() => stores.updateStoreSettings(begin.storeId, { name: "x", ordersImportEnabled: true, importTestOrders: false, ordersImportSince: null, publishEnabled: false, publishLocationId: "gid://shopify/Location/9999", fulfilLocationId: null, warehouseIds: [] }, admin.id), "INVALID_LOCATION");
    check("settings: unknown Shopify location rejected", badLoc.hit, badLoc.code);
    await stores.updateStoreSettings(begin.storeId, { name: `E2E Store ${RUN} renamed`, ordersImportEnabled: true, importTestOrders: false, ordersImportSince: null, publishEnabled: true, publishLocationId: "gid://shopify/Location/1001", fulfilLocationId: "gid://shopify/Location/1001", warehouseIds: [W2.id, W.id] }, admin.id);
    const s2 = (await stores.getStore(begin.storeId))!;
    check("settings: saved with ordered warehouses", s2.name.endsWith("renamed") && s2.publishEnabled && s2.warehouses.map((w) => w.warehouseId).join(",") === `${W2.id},${W.id}` && s2.warehouses[0].priority === 0);

    // ---------------------------------------------------------------- hooks → outbound jobs
    const A = await owners.createOwner("VENDOR", { code: `${RUN}-A`, businessName: `S1 Vendor ${RUN}`, contactName: null, email: null, phone: null, addressLine1: null, addressLine2: null, city: null, state: null, postalCode: null, country: null, notes: null }, admin.id);
    created.ownerIds.push(A.id);
    const sku = `${RUN}-A1`;
    const pA = await products.createProduct({ ownerId: A.id, name: "S1 Widget", category: null, description: null, notes: null, status: "ACTIVE", variants: [{ sku, name: null, barcode: null, price: "10.00", cost: null, status: "ACTIVE" }] }, admin.id);
    created.productIds.push(pA.id);
    const vA1 = pA.variants[0];
    const main = (await warehouses.getDefaultLocation(W.id))!;
    await prisma.shopifyVariantMapping.create({ data: { storeId: begin.storeId, shopifyProductId: "gid://shopify/Product/1", shopifyVariantId: "gid://shopify/ProductVariant/11", shopifyInventoryItemId: "gid://shopify/InventoryItem/111", shopifySku: sku, variantId: vA1.id, status: "MATCHED", matchedBy: "SKU_EXACT" } });

    await receiving.createReceiving({ ownerId: A.id, warehouseId: W.id, reference: `${RUN}-R1`, notes: null, lines: [{ variantId: vA1.id, locationId: main.id, quantity: 20 }] }, admin.id);
    let publishJobs = await prisma.shopifyOutboundJob.findMany({ where: { storeId: begin.storeId, type: "INVENTORY_PUBLISH" } });
    check("hooks: stock receipt enqueued one INVENTORY_PUBLISH job", publishJobs.length === 1 && publishJobs[0].dedupeKey === `publish:${begin.storeId}:${vA1.id}` && publishJobs[0].status === "PENDING");
    await receiving.createReceiving({ ownerId: A.id, warehouseId: W.id, reference: `${RUN}-R2`, notes: null, lines: [{ variantId: vA1.id, locationId: main.id, quantity: 5 }] }, admin.id);
    publishJobs = await prisma.shopifyOutboundJob.findMany({ where: { storeId: begin.storeId, type: "INVENTORY_PUBLISH" } });
    check("hooks: second receipt does not duplicate the pending job", publishJobs.length === 1);
    await prisma.shopifyOutboundJob.update({ where: { id: publishJobs[0].id }, data: { status: "DONE" } });
    await receiving.createReceiving({ ownerId: A.id, warehouseId: W.id, reference: `${RUN}-R3`, notes: null, lines: [{ variantId: vA1.id, locationId: main.id, quantity: 1 }] }, admin.id);
    publishJobs = await prisma.shopifyOutboundJob.findMany({ where: { storeId: begin.storeId, type: "INVENTORY_PUBLISH" } });
    check("hooks: a DONE publish job is re-armed by the next change", publishJobs.length === 1 && publishJobs[0].status === "PENDING" && publishJobs[0].attempts === 0);
    // Step 4 registered the INVENTORY_PUBLISH runner: the due job is picked up exactly once and leaves PENDING
    // (outcome depends on the mocked Shopify here — Step 4's e2e covers the publish semantics).
    const ranNow = await jobs.runDueJobs({ storeId: begin.storeId });
    check("jobs: due job is picked up by its runner once", ranNow === 1 && (await prisma.shopifyOutboundJob.findUniqueOrThrow({ where: { id: publishJobs[0].id } })).status !== "PENDING");

    const order = await orders.createOrder({ source: "SHOPIFY", shopify: { storeId: begin.storeId, orderId: `9${Date.now()}`, orderName: "#E2E1" }, warehouseId: W.id, reserve: true, shipName: "S1 Buyer", shipAddress1: "1 Test St", shipCity: "Austin", shipCountry: "US", lines: [{ variantId: vA1.id, quantity: 4 }] }, admin.id);
    created.orderIds.add(order.orderId);
    const f1 = await fulfillment.startPicking({ orderId: order.orderId, warehouseId: W.id, lines: [{ orderItemId: (await prisma.orderItem.findFirstOrThrow({ where: { orderId: order.orderId } })).id, quantity: 1 }] }, admin.id);
    const ship1 = await fulfillment.shipFulfillment(f1.id, { carrier: "UPS", trackingNumber: `1Z${RUN}` }, admin.id);
    let fJobs = await prisma.shopifyOutboundJob.findMany({ where: { storeId: begin.storeId, type: "FULFILLMENT_CREATE" } });
    check("hooks: shipping a Shopify order enqueued FULFILLMENT_CREATE", fJobs.length === 1 && fJobs[0].dedupeKey === `fulfillment:${ship1.id}` && fJobs[0].targetId === ship1.id);
    const f2 = await fulfillment.startPicking({ orderId: order.orderId, warehouseId: W.id }, admin.id);
    const ship2 = await fulfillment.shipFulfillment(f2.id, { carrier: "UPS", trackingNumber: `1Z${RUN}B` }, admin.id);
    fJobs = await prisma.shopifyOutboundJob.findMany({ where: { storeId: begin.storeId, type: "FULFILLMENT_CREATE" }, orderBy: { createdAt: "asc" } });
    check("hooks: second shipment = second job (partial fulfilment)", fJobs.length === 2 && fJobs[1].targetId === ship2.id);
    const manual = await orders.createOrder({ source: "MANUAL", warehouseId: W.id, reserve: true, shipName: "Manual Buyer", lines: [{ variantId: vA1.id, quantity: 1 }] }, admin.id);
    created.orderIds.add(manual.orderId);
    const fm = await fulfillment.startPicking({ orderId: manual.orderId, warehouseId: W.id }, admin.id);
    await fulfillment.shipFulfillment(fm.id, { carrier: "UPS" }, admin.id);
    check("hooks: manual orders never enqueue Shopify jobs", (await prisma.shopifyOutboundJob.count({ where: { type: "FULFILLMENT_CREATE" } })) === 2);

    // ---------------------------------------------------------------- webhooks over HTTP
    const whId = `wh-${RUN}-1`;
    let res = await webhookPost("/api/webhooks/shopify", "collections/update", { id: 1, title: "x" }, { webhookId: whId });
    check("webhook: valid delivery → 200", res.status === 200);
    let ev = await waitForEvent(whId, ["IGNORED", "PROCESSED"]);
    check("webhook: recorded and processed (no handler for topic → ignored)", !!ev && ev.storeId === begin.storeId && ev.status === "IGNORED" && ev.topic === "collections/update");
    res = await webhookPost("/api/webhooks/shopify", "collections/update", { id: 1, title: "x" }, { webhookId: whId });
    check("webhook: duplicate webhook id → 200, single row", res.status === 200 && (await prisma.shopifyWebhookEvent.count({ where: { webhookId: whId } })) === 1);
    res = await webhookPost("/api/webhooks/shopify", "collections/update", { id: 2 }, { webhookId: `wh-${RUN}-bad`, secret: "wrong-secret" });
    check("webhook: bad signature → 401, nothing stored", res.status === 401 && (await prisma.shopifyWebhookEvent.count({ where: { webhookId: `wh-${RUN}-bad` } })) === 0);
    res = await fetch(`${base}/api/webhooks/shopify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    check("webhook: missing headers → 400", res.status === 400);
    res = await webhookPost("/api/webhooks/shopify", "orders/create", { id: 3 }, { webhookId: `wh-${RUN}-unknown`, shop: `unknown-${RUN.toLowerCase()}.myshopify.com` });
    ev = await prisma.shopifyWebhookEvent.findUnique({ where: { webhookId: `wh-${RUN}-unknown` } });
    check("webhook: unknown shop (valid signature) → 200, recorded as ignored", res.status === 200 && !!ev && ev.storeId === null && ev.status === "IGNORED");
    row = await prisma.shopifyStore.findUniqueOrThrow({ where: { id: begin.storeId } });
    check("webhook: store lastWebhookAt updated", !!row.lastWebhookAt && row.lastWebhookAt.getTime() > Date.now() - 60_000);

    const compId = `wh-${RUN}-comp`;
    res = await webhookPost("/api/webhooks/shopify/compliance", "customers/redact", { shop_domain: SHOP, customer: { id: 42, email: "x@example.com" } }, { webhookId: compId });
    ev = await waitForEvent(compId, ["PROCESSED", "FAILED"]);
    check("compliance: customers/redact acknowledged + flagged for attention", res.status === 200 && ev?.status === "PROCESSED" && (await prisma.shopifySyncLog.count({ where: { storeId: begin.storeId, operation: "customers/redact", status: "NEEDS_ATTENTION" } })) === 1);
    res = await webhookPost("/api/webhooks/shopify/compliance", "shop/redact", { shop_domain: SHOP }, { webhookId: `wh-${RUN}-comp2`, secret: "wrong" });
    check("compliance: invalid HMAC → 401 (Shopify requirement)", res.status === 401);

    // retry path: simulate a failed event and retry it
    const failedEv = await prisma.shopifyWebhookEvent.create({ data: { storeId: begin.storeId, shopDomain: SHOP, webhookId: `wh-${RUN}-failed`, topic: "app/uninstalled", status: "FAILED", attempts: 1, nextRetryAt: new Date(Date.now() - 1000), payload: {} } });
    const stale = await prisma.shopifyWebhookEvent.create({ data: { storeId: begin.storeId, shopDomain: SHOP, webhookId: `wh-${RUN}-stale`, topic: "collections/update", status: "PROCESSING", lockedAt: new Date(Date.now() - 20 * 60_000), attempts: 1, payload: {} } });
    check("webhook: backoff grows and caps", webhooks.computeBackoff(1, 0).getTime() === 4 * 60_000 && webhooks.computeBackoff(3, 0).getTime() === 16 * 60_000 && webhooks.computeBackoff(20, 0).getTime() === 360 * 60_000);
    // The built server's webhook drain (after()) now really executes this store's jobs, so wait until none is
    // RUNNING and snapshot what is still parkable (PENDING / FAILED) right before the uninstall is processed.
    for (let i = 0; i < 30 && (await prisma.shopifyOutboundJob.count({ where: { storeId: begin.storeId, status: "RUNNING" } })) > 0; i++) await sleep(1000);
    const parkable = await prisma.shopifyOutboundJob.count({ where: { storeId: begin.storeId, status: { in: ["PENDING", "FAILED"] } } });
    const retried = await webhooks.retryDueWebhookEvents({ storeId: begin.storeId });
    const staleAfter = await prisma.shopifyWebhookEvent.findUniqueOrThrow({ where: { id: stale.id } });
    check("webhook: retry sweep recovers stale locks and processes due events", retried >= 2 && staleAfter.status === "IGNORED");
    row = await prisma.shopifyStore.findUniqueOrThrow({ where: { id: begin.storeId } });
    check("app/uninstalled: store UNINSTALLED, tokens erased, publish off", row.status === "UNINSTALLED" && row.encAccessToken === null && row.encRefreshToken === null && !row.publishEnabled && !!row.uninstalledAt);
    check("app/uninstalled: every pending/failed job parked for attention (none left pending) + logged", parkable >= 1 && (await prisma.shopifyOutboundJob.count({ where: { storeId: begin.storeId, status: "NEEDS_ATTENTION", lastError: "App uninstalled in Shopify" } })) === parkable && (await prisma.shopifyOutboundJob.count({ where: { storeId: begin.storeId, status: { in: ["PENDING", "FAILED", "RUNNING"] } } })) === 0 && (await prisma.shopifySyncLog.count({ where: { storeId: begin.storeId, operation: "app/uninstalled", status: "NEEDS_ATTENTION" } })) === 1, `parkable ${parkable}`);
    check("app/uninstalled: replay is a no-op", (await webhooks.processWebhookEvent(failedEv.id)) === null);
    const nc = await expectError(() => oauth.getAccessToken(begin.storeId), "NOT_CONNECTED");
    check("tokens: uninstalled store cannot be used", nc.hit, nc.code);

    // reconnect after uninstall reuses the row
    const re = await oauth.beginInstall({ shopDomain: SHOP }, admin.id);
    await oauth.completeInstall(signedCallback(new URL(re.authorizeUrl).searchParams.get("state")!, `code-${RUN}`), admin.id);
    row = await prisma.shopifyStore.findUniqueOrThrow({ where: { id: begin.storeId } });
    check("reconnect: same row back to CONNECTED", re.storeId === begin.storeId && row.status === "CONNECTED" && row.uninstalledAt === null);

    // disconnect
    await stores.disconnectStore(begin.storeId, admin.id);
    row = await prisma.shopifyStore.findUniqueOrThrow({ where: { id: begin.storeId } });
    check("disconnect: tokens erased, status DISCONNECTED", row.status === "DISCONNECTED" && row.encAccessToken === null);
    const rp = await expectError(() => stores.removePendingStore(begin.storeId, admin.id), "HAS_HISTORY");
    check("remove: a store with history cannot be removed", rp.hit, rp.code);
    const attention = await syncLog.attentionCountsByStore();
    check("sync log: attention count visible for the store", (attention.get(begin.storeId) ?? 0) >= 2);

    // ---------------------------------------------------------------- HTTP: admin pages + cron
    const { firebaseAdminAuth } = await import("../src/lib/firebase/admin");
    const custom = await firebaseAdminAuth().createCustomToken(admin.firebaseUid);
    const signIn = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${process.env.NEXT_PUBLIC_FIREBASE_API_KEY}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: custom, returnSecureToken: true }) });
    const { idToken } = (await signIn.json()) as { idToken: string };
    const sess = await fetch(`${base}/api/auth/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken, audience: "staff" }) });
    const cookie = (sess.headers.get("set-cookie") ?? "").split(";")[0];
    const get = (path: string, c?: string) => fetch(`${base}${path}`, { redirect: "manual", headers: c ? { Cookie: c } : {} });
    res = await get("/admin/settings", cookie);
    check("pages: /admin/settings renders for admin", res.status === 200 && (await res.text()).includes("Shopify Stores"));
    res = await get("/admin/settings/shopify", cookie);
    check("pages: store list renders the store", res.status === 200 && (await res.text()).includes(`E2E Store ${RUN}`));
    res = await get(`/admin/settings/shopify/${begin.storeId}?tab=log`, cookie);
    const logHtml = await res.text();
    check("pages: store detail sync log renders, no secrets leaked", res.status === 200 && logHtml.includes("Store disconnected") && !logHtml.includes("shpat_") && !logHtml.includes("shprt_"));
    res = await get(`/admin/settings/shopify/${begin.storeId}?tab=webhooks`, cookie);
    check("pages: webhooks tab renders events", res.status === 200 && (await res.text()).includes("collections/update"));
    res = await get(`/admin/settings/shopify/${begin.storeId}?tab=jobs`, cookie);
    check("pages: jobs tab renders", res.status === 200 && (await res.text()).includes("fulfillment create"));
    res = await get("/admin/settings/shopify");
    check("pages: unauthenticated redirected to login", res.status >= 300 && res.status < 400 && (res.headers.get("location") ?? "").includes("/admin/login"));
    res = await get(`/api/shopify/oauth/callback?shop=${SHOP}&code=x&state=y&hmac=z`);
    check("callback route: unauthenticated → login redirect", res.status >= 300 && res.status < 400 && (res.headers.get("location") ?? "").includes("/admin/login"));
    res = await get(`/api/shopify/oauth/callback?shop=${SHOP}&code=x&state=y&hmac=z`, cookie);
    check("callback route: invalid response → back to stores with error", res.status >= 300 && res.status < 400 && (res.headers.get("location") ?? "").includes("/admin/settings/shopify?error=INVALID_HMAC"));
    await fetch(`${base}/api/auth/session`, { method: "DELETE", headers: { Cookie: cookie } });

    res = await get("/api/cron/shopify-daily");
    check("cron: rejected without secret", res.status === 401);
    if (process.env.CRON_SECRET && process.env.CRON_SECRET.length >= 16) {
      res = await fetch(`${base}/api/cron/shopify-daily`, { headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` } });
      const summary = (await res.json()) as { tokens?: unknown; timedOut?: boolean };
      check("cron: daily maintenance runs with secret", res.status === 200 && "tokens" in summary && summary.timedOut === false);
    } else {
      check("cron: daily maintenance runs with secret (skipped — CRON_SECRET not set locally)", true);
    }
  } finally {
    client.__setShopifyFetchForTests(null);
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
    await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: [...created.ownerIds, ...created.productIds, ...created.warehouseIds, ...created.storeIds, ...orderIds] } }, { entityType: { in: ["ReceivingRecord", "Location", "Shipment", "ShopifyStore"] }, createdAt: { gte: new Date(Date.now() - 30 * 60 * 1000) } }] } }).catch(() => undefined);
    await prisma.owner.deleteMany({ where: { id: { in: created.ownerIds } } });
    await prisma.$disconnect();
    console.log(`Cleanup done (${orderIds.length} orders, ${created.storeIds.length} store removed).`);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
