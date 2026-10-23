/**
 * Shopify Step 2 end-to-end check: catalog sync + variant mapping against a running server and
 * database, with Shopify simulated in-process. Covers paged and bulk pulls, exact-SKU matching
 * (normalisation, conflicts, archived), idempotent re-sync, manual map + uniqueness guard,
 * ignore stickiness, SKU change, prune of vanished variants, unmatched CSV, products/update
 * webhook (HTTP + retry), preview/confirm import through the core product service, the daily
 * maintenance hook, and the Admin pages/route. Removes everything it creates.
 *
 * Usage: npm run e2e:shopify2 -- http://localhost:3100 vendor3pl@gmail.com
 */
import { createHmac, randomBytes } from "node:crypto";
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });
loadEnv();

const [base = "http://localhost:3100", adminEmail = "vendor3pl@gmail.com"] = process.argv.slice(2);
const RUN = `S2${Date.now().toString(36)}`.toUpperCase();
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

type Node = { id: string; sku: string | null; title: string | null; barcode: string | null; price: string | null; updatedAt: string; inventoryItem: { id: string; tracked: boolean } | null; product: { id: string; title: string; status: string }; inventoryQuantity?: number | null };

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  await import("../src/server/services/shopify/register");
  const shopifyEnv = (await import("../src/server/services/shopify/env")).shopifyEnv();
  const client = await import("../src/server/services/shopify/client");
  const crypto = await import("../src/server/services/shopify/crypto");
  const oauth = await import("../src/server/services/shopify/oauth");
  const catalog = await import("../src/server/services/shopify/catalog");
  const mapping = await import("../src/server/services/shopify/mapping");
  const importer = await import("../src/server/services/shopify/catalog-import");
  const webhooks = await import("../src/server/services/shopify/webhooks");
  const maintenance = await import("../src/server/services/shopify/maintenance");
  const owners = await import("../src/server/services/owners");
  const products = await import("../src/server/services/products");

  const admin = await prisma.user.findFirstOrThrow({ where: { email: adminEmail, role: "ADMIN" } });
  const created = { ownerIds: [] as string[], productIds: [] as string[], storeIds: [] as string[], warehouseIds: [] as string[] };
  const secret = shopifyEnv.SHOPIFY_API_SECRET;

  // ---------------------------------------------------------------- simulated Shopify (catalog is mutable)
  const P = (n: number) => `gid://shopify/Product/${n}`;
  const V = (n: number) => `gid://shopify/ProductVariant/${n}`;
  const node = (v: number, p: number, title: string, sku: string | null, vtitle: string | null = null, extra: Partial<Node> = {}): Node => ({ id: V(v), sku, title: vtitle ?? "Default Title", barcode: extra.barcode ?? null, price: extra.price ?? "10.00", updatedAt: new Date().toISOString(), inventoryItem: { id: `gid://shopify/InventoryItem/${v}`, tracked: true }, product: { id: P(p), title, status: "ACTIVE" } });
  let shopifyCatalog: Node[] = [
    node(1, 1, "Widget", `${RUN}-A1`, "Red"),
    node(2, 1, "Widget", ` ${RUN.toLowerCase()}-a2 `, "Blue"),
    node(3, 2, "Dup One", `${RUN}-DUP`),
    node(4, 3, "Dup Two", `${RUN.toLowerCase()}-dup`),
    node(5, 4, "No Sku Product", ""),
    node(6, 5, "Archived Twin", `${RUN}-ARCH`),
    node(7, 6, "Orphan Prod", `${RUN}-ORPHAN`),
    node(8, 7, "New Prod", `${RUN}-NEWP-1`, "Small", { barcode: "111", price: "12.50" }),
    node(9, 7, "New Prod", `${RUN}-NEWP-2`, "Large", { barcode: "222", price: "13.00" }),
  ];
  const calls = { paged: 0, bulkRun: 0, bulkStatus: 0, bulkDownload: 0, productQuery: 0 };
  const validTokens = new Set<string>();
  let tokenN = 0;
  const PAGE = 3;
  client.__setShopifyFetchForTests(async (input, init) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (url === `https://${SHOP}/admin/oauth/access_token`) {
      tokenN++;
      const token = `shpat_${RUN}_${tokenN}`;
      validTokens.add(token);
      return Response.json({ access_token: token, scope: shopifyEnv.SHOPIFY_SCOPES, expires_in: 86399, refresh_token: `shprt_${RUN}_${tokenN}`, refresh_token_expires_in: 7_776_000 });
    }
    if (url === `https://bulk.e2e.test/${RUN}.jsonl`) {
      calls.bulkDownload++;
      return new Response(shopifyCatalog.map((n) => JSON.stringify(n)).join("\n") + "\n", { status: 200 });
    }
    if (url === `https://${SHOP}/admin/api/${shopifyEnv.SHOPIFY_API_VERSION}/graphql.json`) {
      if (!validTokens.has(headers["X-Shopify-Access-Token"])) return new Response("{}", { status: 401 });
      const body = JSON.parse(String(init?.body)) as { query: string; variables?: Record<string, unknown> };
      const q = body.query;
      if (q.includes("shop {")) return Response.json({ data: { shop: { id: "gid://shopify/Shop/2", name: `E2E Shop ${RUN}`, myshopifyDomain: SHOP, currencyCode: "USD", ianaTimezone: "UTC", plan: null } } });
      if (q.includes("locations(")) return Response.json({ data: { locations: { nodes: [{ id: "gid://shopify/Location/1", name: "Main", isActive: true, fulfillsOnlineOrders: true, shipsInventory: true, address: null }], pageInfo: { hasNextPage: false, endCursor: null } } } });
      if (q.includes("productVariantsCount")) return Response.json({ data: { productVariantsCount: { count: shopifyCatalog.length } } });
      if (q.includes("productVariants(first")) {
        calls.paged++;
        const start = Number(body.variables?.after ?? 0);
        const slice = shopifyCatalog.slice(start, start + PAGE);
        const end = start + slice.length;
        return Response.json({ data: { productVariants: { nodes: slice, pageInfo: { hasNextPage: end < shopifyCatalog.length, endCursor: String(end) } } } });
      }
      if (q.includes("product(id:")) {
        calls.productQuery++;
        const pid = String(body.variables?.id);
        const vs = shopifyCatalog.filter((n) => n.product.id === pid);
        if (vs.length === 0) return Response.json({ data: { product: null } });
        return Response.json({ data: { product: { id: pid, title: vs[0].product.title, status: "ACTIVE", variants: { nodes: vs } } } });
      }
      if (q.includes("bulkOperationRunQuery")) {
        calls.bulkRun++;
        return Response.json({ data: { bulkOperationRunQuery: { bulkOperation: { id: `gid://shopify/BulkOperation/${RUN}`, status: "CREATED" }, userErrors: [] } } });
      }
      if (q.includes("... on BulkOperation")) {
        calls.bulkStatus++;
        const done = calls.bulkStatus >= 2;
        return Response.json({ data: { node: { id: `gid://shopify/BulkOperation/${RUN}`, status: done ? "COMPLETED" : "RUNNING", errorCode: null, objectCount: String(shopifyCatalog.length), url: done ? `https://bulk.e2e.test/${RUN}.jsonl` : null } } });
      }
      return Response.json({ errors: [{ message: `unexpected query in e2e: ${q.slice(0, 60)}` }] });
    }
    return new Response("not found", { status: 404 });
  });

  const webhookPost = (topic: string, payload: unknown, webhookId: string) => {
    const body = JSON.stringify(payload);
    return fetch(`${base}/api/webhooks/shopify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Topic": topic, "X-Shopify-Shop-Domain": SHOP, "X-Shopify-Webhook-Id": webhookId, "X-Shopify-Event-Id": `ev-${webhookId}`, "X-Shopify-API-Version": shopifyEnv.SHOPIFY_API_VERSION, "X-Shopify-Triggered-At": new Date().toISOString(), "X-Shopify-Hmac-Sha256": createHmac("sha256", secret).update(body).digest("base64") },
      body,
    });
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
  const mappingBy = async (storeId: string, v: number) => prisma.shopifyVariantMapping.findUnique({ where: { storeId_shopifyVariantId: { storeId, shopifyVariantId: V(v) } }, include: { variant: { select: { sku: true } } } });

  try {
    // ---------------------------------------------------------------- V3PL catalogue
    const A = await owners.createOwner("VENDOR", { code: `${RUN}-A`, businessName: `S2 Vendor A ${RUN}`, contactName: null, email: null, phone: null, addressLine1: null, addressLine2: null, city: null, state: null, postalCode: null, country: null, notes: null }, admin.id);
    const B = await owners.createOwner("THREEPL_CLIENT", { code: `${RUN}-B`, businessName: `S2 Client B ${RUN}`, contactName: null, email: null, phone: null, addressLine1: null, addressLine2: null, city: null, state: null, postalCode: null, country: null, notes: null }, admin.id);
    created.ownerIds.push(A.id, B.id);
    const vin = (sku: string, status: "ACTIVE" | "ARCHIVED" = "ACTIVE") => ({ sku, name: null, barcode: null, price: "9.00", cost: null, status });
    const pA = await products.createProduct({ ownerId: A.id, name: "S2 Widget", category: null, description: null, notes: null, status: "ACTIVE", variants: [vin(`${RUN}-A1`), vin(`${RUN}-A2`)] }, admin.id);
    const pArch = await products.createProduct({ ownerId: A.id, name: "S2 Archived", category: null, description: null, notes: null, status: "ACTIVE", variants: [vin(`${RUN}-ARCH`, "ARCHIVED"), vin(`${RUN}-ARCH-KEEP`)] }, admin.id);
    const pB = await products.createProduct({ ownerId: B.id, name: "S2 Manual Target", category: null, description: null, notes: null, status: "ACTIVE", variants: [vin(`${RUN}-B1`)] }, admin.id);
    created.productIds.push(pA.id, pArch.id, pB.id);
    const iA1 = pA.variants.find((v) => v.sku === `${RUN}-A1`)!;
    const iA2 = pA.variants.find((v) => v.sku === `${RUN}-A2`)!;
    const iB1 = pB.variants[0];

    // ---------------------------------------------------------------- store (connected via simulated OAuth)
    const begin = await oauth.beginInstall({ shopDomain: SHOP, name: `E2E S2 ${RUN}` }, admin.id);
    created.storeIds.push(begin.storeId);
    const state = new URL(begin.authorizeUrl).searchParams.get("state")!;
    const p = new URLSearchParams({ code: "c", shop: SHOP, state, timestamp: String(Math.floor(Date.now() / 1000)) });
    p.set("hmac", crypto.hmacSha256Hex(secret, crypto.oauthQueryMessage(p)));
    await oauth.completeInstall(p, admin.id);
    const storeId = begin.storeId;

    // ---------------------------------------------------------------- first sync (paged, 3 pages)
    const s1 = await catalog.syncCatalog(storeId, { mode: "auto", actorId: admin.id });
    check("sync: auto mode chose paged below threshold and paginated", s1.mode === "paged" && calls.paged === 3 && s1.seen === 9 && s1.full);
    check("sync: 9 rows created", s1.created === 9 && s1.summary.MATCHED === 2 && s1.summary.CONFLICT === 2 && s1.summary.UNMATCHED === 5 && s1.summary.IGNORED === 0);
    let m1 = (await mappingBy(storeId, 1))!;
    const m2 = (await mappingBy(storeId, 2))!;
    check("match: exact SKU → MATCHED SKU_EXACT with internal variant", m1.status === "MATCHED" && m1.matchedBy === "SKU_EXACT" && m1.variantId === iA1.id && m1.shopifyInventoryItemId === "gid://shopify/InventoryItem/1");
    check("match: lower-case/padded SKU matched by normalisation", m2.status === "MATCHED" && m2.variantId === iA2.id && m2.shopifySku === ` ${RUN.toLowerCase()}-a2 `);
    check("match: duplicate Shopify SKUs → CONFLICT", (await mappingBy(storeId, 3))!.status === "CONFLICT" && (await mappingBy(storeId, 4))!.status === "CONFLICT");
    check("match: no SKU / archived / orphan → UNMATCHED, no variant", (await mappingBy(storeId, 5))!.status === "UNMATCHED" && (await mappingBy(storeId, 6))!.status === "UNMATCHED" && (await mappingBy(storeId, 6))!.variantId === null && (await mappingBy(storeId, 7))!.status === "UNMATCHED");
    check("sync: snapshots carry titles (display only)", m1.shopifyProductTitle === "Widget" && m1.shopifyVariantTitle === "Red" && (await mappingBy(storeId, 5))!.shopifyVariantTitle === null);
    check("sync: nothing created in V3PL by a sync", (await prisma.product.count({ where: { ownerId: { in: created.ownerIds } } })) === 3);
    check("sync: store lastCatalogSyncAt + log row", !!(await prisma.shopifyStore.findUniqueOrThrow({ where: { id: storeId } })).lastCatalogSyncAt && (await prisma.shopifySyncLog.count({ where: { storeId, operation: "catalog_sync", status: "SUCCESS" } })) === 1);

    // ---------------------------------------------------------------- idempotent re-sync
    const s2 = await catalog.syncCatalog(storeId, { mode: "paged" });
    const m1b = (await mappingBy(storeId, 1))!;
    check("sync: re-run is idempotent (0 created, 9 updated, same states, same variant)", s2.created === 0 && s2.updated === 9 && s2.summary.MATCHED === 2 && m1b.variantId === iA1.id && m1b.updatedAt.getTime() >= m1.updatedAt.getTime());

    // ---------------------------------------------------------------- manual mapping + guard
    const m7 = (await mappingBy(storeId, 7))!;
    await mapping.mapManually(storeId, m7.id, iB1.id, admin.id);
    check("manual: ORPHAN mapped to B1 as MANUAL", (await mappingBy(storeId, 7))!.matchedBy === "MANUAL" && (await mappingBy(storeId, 7))!.variantId === iB1.id);
    const m5 = (await mappingBy(storeId, 5))!;
    const dupMap = await expectError(() => mapping.mapManually(storeId, m5.id, iB1.id, admin.id), "ALREADY_MAPPED");
    check("manual: internal SKU cannot be mapped twice in one store (service)", dupMap.hit, dupMap.code);
    let dbGuard = false;
    try {
      await prisma.shopifyVariantMapping.update({ where: { id: m5.id }, data: { variantId: iB1.id } });
    } catch (e) {
      dbGuard = (e as { code?: string }).code === "P2002";
    }
    check("manual: database unique (storeId, variantId) blocks a raw duplicate", dbGuard);
    const archived = await expectError(() => mapping.mapManually(storeId, m5.id, pArch.variants.find((v) => v.sku === `${RUN}-ARCH`)!.id, admin.id), "VARIANT_INVALID");
    check("manual: archived internal SKU refused", archived.hit, archived.code);
    await catalog.syncCatalog(storeId, { mode: "paged" });
    check("sync: manual mapping preserved across sync", (await mappingBy(storeId, 7))!.matchedBy === "MANUAL" && (await mappingBy(storeId, 7))!.variantId === iB1.id);

    // manual conflict: a Shopify variant whose SKU equals a manually-mapped internal SKU
    shopifyCatalog.push(node(11, 8, "Manual Twin", `${RUN}-B1`));
    await catalog.syncCatalog(storeId, { mode: "paged" });
    check("match: SKU already manually mapped elsewhere → CONFLICT", (await mappingBy(storeId, 11))!.status === "CONFLICT");

    // ---------------------------------------------------------------- ignore stickiness
    await mapping.setIgnored(storeId, m5.id, true, admin.id);
    await catalog.syncCatalog(storeId, { mode: "paged" });
    check("ignore: stays IGNORED while SKU unchanged", (await mappingBy(storeId, 5))!.status === "IGNORED");
    shopifyCatalog = shopifyCatalog.map((n) => (n.id === V(5) ? { ...n, sku: `${RUN}-NOWSKU` } : n));
    await catalog.syncCatalog(storeId, { mode: "paged" });
    check("ignore: released to UNMATCHED when the Shopify SKU changes", (await mappingBy(storeId, 5))!.status === "UNMATCHED" && (await mappingBy(storeId, 5))!.shopifySku === `${RUN}-NOWSKU`);
    const ignBad = await expectError(() => mapping.setIgnored(storeId, m1.id, true, admin.id), "BAD_STATUS");
    check("ignore: a matched variant must be unmapped first", ignBad.hit, ignBad.code);

    // ---------------------------------------------------------------- conflict resolution + SKU change on a matched row
    shopifyCatalog = shopifyCatalog.map((n) => (n.id === V(4) ? { ...n, sku: `${RUN}-OTHER` } : n));
    await catalog.syncCatalog(storeId, { mode: "paged" });
    check("conflict: resolves once the duplicate SKU is changed in Shopify", (await mappingBy(storeId, 3))!.status === "UNMATCHED" && (await mappingBy(storeId, 4))!.status === "UNMATCHED");
    shopifyCatalog = shopifyCatalog.map((n) => (n.id === V(2) ? { ...n, sku: `${RUN}-RENAMED` } : n));
    await catalog.syncCatalog(storeId, { mode: "paged" });
    check("match: SKU_EXACT mapping dropped when the Shopify SKU no longer matches", (await mappingBy(storeId, 2))!.status === "UNMATCHED" && (await mappingBy(storeId, 2))!.variantId === null);

    // ---------------------------------------------------------------- unmatched CSV
    const csv = await mapping.unmatchedCsv(storeId);
    const csvHead = csv.replace(/^\uFEFF/, "").split(/\r?\n/)[0].replace(/"/g, "");
    check("csv: lists unmatched + conflicts with normalised SKUs, not matched ones", csv.includes(`${RUN}-NOWSKU`) && csv.includes(`${RUN}-OTHER`) && csv.includes(`${RUN}-B1`) && !csv.includes(`${RUN}-A1`) && csvHead.startsWith("Shopify Product,Shopify Variant,Shopify SKU,Normalized SKU,Status"), `head=${csvHead.slice(0, 80)}`);

    // ---------------------------------------------------------------- prune vanished variants
    m1 = (await mappingBy(storeId, 1))!;
    shopifyCatalog = shopifyCatalog.filter((n) => ![V(1), V(3), V(7)].includes(n.id));
    const s3 = await catalog.syncCatalog(storeId, { mode: "paged" });
    check("prune: vanished unmatched row deleted", (await mappingBy(storeId, 3)) === null);
    check("prune: vanished SKU_EXACT row deleted + attention logged", (await mappingBy(storeId, 1)) === null && (await prisma.shopifySyncLog.count({ where: { storeId, status: "NEEDS_ATTENTION", message: { contains: `${RUN}-A1` } } })) === 1);
    check("prune: vanished MANUAL row kept and flagged once", (await mappingBy(storeId, 7)) !== null && s3.flagged === 2 && (await prisma.shopifySyncLog.count({ where: { storeId, status: "NEEDS_ATTENTION", message: { contains: `${RUN}-B1` } } })) === 1);
    const s4 = await catalog.syncCatalog(storeId, { mode: "paged" });
    check("prune: manual row not flagged again on the next sync", s4.flagged === 0 && (await prisma.shopifySyncLog.count({ where: { storeId, status: "NEEDS_ATTENTION", message: { contains: `${RUN}-B1` } } })) === 1);
    shopifyCatalog.push(node(1, 1, "Widget", `${RUN}-A1`, "Red"));
    await catalog.syncCatalog(storeId, { mode: "paged" });
    check("prune: returning variant re-matched automatically", (await mappingBy(storeId, 1))?.variantId === iA1.id);
    m1 = (await mappingBy(storeId, 1))!; // new row after the prune

    // ---------------------------------------------------------------- bulk path
    const before = calls.bulkRun;
    const sb = await catalog.syncCatalog(storeId, { mode: "bulk" });
    check("bulk: run → poll → download JSONL → same result", sb.mode === "bulk" && calls.bulkRun === before + 1 && calls.bulkDownload === 1 && sb.seen === shopifyCatalog.length && sb.full);

    // ---------------------------------------------------------------- products/update webhook (HTTP → server FAILED on fake shop → in-process retry PROCESSED)
    shopifyCatalog.push(node(12, 7, "New Prod", `${RUN}-A2`, "Medium"));
    const whId = `wh-${RUN}-pu`;
    const res = await webhookPost("products/update", { id: 7, admin_graphql_api_id: P(7), title: "New Prod" }, whId);
    check("webhook: products/update accepted (200)", res.status === 200);
    const evFailed = await waitForEvent(whId, ["FAILED", "PROCESSED"]);
    check("webhook: server attempted processing (fake shop unreachable → FAILED with retry scheduled)", evFailed?.status === "FAILED" && evFailed.attempts === 1 && !!evFailed.nextRetryAt);
    const retried = await webhooks.retryWebhookEventNow(evFailed!.id);
    const m12 = await mappingBy(storeId, 12);
    check("webhook: retry processes via handler → PROCESSED, new variant mapped by SKU", retried === "PROCESSED" && m12?.status === "MATCHED" && m12.variantId === iA2.id && (await prisma.shopifySyncLog.count({ where: { storeId, operation: "products/update", status: "SUCCESS" } })) === 1);
    shopifyCatalog = shopifyCatalog.filter((n) => n.id !== V(12));
    const wh2 = `wh-${RUN}-pu2`;
    await webhookPost("products/update", { id: 7, admin_graphql_api_id: P(7) }, wh2);
    const ev2 = await waitForEvent(wh2, ["FAILED", "PROCESSED"]);
    await webhooks.retryWebhookEventNow(ev2!.id);
    check("webhook: variant removed from product → its automatic mapping removed", (await mappingBy(storeId, 12)) === null);
    const wh3 = `wh-${RUN}-pu3`;
    await webhookPost("products/update", { id: 999, admin_graphql_api_id: P(999) }, wh3);
    const ev3 = await waitForEvent(wh3, ["FAILED", "PROCESSED"]);
    check("webhook: deleted product handled without error", (await webhooks.retryWebhookEventNow(ev3!.id)) === "PROCESSED");

    // ---------------------------------------------------------------- import preview / confirm (explicit owner)
    const m8 = (await mappingBy(storeId, 8))!;
    const m9 = (await mappingBy(storeId, 9))!;
    const m6 = (await mappingBy(storeId, 6))!;
    const pv = await importer.previewImport(storeId, [m8.id, m9.id, m6.id, m1.id], A.id);
    const newProd = pv.products.find((x) => x.shopifyProductId === P(7))!;
    const archProd = pv.products.find((x) => x.shopifyProductId === P(5))!;
    check("import preview: grouped per Shopify product, live barcode/price, owner label", newProd.ok && newProd.variants.length === 2 && newProd.variants[0].barcode === "111" && newProd.variants[0].price === "12.50" && newProd.variants[0].name === "Small" && newProd.ownerLabel.includes(`S2 Vendor A ${RUN}`));
    check("import preview: SKU owned by an archived V3PL variant is rejected", !archProd.ok && /already belongs/.test(archProd.variants[0].error ?? ""));
    check("import preview: already-matched selection skipped", pv.skipped.some((s) => s.mappingId === m1.id && /Already mapped/.test(s.reason)));
    const pvOverride = await importer.previewImport(storeId, [m8.id], A.id, { [P(7)]: B.id });
    check("import preview: per-product owner override applied", pvOverride.products[0].ownerId === B.id && pvOverride.products[0].ownerLabel.includes(`S2 Client B ${RUN}`));
    const badOwner = await importer.previewImport(storeId, [m8.id], "nope");
    check("import preview: unknown owner blocks the product", !badOwner.products[0].ok && /not an active/.test(badOwner.products[0].errors[0] ?? ""));

    const done = await importer.confirmImport(storeId, [{ shopifyProductId: P(7), ownerId: B.id, mappingIds: [m8.id, m9.id] }, { shopifyProductId: P(5), ownerId: A.id, mappingIds: [m6.id] }], admin.id);
    const createdProduct = done.created[0] ? await prisma.product.findUnique({ where: { id: done.created[0].productId }, include: { variants: true } }) : null;
    if (createdProduct) created.productIds.push(createdProduct.id);
    check("import confirm: product created through core service for the chosen owner", done.created.length === 1 && !!createdProduct && createdProduct.ownerId === B.id && createdProduct.name === "New Prod" && createdProduct.variants.length === 2 && createdProduct.variants.some((v) => v.sku === `${RUN}-NEWP-1` && v.barcode === "111" && String(v.price) === "12.5"));
    check("import confirm: failing product reported, nothing created for it", done.failed.length === 1 && done.failed[0].shopifyProductId === P(5), JSON.stringify(done.failed));
    check("import confirm: mappings now MATCHED to the new variants", (await mappingBy(storeId, 8))!.status === "MATCHED" && (await mappingBy(storeId, 8))!.variant?.sku === `${RUN}-NEWP-1` && (await mappingBy(storeId, 9))!.status === "MATCHED");
    check("import confirm: audit + sync log", (await prisma.shopifySyncLog.count({ where: { storeId, operation: "import", status: "SUCCESS" } })) === 1 && (await prisma.auditLog.count({ where: { entityType: "Product", entityId: createdProduct?.id, action: "product.created" } })) === 1);
    const again = await importer.previewImport(storeId, [m8.id], A.id);
    check("import: re-importing the same variant is impossible (already mapped)", again.products.length === 0 && again.skipped.length === 1);
    check("import: inventory untouched", (await prisma.inventoryTransaction.count({ where: { variant: { productId: { in: created.productIds } } } })) === 0);

    // ---------------------------------------------------------------- import with a V3PL stock destination (D-067)
    const warehouses = await import("../src/server/services/warehouses");
    shopifyCatalog.push({ ...node(20, 20, "Stock Prod", `${RUN}-STK-1`, "One"), inventoryQuantity: 7 }, { ...node(21, 20, "Stock Prod", `${RUN}-STK-2`, "Two"), inventoryQuantity: 0 }, { ...node(22, 21, "Stock Solo", `${RUN}-STK-3`), inventoryQuantity: 3 });
    await catalog.syncCatalog(storeId, { mode: "paged" });
    const whInput = { addressLine1: null, addressLine2: null, city: null, state: null, postalCode: null, country: null, notes: null };
    const W1 = await warehouses.createWarehouse({ code: `${RUN}-W1`, name: "S2 Warehouse 1", ...whInput }, admin.id);
    const W2 = await warehouses.createWarehouse({ code: `${RUN}-W2`, name: "S2 Warehouse 2", ...whInput }, admin.id);
    created.warehouseIds.push(W1.id, W2.id);
    const L1 = (await warehouses.getDefaultLocation(W1.id))!;
    const L2 = (await warehouses.getDefaultLocation(W2.id))!;
    const mA = (await mappingBy(storeId, 20))!;
    const mB = (await mappingBy(storeId, 21))!;
    const mC = (await mappingBy(storeId, 22))!;
    const pvS = await importer.previewImport(storeId, [mA.id, mB.id, mC.id], A.id);
    const stockProd = pvS.products.find((x) => x.shopifyProductId === P(20))!;
    check("import preview: Shopify's sellable quantity is shown per variant as a reference only (7 / 0) — the preview books nothing", stockProd.ok && stockProd.variants.find((v) => v.sku === `${RUN}-STK-1`)?.shopifyQuantity === 7 && stockProd.variants.find((v) => v.sku === `${RUN}-STK-2`)?.shopifyQuantity === 0 && (await prisma.productVariant.count({ where: { sku: { startsWith: `${RUN}-STK` } } })) === 0);
    const noDest = await importer.confirmImport(storeId, [{ shopifyProductId: P(21), ownerId: A.id, mappingIds: [mC.id], quantities: { [mC.id]: 3 } }], admin.id, null);
    check("import confirm: an initial quantity without a V3PL destination is refused — nothing created, mapping still UNMATCHED, no stock anywhere", noDest.failed.length === 1 && /warehouse and location/i.test(noDest.failed[0].error) && noDest.created.length === 0 && noDest.destination === null && (await mappingBy(storeId, 22))!.status === "UNMATCHED");
    const badDest = await importer.confirmImport(storeId, [{ shopifyProductId: P(21), ownerId: A.id, mappingIds: [mC.id], quantities: { [mC.id]: 3 } }], admin.id, { warehouseId: W1.id, locationId: L2.id });
    check("import confirm: a location that belongs to another warehouse is refused before anything is created", badDest.failed.length === 1 && /inside warehouse/.test(badDest.failed[0].error) && (await prisma.productVariant.count({ where: { sku: `${RUN}-STK-3` } })) === 0);
    const withStock = await importer.confirmImport(storeId, [{ shopifyProductId: P(20), ownerId: A.id, mappingIds: [mA.id, mB.id], quantities: { [mA.id]: 7, [mB.id]: 0 } }], admin.id, { warehouseId: W1.id, locationId: L1.id });
    const stkProduct = withStock.created[0] ? await prisma.product.findUnique({ where: { id: withStock.created[0].productId }, include: { variants: true } }) : null;
    if (stkProduct) created.productIds.push(stkProduct.id);
    const v1 = stkProduct?.variants.find((v) => v.sku === `${RUN}-STK-1`);
    const v2 = stkProduct?.variants.find((v) => v.sku === `${RUN}-STK-2`);
    const lvl1 = v1 ? await prisma.inventoryLevel.findFirst({ where: { variantId: v1.id, locationId: L1.id } }) : null;
    const bal1 = v1 ? await prisma.inventoryBalance.findFirst({ where: { variantId: v1.id, warehouseId: W1.id } }) : null;
    check("import confirm: product created AND 7 units booked into the chosen V3PL warehouse/location through the core receipt (RECEIVE ledger row, level, balance); result reports destination + units", withStock.created.length === 1 && withStock.created[0].stock?.units === 7 && withStock.created[0].stock?.lines === 1 && withStock.destination?.warehouseId === W1.id && withStock.destination?.locationLabel === L1.label && lvl1?.onHand === 7 && bal1?.onHand === 7 && !!v1 && (await prisma.inventoryTransaction.count({ where: { variantId: v1.id, type: "RECEIVE", warehouseId: W1.id, locationId: L1.id, quantity: 7 } })) === 1, JSON.stringify({ created: withStock.created.length, failed: withStock.failed, lvl: lvl1?.onHand, bal: bal1?.onHand }));
    check("import confirm: the 0-quantity SKU of the same product stays data-only; exactly one receipt 'Initial stock' in that warehouse", !!v2 && (await prisma.inventoryTransaction.count({ where: { variantId: v2.id } })) === 0 && (await prisma.receivingRecord.count({ where: { reference: "Initial stock", warehouseId: W1.id } })) === 1);
    check("import confirm: mappings MATCHED to the new variants; sync log names the units and the V3PL destination", (await mappingBy(storeId, 20))!.status === "MATCHED" && (await mappingBy(storeId, 20))!.variant?.sku === `${RUN}-STK-1` && (await mappingBy(storeId, 21))!.status === "MATCHED" && (await prisma.shopifySyncLog.count({ where: { storeId, operation: "import", status: "SUCCESS", message: { contains: `7 units received into ${RUN}-W1` } } })) === 1);
    await catalog.syncCatalog(storeId, { mode: "paged" });
    const reimport = await importer.previewImport(storeId, [mA.id, mB.id], A.id);
    check("re-sync safety: another catalog sync + a re-import attempt leave stock untouched (already mapped → skipped; still exactly 7 on hand, one ledger row)", reimport.products.length === 0 && reimport.skipped.length === 2 && (await prisma.inventoryBalance.findFirst({ where: { variantId: v1!.id, warehouseId: W1.id } }))?.onHand === 7 && (await prisma.inventoryTransaction.count({ where: { variantId: v1!.id } })) === 1);
    const dataOnly = await importer.confirmImport(storeId, [{ shopifyProductId: P(21), ownerId: A.id, mappingIds: [mC.id] }], admin.id, { warehouseId: W1.id, locationId: L1.id });
    const soloId = dataOnly.created[0]?.productId;
    if (soloId) created.productIds.push(soloId);
    check("import confirm: no quantities → data-only import even with a destination chosen (existing contract preserved, Shopify's 3 is not copied)", dataOnly.created.length === 1 && dataOnly.created[0].stock === null && (await prisma.inventoryTransaction.count({ where: { variant: { productId: soloId } } })) === 0 && (await mappingBy(storeId, 22))!.status === "MATCHED");

    // ---------------------------------------------------------------- daily maintenance runs the catalog sync
    const daily = await maintenance.runDailyMaintenance(60_000);
    check("daily: catalog sync included per connected store", daily.catalogSyncs.some((c) => c.storeId === storeId && c.ok));

    // ---------------------------------------------------------------- HTTP: mapping page + CSV route
    const { firebaseAdminAuth } = await import("../src/lib/firebase/admin");
    const custom = await firebaseAdminAuth().createCustomToken(admin.firebaseUid);
    const signIn = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${process.env.NEXT_PUBLIC_FIREBASE_API_KEY}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: custom, returnSecureToken: true }) });
    const { idToken } = (await signIn.json()) as { idToken: string };
    const sess = await fetch(`${base}/api/auth/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken, audience: "staff" }) });
    const cookie = (sess.headers.get("set-cookie") ?? "").split(";")[0];
    let r = await fetch(`${base}/admin/settings/shopify/${storeId}?tab=mapping`, { headers: { Cookie: cookie } });
    const html = await r.text();
    check("pages: mapping tab renders rows, statuses and internal SKUs", r.status === 200 && html.includes(`${RUN}-NEWP-1`) && html.includes("Matched (manual)") && html.includes("Conflict") && html.includes("Sync products now"), `status=${r.status} newp=${html.includes(`${RUN}-NEWP-1`)} manual=${html.includes("Matched (manual)")} conflict=${html.includes("Conflict")} sync=${html.includes("Sync products now")}`);
    r = await fetch(`${base}/admin/settings/shopify/${storeId}?tab=mapping&status=UNMATCHED&q=${RUN}-NOWSKU`, { headers: { Cookie: cookie } });
    check("pages: status + search filters", r.status === 200 && (await r.text()).includes(`${RUN}-NOWSKU`));
    r = await fetch(`${base}/api/shopify/stores/${storeId}/unmatched`, { headers: { Cookie: cookie } });
    const csvBody = await r.text();
    check("csv route: admin download", r.status === 200 && (r.headers.get("content-type") ?? "").includes("text/csv") && csvBody.includes(`${RUN}-NOWSKU`), `status=${r.status} type=${r.headers.get("content-type")} body=${csvBody.slice(0, 120).replace(/\n/g, " | ")}`);
    r = await fetch(`${base}/api/shopify/stores/${storeId}/unmatched`);
    check("csv route: unauthenticated → 401", r.status === 401);
    await fetch(`${base}/api/auth/session`, { method: "DELETE", headers: { Cookie: cookie } });
  } finally {
    client.__setShopifyFetchForTests(null);
    await prisma.shopifyStore.deleteMany({ where: { id: { in: created.storeIds } } });
    await prisma.shopifyWebhookEvent.deleteMany({ where: { webhookId: { startsWith: `wh-${RUN}` } } });
    const extra = await prisma.product.findMany({ where: { ownerId: { in: created.ownerIds } }, select: { id: true } });
    const productIds = [...new Set([...created.productIds, ...extra.map((p) => p.id)])];
    await prisma.inventoryTransaction.deleteMany({ where: { variant: { productId: { in: productIds } } } });
    await prisma.inventoryLevel.deleteMany({ where: { variant: { productId: { in: productIds } } } });
    await prisma.inventoryBalance.deleteMany({ where: { variant: { productId: { in: productIds } } } });
    await prisma.receivingItem.deleteMany({ where: { variant: { productId: { in: productIds } } } });
    await prisma.receivingRecord.deleteMany({ where: { warehouseId: { in: created.warehouseIds } } });
    await prisma.productVariant.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.location.deleteMany({ where: { warehouseId: { in: created.warehouseIds } } });
    await prisma.warehouse.deleteMany({ where: { id: { in: created.warehouseIds } } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: [...created.ownerIds, ...productIds, ...created.storeIds] } }, { entityType: "ShopifyVariantMapping", createdAt: { gte: new Date(Date.now() - 30 * 60 * 1000) } }] } }).catch(() => undefined);
    await prisma.owner.deleteMany({ where: { id: { in: created.ownerIds } } });
    await prisma.$disconnect();
    console.log(`Cleanup done (${productIds.length} products, ${created.storeIds.length} store removed).`);
  }
  const failed = results.filter((x) => !x.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
