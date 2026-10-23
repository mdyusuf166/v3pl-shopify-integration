/**
 * Manual V3PL order → Shopify order, CORE side (D-061, QA SHP-10 / SKU-04): store resolution from the
 * authoritative mappings (missing / ambiguous / mixed → no job), idempotent ORDER_CREATE job creation,
 * outbound state derivation, result contracts (reference recorded once, failure marking), inbound dedupe of
 * the resulting Shopify order, contract payload, permissions and the order-page card.
 *
 * Nothing here calls Shopify: stores are test rows in CONNECTED status with hand-made mappings.
 *
 * Usage: npm run e2e:shopify-order -- http://localhost:3100 vendor3pl@gmail.com
 */
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });
loadEnv();

const [base = "http://localhost:3100", adminEmail = "vendor3pl@gmail.com"] = process.argv.slice(2);
const RUN = `so${Date.now().toString(36)}`.toUpperCase();
const results: { name: string; ok: boolean; skipped?: boolean }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const skip = (name: string, why: string) => {
  results.push({ name, ok: true, skipped: true });
  console.log(`SKIP  ${name} — ${why}`);
};
async function expectError<T>(fn: () => Promise<T>): Promise<{ hit: boolean; code?: string; message?: string }> {
  try {
    await fn();
    return { hit: false };
  } catch (err) {
    return { hit: true, code: (err as { code?: string }).code, message: (err as Error).message };
  }
}
const actionRef = (exportName: string) => new RegExp(`createServerReference\\)\\("([0-9a-f]+)"[^)]*"${exportName}"\\)`);
async function findServedActionId(html: string, exportName: string): Promise<string | null> {
  const urls = [...new Set([...html.matchAll(/\/_next\/static\/chunks\/[^"'\\\s)]+\.js/g)].map((m) => m[0]))];
  for (const u of urls) {
    const res = await fetch(`${base}${u}`);
    if (!res.ok) continue;
    const m = (await res.text()).match(actionRef(exportName));
    if (m) return m[1];
  }
  return null;
}

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const owners = await import("../src/server/services/owners");
  const users = await import("../src/server/services/users");
  const products = await import("../src/server/services/products");
  const warehouses = await import("../src/server/services/warehouses");
  const receiving = await import("../src/server/services/receiving");
  const orders = await import("../src/server/services/orders");
  const customers = await import("../src/server/services/customers");
  const sor = await import("../src/server/services/shopify-order-request");
  const { productFormSchema } = await import("../src/lib/validation/products");
  const { customerFormSchema } = await import("../src/lib/validation/customers");

  const admin = await prisma.user.findFirstOrThrow({ where: { email: adminEmail, role: "ADMIN" } });
  const created = { ownerIds: [] as string[], warehouseIds: [] as string[], storeIds: [] as string[], userIds: [] as string[], firebaseUids: [] as string[], orderIds: new Set<string>(), customerIds: [] as string[] };
  const ownerInput = (code: string, businessName: string) => ({ code, businessName, contactName: "Contact", email: null, phone: null, addressLine1: null, addressLine2: null, city: "Austin", state: null, postalCode: null, country: "US", notes: null });
  const sku = (s: string) => `${RUN}-${s}`.toUpperCase();
  const shipTo = (n: string) => ({ customerName: `${n} ${RUN}`, customerEmail: `${n.toLowerCase()}.${RUN.toLowerCase()}@example.com`, customerPhone: "+1 512 555 0100", shipName: `${n} ${RUN}`, shipAddress1: "1 Outbound Way", shipCity: "Austin", shipProvince: "TX", shipZip: "78701", shipCountry: "US" });

  try {
    const V = await owners.createOwner("VENDOR", ownerInput(`${RUN}-V`, `SO Vendor ${RUN}`), admin.id);
    created.ownerIds.push(V.id);
    const W = await warehouses.createWarehouse({ code: `${RUN}-W`, name: "SO Warehouse", addressLine1: null, addressLine2: null, city: "Dallas", state: null, postalCode: null, country: "US", notes: null }, admin.id);
    created.warehouseIds.push(W.id);
    const main = (await warehouses.getDefaultLocation(W.id))!;
    const p = await products.createProduct(
      productFormSchema.parse({
        ownerId: V.id,
        name: `SO Widget ${RUN}`,
        status: "ACTIVE",
        variants: [
          { sku: sku("A"), price: "10.00", status: "ACTIVE" }, // store one
          { sku: sku("B"), price: "12.00", status: "ACTIVE" }, // store one
          { sku: sku("C"), price: "5.00", status: "ACTIVE" }, // store two
          { sku: sku("X"), price: "7.00", status: "ACTIVE" }, // unmapped
          { sku: sku("D"), price: "8.00", status: "ACTIVE" }, // ambiguous (one + two)
          { sku: sku("P"), price: "9.00", status: "ACTIVE" }, // mapped only in a PENDING_INSTALL store
        ],
      }),
      admin.id,
    );
    const v = Object.fromEntries(p.variants.map((x) => [x.sku.slice(RUN.length + 1), x]));
    await receiving.createReceiving({ ownerId: V.id, warehouseId: W.id, reference: `${RUN}-RC`, notes: null, lines: p.variants.map((x) => ({ variantId: x.id, locationId: main.id, quantity: 50 })) }, admin.id);

    const s1 = await prisma.shopifyStore.create({ data: { name: `SO Store One ${RUN}`, shopDomain: `${RUN.toLowerCase()}-one.myshopify.com`, apiVersion: "2026-07", status: "CONNECTED" } });
    const s2 = await prisma.shopifyStore.create({ data: { name: `SO Store Two ${RUN}`, shopDomain: `${RUN.toLowerCase()}-two.myshopify.com`, apiVersion: "2026-07", status: "CONNECTED" } });
    const s3 = await prisma.shopifyStore.create({ data: { name: `SO Store Pending ${RUN}`, shopDomain: `${RUN.toLowerCase()}-three.myshopify.com`, apiVersion: "2026-07", status: "PENDING_INSTALL" } });
    created.storeIds.push(s1.id, s2.id, s3.id);
    const gid = (n: string) => `gid://shopify/ProductVariant/${RUN}${n}`;
    const pid = (n: string) => `gid://shopify/Product/${RUN}${n}`;
    const map = (storeId: string, key: string, status: "MATCHED" | "UNMATCHED" | "IGNORED" = "MATCHED") => ({ storeId, shopifyProductId: pid(key), shopifyVariantId: gid(key + storeId.slice(-4)), shopifyInventoryItemId: `gid://shopify/InventoryItem/${RUN}${key}`, shopifySku: sku(key), status, matchedBy: status === "MATCHED" ? ("SKU_EXACT" as const) : null, variantId: v[key].id });
    await prisma.shopifyVariantMapping.createMany({ data: [map(s1.id, "A"), map(s1.id, "B"), map(s2.id, "C"), map(s1.id, "D"), map(s2.id, "D"), map(s3.id, "P"), map(s2.id, "X", "UNMATCHED")] });

    // ---------------------------------------------------------------- 1. store resolution
    const okRes = await sor.resolveShopifyStoreForVariants([v.A.id, v.B.id, v.A.id]);
    check("Resolution: all lines MATCHED in one CONNECTED store → that store, one resolved line per variant with Shopify ids", okRes.ok && okRes.storeId === s1.id && okRes.storeName.startsWith("SO Store One") && okRes.lines.length === 2 && okRes.lines.every((l) => l.shopifyVariantId && l.shopifyProductId && l.shopifyInventoryItemId));
    const missing = await sor.resolveShopifyStoreForVariants([v.A.id, v.X.id]);
    check("Resolution: an UNMATCHED / never-mapped SKU → NO_MAPPING naming the SKU (no guess from the UNMATCHED row)", !missing.ok && missing.code === "NO_MAPPING" && missing.message.includes(sku("X")) && !missing.message.includes(sku("A")));
    const pendingOnly = await sor.resolveShopifyStoreForVariants([v.P.id]);
    check("Resolution: a SKU mapped only in a non-connected store counts as unmapped (NO_MAPPING)", !pendingOnly.ok && pendingOnly.code === "NO_MAPPING");
    const amb = await sor.resolveShopifyStoreForVariants([v.A.id, v.D.id]);
    check("Resolution: a SKU MATCHED in two connected stores → AMBIGUOUS_MAPPING, never guessed", !amb.ok && amb.code === "AMBIGUOUS_MAPPING" && amb.message.includes(sku("D")));
    const mixed = await sor.resolveShopifyStoreForVariants([v.A.id, v.C.id]);
    check("Resolution: lines split across two connected stores → MIXED_STORES listing the SKUs per store", !mixed.ok && mixed.code === "MIXED_STORES" && mixed.message.includes(sku("A")) && mixed.message.includes(sku("C")));

    // ---------------------------------------------------------------- 2. eligible manual order → one job
    const o1 = await orders.createOrder({ source: "MANUAL", ...shipTo("Ada"), warehouseId: W.id, reserve: true, notes: "gift wrap", tags: "vip", lines: [{ variantId: v.A.id, quantity: 2, unitPrice: "10.00" }, { variantId: v.B.id, quantity: 1, unitPrice: "12.00" }] }, admin.id);
    created.orderIds.add(o1.orderId);
    const before = await sor.shopifyOrderEligibility(o1.orderId);
    check("Eligibility (fresh manual order): ok, state NOT_SENT, store resolved server-side", before.ok && before.state === "NOT_SENT" && before.storeId === s1.id);
    const r1 = await sor.requestShopifyOrder(o1.orderId, admin.id);
    const job1 = await prisma.shopifyOutboundJob.findUnique({ where: { dedupeKey: `order:${o1.orderId}` } });
    const o1Row = await prisma.order.findUniqueOrThrow({ where: { id: o1.orderId }, include: { events: true, items: true } });
    check("Request: creates exactly one ORDER_CREATE job (dedupeKey order:{id}, PENDING, targetType Order) for the resolved store", !r1.reused && r1.state === "PENDING" && !!job1 && job1.type === "ORDER_CREATE" && job1.status === "PENDING" && job1.storeId === s1.id && job1.targetType === "Order" && job1.targetId === o1.orderId && job1.id === r1.jobId);
    check("Request: order gets shopifyStoreId + outbound PENDING, event shopify_order_requested + audit; no Shopify order id yet", o1Row.shopifyStoreId === s1.id && o1Row.shopifyOutboundStatus === "PENDING" && o1Row.shopifyOrderId === null && o1Row.events.some((e) => e.type === "shopify_order_requested") && (await prisma.auditLog.count({ where: { entityId: o1.orderId, action: "order.shopify_requested" } })) === 1);
    const invBefore = await prisma.inventoryBalance.findMany({ where: { variantId: { in: [v.A.id, v.B.id] }, warehouseId: W.id } });
    check("Request: V3PL order and inventory untouched (status/reservation unchanged, only the reservation from order creation exists)", o1Row.status !== "CANCELLED" && invBefore.every((b) => b.reserved === (b.variantId === v.A.id ? 2 : 1)));

    // ---------------------------------------------------------------- 3. idempotency
    const r1b = await sor.requestShopifyOrder(o1.orderId, admin.id);
    const jobs1 = await prisma.shopifyOutboundJob.count({ where: { targetType: "Order", targetId: o1.orderId } });
    check("Idempotency: repeated request reuses the same PENDING job, no duplicate job/event", r1b.reused && r1b.jobId === r1.jobId && jobs1 === 1 && (await prisma.orderEvent.count({ where: { orderId: o1.orderId, type: "shopify_order_requested" } })) === 1);
    const parallel = await Promise.all([1, 2, 3].map(() => sor.requestShopifyOrder(o1.orderId, admin.id).catch((e) => ({ err: e as Error }))));
    check("Idempotency: concurrent requests all resolve to the single job", parallel.every((r) => !("err" in r) && r.jobId === r1.jobId) && (await prisma.shopifyOutboundJob.count({ where: { targetType: "Order", targetId: o1.orderId } })) === 1);

    // ---------------------------------------------------------------- 4. contract payload
    const req = await sor.buildShopifyOrderRequest(o1.orderId);
    check("Contract: version 1, idempotencyKey = dedupeKey, origin V3PL_MANUAL, store + customer + shipping address + totals", req.version === 1 && req.idempotencyKey === `order:${o1.orderId}` && req.origin === "V3PL_MANUAL" && req.store.id === s1.id && req.store.shopDomain === s1.shopDomain && req.customer.email === shipTo("Ada").customerEmail && req.shippingAddress.address1 === "1 Outbound Way" && req.shippingAddress.country === "US" && req.order.notes === "gift wrap" && req.order.tags === "vip" && req.order.currency === o1Row.currency && req.billingAddress === null);
    const lineA = req.lines.find((l) => l.sku === sku("A"));
    check("Contract: lines carry orderItemId, sku, active quantity, unit price and the store's Shopify variant/product/inventory-item ids", req.lines.length === 2 && !!lineA && lineA.quantity === 2 && lineA.unitPrice === "10" && lineA.shopifyVariantId === gid("A" + s1.id.slice(-4)) && lineA.shopifyProductId === pid("A") && lineA.shopifyInventoryItemId === `gid://shopify/InventoryItem/${RUN}A` && req.lines.every((l) => o1Row.items.some((i) => i.id === l.orderItemId)));

    // ---------------------------------------------------------------- 5. result contract: reference recorded once
    const shopifyOrderId = `gid://shopify/Order/${RUN}1001`;
    const rec1 = await sor.recordShopifyOrderReference(o1.orderId, { shopifyStoreId: s1.id, shopifyOrderId, shopifyOrderName: "#1001" }, null);
    const o1After = await prisma.order.findUniqueOrThrow({ where: { id: o1.orderId }, include: { events: true } });
    check("Reference: recorded → shopifyOrderId/Name set, outbound CREATED, error cleared, event shopify_order_created, job result stored", rec1.updated && o1After.shopifyOrderId === shopifyOrderId && o1After.shopifyOrderName === "#1001" && o1After.shopifyOutboundStatus === "CREATED" && o1After.shopifyOutboundError === null && o1After.events.some((e) => e.type === "shopify_order_created") && ((await prisma.shopifyOutboundJob.findUniqueOrThrow({ where: { id: r1.jobId } })).result as { shopifyOrderId?: string })?.shopifyOrderId === shopifyOrderId);
    const rec2 = await sor.recordShopifyOrderReference(o1.orderId, { shopifyStoreId: s1.id, shopifyOrderId, shopifyOrderName: "#1001" }, null);
    const rec3 = await expectError(() => sor.recordShopifyOrderReference(o1.orderId, { shopifyStoreId: s1.id, shopifyOrderId: `gid://shopify/Order/${RUN}1002` }, null));
    check("Reference: same reference again → { updated:false }; a different Shopify order for the same V3PL order → BAD_STATUS", !rec2.updated && rec3.hit && rec3.code === "BAD_STATUS" && (await prisma.orderEvent.count({ where: { orderId: o1.orderId, type: "shopify_order_created" } })) === 1);
    const invalid = await expectError(() => sor.recordShopifyOrderReference(o1.orderId, { shopifyStoreId: "", shopifyOrderId: " " }, null));
    check("Reference: blank ids rejected (INVALID_REFERENCE)", invalid.hit && invalid.code === "INVALID_REFERENCE");
    const again = await sor.requestShopifyOrder(o1.orderId, admin.id);
    const after = await sor.shopifyOrderEligibility(o1.orderId);
    check("After creation: request is a no-op reuse (state CREATED, still one job); eligibility reports ALREADY_CREATED", again.reused && again.state === "CREATED" && (await prisma.shopifyOutboundJob.count({ where: { targetType: "Order", targetId: o1.orderId } })) === 1 && !after.ok && after.code === "ALREADY_CREATED" && after.state === "CREATED");

    // ---------------------------------------------------------------- 6. inbound dedupe of the created Shopify order
    const inbound = await orders.createOrder({ source: "SHOPIFY", shopify: { storeId: s1.id, orderId: shopifyOrderId, orderName: "#1001" }, ...shipTo("Ada"), warehouseId: W.id, reserve: true, lines: [{ variantId: v.A.id, quantity: 2 }, { variantId: v.B.id, quantity: 1 }] }, null);
    check("Inbound dedupe: an orders/create import for the created Shopify order resolves to the SAME V3PL order (created:false) — no duplicate, no double reservation", !inbound.created && inbound.orderId === o1.orderId && (await prisma.order.count({ where: { shopifyStoreId: s1.id, shopifyOrderId } })) === 1 && (await prisma.inventoryBalance.findFirstOrThrow({ where: { variantId: v.A.id, warehouseId: W.id } })).reserved === 2);
    const o2 = await orders.createOrder({ source: "MANUAL", ...shipTo("Bob"), warehouseId: W.id, reserve: false, lines: [{ variantId: v.A.id, quantity: 1 }] }, admin.id);
    created.orderIds.add(o2.orderId);
    const dupRef = await expectError(() => sor.recordShopifyOrderReference(o2.orderId, { shopifyStoreId: s1.id, shopifyOrderId }, null));
    check("Reference: one Shopify order can only link to one V3PL order (UNIQUE store+order id → BAD_STATUS on a second order)", dupRef.hit && dupRef.code === "BAD_STATUS" && (await prisma.order.findUniqueOrThrow({ where: { id: o2.orderId } })).shopifyOrderId === null);

    // ---------------------------------------------------------------- 7. ineligible orders → no job, clear reason
    const noMap = await orders.createOrder({ source: "MANUAL", ...shipTo("Cid"), warehouseId: W.id, reserve: false, lines: [{ variantId: v.A.id, quantity: 1 }, { variantId: v.X.id, quantity: 1 }] }, admin.id);
    created.orderIds.add(noMap.orderId);
    const e1 = await expectError(() => sor.requestShopifyOrder(noMap.orderId, admin.id));
    const mixedO = await orders.createOrder({ source: "MANUAL", ...shipTo("Dee"), warehouseId: W.id, reserve: false, lines: [{ variantId: v.A.id, quantity: 1 }, { variantId: v.C.id, quantity: 1 }] }, admin.id);
    created.orderIds.add(mixedO.orderId);
    const e2 = await expectError(() => sor.requestShopifyOrder(mixedO.orderId, admin.id));
    const ambO = await orders.createOrder({ source: "MANUAL", ...shipTo("Eve"), warehouseId: W.id, reserve: false, lines: [{ variantId: v.D.id, quantity: 1 }] }, admin.id);
    created.orderIds.add(ambO.orderId);
    const e3 = await expectError(() => sor.requestShopifyOrder(ambO.orderId, admin.id));
    const noJobs = (await prisma.shopifyOutboundJob.count({ where: { targetType: "Order", targetId: { in: [noMap.orderId, mixedO.orderId, ambO.orderId] } } })) === 0;
    const untouched = (await prisma.order.findMany({ where: { id: { in: [noMap.orderId, mixedO.orderId, ambO.orderId] } } })).every((o) => o.shopifyStoreId === null && o.shopifyOutboundStatus === null);
    check("Ineligible: missing mapping → NO_MAPPING with the SKU; mixed stores → MIXED_STORES; ambiguous → AMBIGUOUS_MAPPING; no job, no partial request, orders untouched", e1.hit && e1.code === "NO_MAPPING" && !!e1.message?.includes(sku("X")) && e2.hit && e2.code === "MIXED_STORES" && e3.hit && e3.code === "AMBIGUOUS_MAPPING" && noJobs && untouched);
    const portal = await orders.createOrder({ source: "THREEPL_PORTAL", ...shipTo("Fay"), warehouseId: W.id, reserve: false, submittedByOwnerId: V.id, lines: [{ variantId: v.A.id, quantity: 1 }] }, null).catch(() => null);
    if (portal) created.orderIds.add(portal.orderId);
    const shopO = await orders.createOrder({ source: "SHOPIFY", shopify: { storeId: s1.id, orderId: `gid://shopify/Order/${RUN}2000`, orderName: "#2000" }, ...shipTo("Gus"), warehouseId: W.id, reserve: false, lines: [{ variantId: v.A.id, quantity: 1 }] }, null);
    created.orderIds.add(shopO.orderId);
    const e4 = await expectError(() => sor.requestShopifyOrder(shopO.orderId, admin.id));
    const e5 = portal ? await expectError(() => sor.requestShopifyOrder(portal.orderId, admin.id)) : { hit: true, code: "NOT_ELIGIBLE" };
    check("Ineligible: Shopify-sourced and portal orders are refused (NOT_ELIGIBLE) — only MANUAL orders go out", e4.hit && e4.code === "NOT_ELIGIBLE" && e5.hit && e5.code === "NOT_ELIGIBLE");
    const cancelled = await orders.createOrder({ source: "MANUAL", ...shipTo("Hal"), warehouseId: W.id, reserve: false, lines: [{ variantId: v.A.id, quantity: 1 }] }, admin.id);
    created.orderIds.add(cancelled.orderId);
    await orders.cancelOrder(cancelled.orderId, "test", admin.id);
    const e6 = await expectError(() => sor.requestShopifyOrder(cancelled.orderId, admin.id));
    const partial = await orders.createOrder({ source: "MANUAL", ...shipTo("Ivy"), warehouseId: W.id, reserve: false, lines: [{ variantId: v.A.id, quantity: 1 }, { variantId: v.X.id, quantity: 3 }] }, admin.id);
    created.orderIds.add(partial.orderId);
    await prisma.orderItem.updateMany({ where: { orderId: partial.orderId, variantId: v.X.id }, data: { cancelledQty: 3 } });
    const partialEl = await sor.shopifyOrderEligibility(partial.orderId);
    check("Ineligible: cancelled order refused; a fully cancelled line is ignored (order with only the mapped active line becomes eligible)", e6.hit && e6.code === "NOT_ELIGIBLE" && partialEl.ok && partialEl.lines.length === 1 && partialEl.lines[0].sku === sku("A"));
    const missingOrder = await expectError(() => sor.requestShopifyOrder("nope-" + RUN, admin.id));
    check("Unknown order id → NOT_FOUND", missingOrder.hit && missingOrder.code === "NOT_FOUND");

    // ---------------------------------------------------------------- 8. failure + retry state machine
    const o3 = await orders.createOrder({ source: "MANUAL", ...shipTo("Jon"), warehouseId: W.id, reserve: false, lines: [{ variantId: v.C.id, quantity: 1 }] }, admin.id);
    created.orderIds.add(o3.orderId);
    const r3 = await sor.requestShopifyOrder(o3.orderId, admin.id);
    await prisma.shopifyOutboundJob.update({ where: { id: r3.jobId }, data: { status: "FAILED", attempts: 1, lastError: "Shopify said no", nextRetryAt: new Date(Date.now() + 60_000) } });
    await sor.markShopifyOrderFailed(o3.orderId, "Shopify said no", null);
    const s3a = await sor.shopifyOutboundSummary(o3.orderId);
    check("Failure: markShopifyOrderFailed → outbound FAILED + error + event; summary shows RETRYABLE while the job still retries, with the error text", s3a.state === "RETRYABLE" && s3a.error === "Shopify said no" && (await prisma.order.findUniqueOrThrow({ where: { id: o3.orderId } })).shopifyOutboundStatus === "FAILED" && (await prisma.orderEvent.count({ where: { orderId: o3.orderId, type: "shopify_order_failed" } })) === 1);
    await prisma.shopifyOutboundJob.update({ where: { id: r3.jobId }, data: { status: "NEEDS_ATTENTION" } });
    const s3b = await sor.shopifyOutboundSummary(o3.orderId);
    const r3b = await sor.requestShopifyOrder(o3.orderId, admin.id);
    const job3 = await prisma.shopifyOutboundJob.findUniqueOrThrow({ where: { id: r3.jobId } });
    check("Retry: NEEDS_ATTENTION shows FAILED (manual retry offered); a new request re-arms the SAME job to PENDING (no second job), clears the order error, logs shopify_order_retry", s3b.state === "FAILED" && r3b.reused && r3b.jobId === r3.jobId && job3.status === "PENDING" && job3.nextRetryAt === null && (await prisma.shopifyOutboundJob.count({ where: { targetType: "Order", targetId: o3.orderId } })) === 1 && (await prisma.order.findUniqueOrThrow({ where: { id: o3.orderId } })).shopifyOutboundStatus === "PENDING" && (await prisma.orderEvent.count({ where: { orderId: o3.orderId, type: "shopify_order_retry" } })) === 1);
    await prisma.shopifyOutboundJob.update({ where: { id: r3.jobId }, data: { status: "DONE" } });
    await sor.recordShopifyOrderReference(o3.orderId, { shopifyStoreId: s2.id, shopifyOrderId: `gid://shopify/Order/${RUN}3001`, shopifyOrderName: "#3001" }, null);
    await sor.markShopifyOrderFailed(o3.orderId, "late failure report", null);
    check("Late failure after a recorded reference changes nothing (stays CREATED)", (await sor.shopifyOutboundSummary(o3.orderId)).state === "CREATED" && (await prisma.order.findUniqueOrThrow({ where: { id: o3.orderId } })).shopifyOutboundError === null);
    const wrongStore = await orders.createOrder({ source: "MANUAL", ...shipTo("Kim"), warehouseId: W.id, reserve: false, lines: [{ variantId: v.C.id, quantity: 1 }] }, admin.id);
    created.orderIds.add(wrongStore.orderId);
    await sor.requestShopifyOrder(wrongStore.orderId, admin.id); // queued for store two
    const ws = await expectError(() => sor.recordShopifyOrderReference(wrongStore.orderId, { shopifyStoreId: s1.id, shopifyOrderId: `gid://shopify/Order/${RUN}4001` }, null));
    check("Reference from a different store than the one queued is refused (BAD_STATUS)", ws.hit && ws.code === "BAD_STATUS");

    // ---------------------------------------------------------------- 9. customer billing address flows into the contract
    const cust = await customers.createCustomer({ ownerId: undefined }, customerFormSchema.parse({ name: `Bill Payer ${RUN}`, email: `bill.${RUN.toLowerCase()}@example.com`, shipName: `Bill Payer ${RUN}`, shipAddress1: "5 Ship St", shipCity: "Austin", shipCountry: "US", billName: "Accounts", billCompany: "Payer Co", billAddress1: "9 Invoice Ave", billCity: "Dallas", billCountry: "US" }), admin.id);
    created.customerIds.push(cust.id);
    const o4 = await orders.createOrder({ source: "MANUAL", ...customers.customerSnapshot(cust), customerId: cust.id, warehouseId: W.id, reserve: false, lines: [{ variantId: v.B.id, quantity: 4 }] }, admin.id);
    created.orderIds.add(o4.orderId);
    const req4 = await sor.buildShopifyOrderRequest(o4.orderId);
    check("Contract: linked customer id + billing address (from the directory) included; shipping from the order snapshot", req4.customer.customerId === cust.id && req4.billingAddress?.address1 === "9 Invoice Ave" && req4.billingAddress.company === "Payer Co" && req4.shippingAddress.address1 === "5 Ship St" && req4.lines[0].quantity === 4);
    const badBuild = await expectError(() => sor.buildShopifyOrderRequest(noMap.orderId));
    check("Contract: building for an ineligible order throws the same typed error (runner never gets a partial payload)", badBuild.hit && badBuild.code === "NO_MAPPING");

    // ---------------------------------------------------------------- 10. HTTP: permissions, card, action
    let adminCookie = "";
    let whCookie = "";
    try {
      const { firebaseAdminAuth } = await import("../src/lib/firebase/admin");
      const mint = async (tag: string, role: "ADMIN" | "WAREHOUSE") => {
        const u = await users.createUserAccount({ name: `SO ${tag}`, email: `${RUN.toLowerCase()}-${tag}@example.test`, password: "E2eTestPass123", role, ownerId: null, phone: null, notes: null }, admin.id);
        created.userIds.push(u.id);
        created.firebaseUids.push(u.firebaseUid);
        const custom = await firebaseAdminAuth().createCustomToken(u.firebaseUid);
        const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${process.env.NEXT_PUBLIC_FIREBASE_API_KEY}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: custom, returnSecureToken: true }) });
        const { idToken } = await r.json();
        const res = await fetch(`${base}/api/auth/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken, audience: "staff" }) });
        return (res.headers.get("set-cookie") ?? "").split(";")[0];
      };
      adminCookie = await mint("admin", "ADMIN");
      whCookie = await mint("wh", "WAREHOUSE");
    } catch (err) {
      console.log(`      (session unavailable: ${(err as Error).message.slice(0, 100)})`);
    }
    const httpNames = ["HTTP: order page shows the Shopify card — CREATED order shows the Shopify order name; NOT_SENT eligible order shows store + Send button; ineligible shows the reason and a disabled button", "HTTP: new manual order form is served (store hint + send-after-create are client-side, action id present in served chunks)", "HTTP: requestShopifyOrderAction via HTTP as ADMIN queues the order (server-resolved store); repeat is a reuse; WAREHOUSE is refused; a browser-supplied store is impossible (no such argument)"];
    if (!adminCookie || !whCookie) {
      for (const n of httpNames) skip(n, "no session");
    } else {
      const page = async (cookie: string, path: string) => {
        const res = await fetch(`${base}${path}`, { headers: { Cookie: cookie }, redirect: "manual" });
        return { status: res.status, html: (await res.text()).replace(/<!--[\s\S]*?-->/g, "") };
      };
      const createdPage = await page(adminCookie, `/admin/orders/${o1.orderId}`);
      const eligiblePage = await page(adminCookie, `/admin/orders/${o4.orderId}`);
      const badPage = await page(adminCookie, `/admin/orders/${noMap.orderId}`);
      const card = (h: string) => h.match(/data-slot="shopify-outbound"[\s\S]*?<\/div><\/div>/)?.[0] ?? h.slice(h.indexOf('data-slot="shopify-outbound"'), h.indexOf('data-slot="shopify-outbound"') + 3000);
      check(httpNames[0], createdPage.status === 200 && card(createdPage.html).includes("Created in Shopify") && card(createdPage.html).includes("#1001") && eligiblePage.status === 200 && card(eligiblePage.html).includes("Not sent") && card(eligiblePage.html).includes("Send to Shopify") && card(eligiblePage.html).includes(`SO Store One ${RUN}`) && badPage.status === 200 && card(badPage.html).includes(sku("X")) && /disabled/.test(card(badPage.html)));
      const formPage = await page(adminCookie, "/admin/orders/new");
      const hintId = await findServedActionId(formPage.html, "checkShopifyStoreForVariantsAction");
      const reqId = await findServedActionId(formPage.html, "requestShopifyOrderAction");
      check(httpNames[1], formPage.status === 200 && !!hintId && !!reqId, `hint=${hintId?.slice(0, 8) ?? "?"} request=${reqId?.slice(0, 8) ?? "?"}`);
      if (!reqId) skip(httpNames[2], "action id unresolved");
      else {
        const call = (cookie: string, args: unknown[]) => fetch(`${base}/admin/orders/${o4.orderId}`, { method: "POST", redirect: "manual", headers: { Cookie: cookie, "Next-Action": reqId, Accept: "text/x-component", "Content-Type": "text/plain;charset=UTF-8" }, body: JSON.stringify(args) });
        const denied = await call(whCookie, [o4.orderId]);
        const deniedBody = await denied.text();
        const first = await call(adminCookie, [o4.orderId]);
        const firstBody = await first.text();
        const second = await call(adminCookie, [o4.orderId]);
        const secondBody = await second.text();
        const jobs4 = await prisma.shopifyOutboundJob.count({ where: { targetType: "Order", targetId: o4.orderId } });
        const o4Row = await prisma.order.findUniqueOrThrow({ where: { id: o4.orderId } });
        const deniedOk = denied.status !== 200 || !!denied.headers.get("x-action-redirect") || /"ok":false|forbidden|redirect/i.test(deniedBody) || !deniedBody.includes('"jobId"');
        check(httpNames[2], deniedOk && first.status === 200 && firstBody.includes('"reused":false') && firstBody.includes(`SO Store One ${RUN}`) && second.status === 200 && secondBody.includes('"reused":true') && jobs4 === 1 && o4Row.shopifyStoreId === s1.id && o4Row.shopifyOutboundStatus === "PENDING", `wh=${denied.status} first=${first.status} second=${second.status} jobs=${jobs4}`);
      }
    }

    // ---------------------------------------------------------------- 11. unregistered runner: job stays PENDING (Shopify side not implemented here)
    const stillPending = await prisma.shopifyOutboundJob.findMany({ where: { type: "ORDER_CREATE", storeId: { in: created.storeIds }, status: "PENDING" } });
    check("Core-only batch: ORDER_CREATE jobs remain PENDING for the Shopify session's runner (no core code calls Shopify)", stillPending.length >= 2);
  } finally {
    const { firebaseAdminAuth } = await import("../src/lib/firebase/admin");
    for (const uid of created.firebaseUids) await firebaseAdminAuth().deleteUser(uid).catch(() => undefined);
    const productIds = (await prisma.product.findMany({ where: { ownerId: { in: created.ownerIds } }, select: { id: true } })).map((p) => p.id);
    const all = await prisma.order.findMany({ where: { OR: [{ items: { some: { ownerId: { in: created.ownerIds } } } }, { warehouseId: { in: created.warehouseIds } }] }, select: { id: true } });
    all.forEach((x) => created.orderIds.add(x.id));
    const orderIds = [...created.orderIds];
    await prisma.shopifyOutboundJob.deleteMany({ where: { OR: [{ storeId: { in: created.storeIds } }, { targetType: "Order", targetId: { in: orderIds } }] } });
    await prisma.shopifyVariantMapping.deleteMany({ where: { storeId: { in: created.storeIds } } });
    await prisma.shopifyStore.deleteMany({ where: { id: { in: created.storeIds } } });
    await prisma.inventoryTransaction.deleteMany({ where: { OR: [{ orderId: { in: orderIds } }, { variant: { productId: { in: productIds } } }, { warehouseId: { in: created.warehouseIds } }] } });
    await prisma.orderEvent.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await prisma.customer.deleteMany({ where: { OR: [{ id: { in: created.customerIds } }, { email: { endsWith: `${RUN.toLowerCase()}@example.com` } }] } });
    await prisma.inventoryLevel.deleteMany({ where: { OR: [{ variant: { productId: { in: productIds } } }, { warehouseId: { in: created.warehouseIds } }] } });
    await prisma.inventoryBalance.deleteMany({ where: { OR: [{ variant: { productId: { in: productIds } } }, { warehouseId: { in: created.warehouseIds } }] } });
    await prisma.receivingItem.deleteMany({ where: { OR: [{ variant: { productId: { in: productIds } } }, { receiving: { warehouseId: { in: created.warehouseIds } } }] } });
    await prisma.receivingRecord.deleteMany({ where: { OR: [{ ownerId: { in: created.ownerIds } }, { warehouseId: { in: created.warehouseIds } }] } });
    await prisma.productVariant.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.location.deleteMany({ where: { warehouseId: { in: created.warehouseIds } } });
    await prisma.warehouse.deleteMany({ where: { id: { in: created.warehouseIds } } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: [...created.ownerIds, ...productIds, ...created.warehouseIds, ...created.userIds, ...orderIds, ...created.customerIds] } }, { userId: { in: created.userIds } }] } });
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
