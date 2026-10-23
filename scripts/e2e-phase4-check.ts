/**
 * Phase 4 end-to-end check: orders (multi-owner, idempotent, reservation policy,
 * concurrency), picking/packing/shipping (partial + multiple shipments), cancellation,
 * returns (inspection → restock / damaged), Shopify service contract (createExternal,
 * recordExternalShipment replay), CSV preview/import/failed-rows/export/round-trip,
 * import jobs, and HTTP/portal isolation. Cleans up everything it creates.
 *
 * Usage: npm run e2e:phase4 -- http://localhost:3100 vendor3pl@gmail.com
 */
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });
loadEnv();

const [base = "http://localhost:3100", adminEmail = "vendor3pl@gmail.com"] = process.argv.slice(2);
const RUN = `p4${Date.now().toString(36)}`.toUpperCase();
const results: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
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
  const { firebaseAdminAuth } = await import("../src/lib/firebase/admin");
  const owners = await import("../src/server/services/owners");
  const users = await import("../src/server/services/users");
  const products = await import("../src/server/services/products");
  const warehouses = await import("../src/server/services/warehouses");
  const inventory = await import("../src/server/services/inventory");
  const receiving = await import("../src/server/services/receiving");
  const orders = await import("../src/server/services/orders");
  const fulfillment = await import("../src/server/services/fulfillment");
  const fhooks = await import("../src/server/services/fulfillment-hooks");
  const returns = await import("../src/server/services/returns");
  const csv = await import("../src/server/services/order-csv");
  const imports = await import("../src/server/services/imports");
  const { parseCsv } = await import("../src/lib/csv");

  const admin = await prisma.user.findFirstOrThrow({ where: { email: adminEmail, role: "ADMIN" } });
  const created = { ownerIds: [] as string[], productIds: [] as string[], warehouseIds: [] as string[], userIds: [] as string[], firebaseUids: [] as string[], orderIds: new Set<string>(), jobIds: [] as string[] };
  const ownerInput = (code: string, businessName: string) => ({ code, businessName, contactName: null, email: null, phone: null, addressLine1: null, addressLine2: null, city: null, state: null, postalCode: null, country: null, notes: null });
  const whInput = (code: string, name: string) => ({ code, name, addressLine1: null, addressLine2: null, city: null, state: null, postalCode: null, country: null, notes: null });
  const variantInput = (sku: string, price: string) => ({ sku, name: null, barcode: null, price, cost: null, status: "ACTIVE" as const });
  let shipmentHookCalls = 0;
  const unregister = fhooks.registerShipmentHandler(async () => {
    shipmentHookCalls++;
  });
  const trackOrders = async () => {
    const all = await prisma.order.findMany({ where: { items: { some: { ownerId: { in: created.ownerIds } } } }, select: { id: true } });
    all.forEach((o) => created.orderIds.add(o.id));
  };

  try {
    // ---------------------------------------------------------------- setup
    const A = await owners.createOwner("VENDOR", ownerInput(`${RUN}-A`, `P4 Vendor A ${RUN}`), admin.id);
    const B = await owners.createOwner("VENDOR", ownerInput(`${RUN}-B`, `P4 Vendor B ${RUN}`), admin.id);
    const C = await owners.createOwner("THREEPL_CLIENT", ownerInput(`${RUN}-C`, `P4 Client C ${RUN}`), admin.id);
    created.ownerIds.push(A.id, B.id, C.id);
    const W = await warehouses.createWarehouse(whInput(`${RUN}-W`, "P4 Warehouse"), admin.id);
    const W2 = await warehouses.createWarehouse(whInput(`${RUN}-W2`, "P4 Warehouse 2"), admin.id);
    created.warehouseIds.push(W.id, W2.id);
    const main = (await warehouses.getDefaultLocation(W.id))!;
    const [skuA1, skuA2, skuB1, skuC1] = [`${RUN}-A1`, `${RUN}-A2`, `${RUN}-B1`, `${RUN}-C1`];
    const pA = await products.createProduct({ ownerId: A.id, name: "P4 Widget", category: null, description: null, notes: null, status: "ACTIVE", variants: [variantInput(skuA1, "10.00"), variantInput(skuA2, "4.00")] }, admin.id);
    const pB = await products.createProduct({ ownerId: B.id, name: "P4 Gadget", category: null, description: null, notes: null, status: "ACTIVE", variants: [variantInput(skuB1, "20.00")] }, admin.id);
    const pC = await products.createProduct({ ownerId: C.id, name: "P4 Client Box", category: null, description: null, notes: null, status: "ACTIVE", variants: [variantInput(skuC1, "5.00")] }, admin.id);
    created.productIds.push(pA.id, pB.id, pC.id);
    const vA1 = pA.variants.find((v) => v.sku === skuA1)!;
    const vA2 = pA.variants.find((v) => v.sku === skuA2)!;
    const vB1 = pB.variants[0];
    const vC1 = pC.variants[0];
    await receiving.createReceiving({ ownerId: A.id, warehouseId: W.id, reference: `${RUN}-RA`, notes: null, lines: [{ variantId: vA1.id, locationId: main.id, quantity: 100 }, { variantId: vA2.id, locationId: main.id, quantity: 5 }] }, admin.id);
    await receiving.createReceiving({ ownerId: B.id, warehouseId: W.id, reference: `${RUN}-RB`, notes: null, lines: [{ variantId: vB1.id, locationId: main.id, quantity: 50 }] }, admin.id);
    await receiving.createReceiving({ ownerId: C.id, warehouseId: W.id, reference: `${RUN}-RC`, notes: null, lines: [{ variantId: vC1.id, locationId: main.id, quantity: 30 }] }, admin.id);
    const avail = async (variantId: string) => (await inventory.availableForVariants([variantId], [W.id])).get(variantId) ?? 0;
    const bal = async (variantId: string) => (await inventory.stockForVariant(variantId)).find((s) => s.warehouse.id === W.id)!;

    // ---------------------------------------------------------------- multi-owner order
    const mo = await orders.createOrder({ source: "MANUAL", warehouseId: W.id, reserve: true, shipName: "Multi Owner", shipAddress1: "1 Test St", shipCity: "Austin", shipCountry: "US", lines: [{ variantId: vA1.id, quantity: 10 }, { sku: skuB1, quantity: 5 }, { variantId: vC1.id, quantity: 3 }] }, admin.id);
    let o = (await orders.getOrder(mo.orderId))!;
    check("Multi-owner order: one order, 3 lines, 3 owners, all reserved → CONFIRMED / RESERVED", mo.created && o.items.length === 3 && new Set(o.items.map((i) => i.ownerId)).size === 3 && o.items.every((i) => i.reservedQty === i.quantity) && o.status === "CONFIRMED" && o.fulfillmentStatus === "RESERVED", `${o.status}/${o.fulfillmentStatus} #${o.orderNumber}`);
    check("Reservation reduced available (A1 100 → 90)", (await avail(vA1.id)) === 90);
    check("Order number comes from the sequence (≥ 1001)", Number(o.orderNumber) >= 1001);

    // ---------------------------------------------------------------- idempotent identity
    const r1 = await orders.createOrder({ source: "CSV_IMPORT", sourceRef: `${RUN}-IDEM`, warehouseId: W.id, reserve: true, lines: [{ variantId: vA1.id, quantity: 2 }] }, admin.id);
    const r2 = await orders.createOrder({ source: "CSV_IMPORT", sourceRef: `${RUN}-IDEM`, warehouseId: W.id, reserve: true, lines: [{ variantId: vA1.id, quantity: 2 }] }, admin.id);
    check("Same (source, sourceRef) twice → one order, second call created=false", r1.created && !r2.created && r1.orderId === r2.orderId && (await avail(vA1.id)) === 88);
    const ext1 = await orders.createExternal({ source: "SHOPIFY", shopify: { storeId: `${RUN}-STORE`, orderId: "5001", orderName: "#5001" }, warehouseId: W.id, reserve: true, lines: [{ sku: skuA1, quantity: 3, externalLineId: "L1" }], externalEventId: `${RUN}-EVT-CREATE` }, null);
    const ext2 = await orders.createExternal({ source: "SHOPIFY", shopify: { storeId: `${RUN}-STORE`, orderId: "5001", orderName: "#5001" }, warehouseId: W.id, reserve: true, lines: [{ sku: skuA1, quantity: 3, externalLineId: "L1" }], externalEventId: `${RUN}-EVT-CREATE-2` }, null);
    check("Shopify contract: same store + order id twice → one internal order", ext1.created && !ext2.created && ext1.orderId === ext2.orderId && (await avail(vA1.id)) === 85);
    const racers = await Promise.all(Array.from({ length: 5 }, () => orders.createOrder({ source: "CSV_IMPORT", sourceRef: `${RUN}-RACE`, warehouseId: W.id, reserve: true, lines: [{ variantId: vB1.id, quantity: 1 }] }, admin.id).catch((e) => ({ error: e }))));
    const raceCreated = racers.filter((r) => "created" in r && r.created).length;
    const raceOrders = await prisma.order.count({ where: { source: "CSV_IMPORT", sourceRef: `${RUN}-RACE` } });
    check("5 concurrent creates with the same identity → exactly one order", raceCreated === 1 && raceOrders === 1 && racers.every((r) => !("error" in r)), `created=${raceCreated} rows=${raceOrders}`);

    // ---------------------------------------------------------------- reservation policy
    const short = await orders.createOrder({ source: "MANUAL", warehouseId: W.id, reserve: true, lines: [{ variantId: vA2.id, quantity: 10 }] }, admin.id);
    o = (await orders.getOrder(short.orderId))!;
    check("Insufficient stock → order created, line unreserved, needsAttention names the SKU", short.reservation.short.length === 1 && o.needsAttention && (o.needsAttentionReason ?? "").includes(skuA2) && o.items[0].reservedQty === 0 && o.status === "NEW" && (await avail(vA2.id)) === 5);
    await receiving.createReceiving({ ownerId: A.id, warehouseId: W.id, reference: `${RUN}-RA2`, notes: null, lines: [{ variantId: vA2.id, locationId: main.id, quantity: 10 }] }, admin.id);
    const retry1 = await orders.reserveOrder(short.orderId, admin.id);
    const retry2 = await orders.reserveOrder(short.orderId, admin.id);
    o = (await orders.getOrder(short.orderId))!;
    check("Reserve now after receipt → fully reserved, attention cleared, CONFIRMED; second call reserves nothing more", retry1.reserved.length === 1 && retry2.reserved.length === 0 && o.items[0].reservedQty === 10 && !o.needsAttention && o.status === "CONFIRMED" && (await avail(vA2.id)) === 5);
    const ledgerReserve = await prisma.inventoryTransaction.count({ where: { orderId: short.orderId, type: "RESERVE" } });
    check("Only one RESERVE ledger row for the retried reservation", ledgerReserve === 1);

    // ---------------------------------------------------------------- concurrency on reservations
    const before = await avail(vA1.id); // 85
    const pair = await Promise.all([
      orders.createOrder({ source: "MANUAL", warehouseId: W.id, reserve: true, lines: [{ variantId: vA1.id, quantity: 60 }] }, admin.id),
      orders.createOrder({ source: "MANUAL", warehouseId: W.id, reserve: true, lines: [{ variantId: vA1.id, quantity: 60 }] }, admin.id),
    ]);
    const fully = pair.filter((p) => p.reservation.short.length === 0).length;
    const b = await bal(vA1.id);
    check("Two concurrent 60-unit orders vs 85 available → exactly one reserved, other flagged; reserved ≤ onHand", fully === 1 && b.reserved <= b.onHand && b.available === before - 60, `reserved=${b.reserved} onHand=${b.onHand}`);
    for (const p of pair) await orders.cancelOrder(p.orderId, "test cleanup", admin.id);
    check("Cancelling both releases reservations (available back to 85)", (await avail(vA1.id)) === before);

    // ---------------------------------------------------------------- pick → pack → ship (partial)
    const dbl = await expectError(() => fulfillment.startPicking({ orderId: mo.orderId, warehouseId: W.id, lines: [{ orderItemId: o.items[0].id, quantity: 1 }] }, admin.id), "NOT_FOUND");
    void dbl;
    o = (await orders.getOrder(mo.orderId))!;
    const itemA = o.items.find((i) => i.sku === skuA1)!;
    const itemB = o.items.find((i) => i.sku === skuB1)!;
    const itemC = o.items.find((i) => i.sku === skuC1)!;
    const f1 = await fulfillment.startPicking({ orderId: mo.orderId, warehouseId: W.id, lines: [{ orderItemId: itemA.id, quantity: 4 }, { orderItemId: itemB.id, quantity: 5 }] }, admin.id);
    o = (await orders.getOrder(mo.orderId))!;
    check("Partial picking started → fulfilment PICKING, order fulfilment status PICKING", o.fulfillments.length === 1 && o.fulfillmentStatus === "PICKING");
    const over = await expectError(() => fulfillment.startPicking({ orderId: mo.orderId, warehouseId: W.id, lines: [{ orderItemId: itemA.id, quantity: 7 }] }, admin.id), "INVALID_QUANTITY");
    check("Double-picking prevented (only 6 of A1 left to pick, 7 requested)", over.hit);
    await fulfillment.markPacked(f1.id, admin.id);
    const s1 = await fulfillment.shipFulfillment(f1.id, { carrier: "UPS", trackingNumber: `${RUN}-TRK1`, trackingUrl: "https://example.com/t" }, admin.id);
    o = (await orders.getOrder(mo.orderId))!;
    const bA = await bal(vA1.id);
    check("Shipment 1: shipped 4×A1 + 5×B1, reservation consumed, order PARTIALLY_SHIPPED, still CONFIRMED", o.shipments.length === 1 && o.items.find((i) => i.sku === skuA1)!.shippedQty === 4 && o.items.find((i) => i.sku === skuA1)!.reservedQty === 6 && o.fulfillmentStatus === "PARTIALLY_SHIPPED" && o.status === "CONFIRMED" && bA.onHand === 96);
    const again = await expectError(() => fulfillment.shipFulfillment(f1.id, { carrier: "UPS" }, admin.id), "BAD_STATUS");
    check("Shipping the same fulfilment twice is rejected", again.hit);
    const f2 = await fulfillment.startPicking({ orderId: mo.orderId, warehouseId: W.id }, admin.id);
    const s2 = await fulfillment.shipFulfillment(f2.id, { carrier: "FedEx", trackingNumber: `${RUN}-TRK2` }, admin.id);
    o = (await orders.getOrder(mo.orderId))!;
    check("Shipment 2 ships the remainder (6×A1 + 3×C1) → SHIPPED / COMPLETED, 2 shipments", o.shipments.length === 2 && o.fulfillmentStatus === "SHIPPED" && o.status === "COMPLETED" && o.items.every((i) => i.shippedQty === i.quantity && i.reservedQty === 0));
    await fulfillment.updateShipmentStatus(s1.id, "DELIVERED", admin.id);
    await fulfillment.updateShipmentStatus(s2.id, "DELIVERED", admin.id);
    o = (await orders.getOrder(mo.orderId))!;
    check("All shipments delivered → FULFILLED", o.fulfillmentStatus === "FULFILLED");
    check("Shipment hooks fired once per shipment", shipmentHookCalls === 2, `${shipmentHookCalls}`);
    await fulfillment.updateShipmentTracking(s1.id, { carrier: "UPS", trackingNumber: `${RUN}-TRK1B` }, admin.id, `${RUN}-EVT-TRK`);
    await fulfillment.updateShipmentTracking(s1.id, { carrier: "UPS", trackingNumber: "SHOULD-NOT-APPLY" }, admin.id, `${RUN}-EVT-TRK`);
    check("Tracking update with a replayed externalEventId is ignored", (await prisma.shipment.findUnique({ where: { id: s1.id } }))?.trackingNumber === `${RUN}-TRK1B`);

    // ---------------------------------------------------------------- cancellation
    const co = await orders.createOrder({ source: "MANUAL", warehouseId: W.id, reserve: true, lines: [{ variantId: vA1.id, quantity: 5 }] }, admin.id);
    const availBefore = await avail(vA1.id);
    await orders.cancelOrder(co.orderId, "customer request", admin.id);
    const c1 = await orders.cancelOrder(co.orderId, "again", admin.id);
    o = (await orders.getOrder(co.orderId))!;
    check("Cancel releases the reservation, marks CANCELLED; second cancel is a no-op", o.status === "CANCELLED" && o.items[0].cancelledQty === 5 && o.items[0].reservedQty === 0 && (await avail(vA1.id)) === availBefore + 5 && c1.alreadyCancelled === true);
    const po = await orders.createOrder({ source: "MANUAL", warehouseId: W.id, reserve: true, lines: [{ variantId: vA1.id, quantity: 4 }] }, admin.id);
    o = (await orders.getOrder(po.orderId))!;
    const pf = await fulfillment.startPicking({ orderId: po.orderId, warehouseId: W.id, lines: [{ orderItemId: o.items[0].id, quantity: 2 }] }, admin.id);
    await fulfillment.shipFulfillment(pf.id, { carrier: "DHL" }, admin.id);
    await orders.cancelOrder(po.orderId, "rest not needed", admin.id);
    o = (await orders.getOrder(po.orderId))!;
    check("Cancel after partial shipment → COMPLETED, shipped 2, cancelled 2, reserved 0", o.status === "COMPLETED" && o.items[0].shippedQty === 2 && o.items[0].cancelledQty === 2 && o.items[0].reservedQty === 0);

    // ---------------------------------------------------------------- line quantity adjustment
    const ao = await orders.createOrder({ source: "SHOPIFY", shopify: { storeId: `${RUN}-STORE`, orderId: "5002" }, warehouseId: W.id, reserve: true, lines: [{ variantId: vA1.id, quantity: 5, externalLineId: "L5" }] }, null);
    o = (await orders.getOrder(ao.orderId))!;
    await orders.adjustLineQuantity(ao.orderId, o.items[0].id, 3, "edited", null, `${RUN}-EVT-EDIT1`);
    const replay = await orders.adjustLineQuantity(ao.orderId, o.items[0].id, 1, "edited", null, `${RUN}-EVT-EDIT1`);
    o = (await orders.getOrder(ao.orderId))!;
    check("Line 5 → 3 releases 2; replayed event id does not apply", o.items[0].quantity === 3 && o.items[0].reservedQty === 3 && replay.replay === true);
    await orders.adjustLineQuantity(ao.orderId, o.items[0].id, 7, "edited up", null, `${RUN}-EVT-EDIT2`);
    o = (await orders.getOrder(ao.orderId))!;
    check("Line 3 → 7 reserves the extra 4", o.items[0].quantity === 7 && o.items[0].reservedQty === 7);

    // ---------------------------------------------------------------- external shipment (Shopify contract)
    const ex = await fulfillment.recordExternalShipment(ao.orderId, { lines: [{ orderItemId: o.items[0].id, quantity: 7 }], carrier: "USPS", trackingNumber: `${RUN}-EXT`, externalFulfillmentId: "F-9001", shopifyStoreId: `${RUN}-STORE`, externalEventId: `${RUN}-EVT-FUL` }, null);
    const ex2 = await fulfillment.recordExternalShipment(ao.orderId, { lines: [{ orderItemId: o.items[0].id, quantity: 7 }], carrier: "USPS", trackingNumber: `${RUN}-EXT`, externalFulfillmentId: "F-9001", shopifyStoreId: `${RUN}-STORE`, externalEventId: `${RUN}-EVT-FUL-2` }, null);
    o = (await orders.getOrder(ao.orderId))!;
    check("External fulfilment mirrored once: shipment created, reservation consumed, replay returns existing", ex.created && !ex2.created && ex2.fulfillmentId === ex.fulfillmentId && o.shipments.length === 1 && o.items[0].shippedQty === 7 && o.items[0].reservedQty === 0 && o.status === "COMPLETED");
    const sync = await orders.syncExternalUpdate(ao.orderId, { financialStatus: "PAID", shopifyFinancialStatus: "paid", tags: "vip" }, null, `${RUN}-EVT-UPD`);
    const syncReplay = await orders.syncExternalUpdate(ao.orderId, { tags: "changed" }, null, `${RUN}-EVT-UPD`);
    o = (await orders.getOrder(ao.orderId))!;
    check("Header sync applies once; replay ignored", sync.replay === false && syncReplay.replay === true && o.financialStatus === "PAID" && o.tags === "vip");

    // ---------------------------------------------------------------- returns
    const stockBefore = await bal(vA1.id);
    const ret = await returns.receiveReturn({ orderId: mo.orderId, warehouseId: W.id, reference: `${RUN}-RMA`, reason: "wrong size", lines: [{ orderItemId: itemA.id, quantity: 2 }, { orderItemId: itemB.id, quantity: 1 }] }, admin.id);
    const tooMany = await expectError(() => returns.receiveReturn({ orderId: mo.orderId, warehouseId: W.id, lines: [{ orderItemId: itemC.id, quantity: 4 }] }, admin.id), "INVALID_QUANTITY");
    check("Return received: no stock change yet; returning more than shipped rejected", (await bal(vA1.id)).onHand === stockBefore.onHand && tooMany.hit);
    const retFull = (await prisma.return.findUnique({ where: { id: ret.id }, include: { items: true } }))!;
    const riA = retFull.items.find((i) => i.variantId === vA1.id)!;
    const riB = retFull.items.find((i) => i.variantId === vB1.id)!;
    const bBefore = await bal(vB1.id);
    await returns.inspectReturn(ret.id, { lines: [{ returnItemId: riA.id, condition: "SELLABLE", locationId: main.id }, { returnItemId: riB.id, condition: "DAMAGED", locationId: main.id }] }, admin.id);
    o = (await orders.getOrder(mo.orderId))!;
    const dmgRows = await prisma.inventoryTransaction.findMany({ where: { variantId: vB1.id, orderId: mo.orderId, type: { in: ["RETURN", "DAMAGE"] } } });
    check("Inspection: sellable A1 +2 on hand; damaged B1 booked in and written off (ledger RETURN + DAMAGE, on hand unchanged); returnedQty updated", (await bal(vA1.id)).onHand === stockBefore.onHand + 2 && (await bal(vB1.id)).onHand === bBefore.onHand && dmgRows.length === 2 && o.items.find((i) => i.sku === skuA1)!.returnedQty === 2 && o.items.find((i) => i.sku === skuB1)!.returnedQty === 1);
    const twice = await expectError(() => returns.inspectReturn(ret.id, { lines: [] }, admin.id), "BAD_STATUS");
    check("Inspecting the same return twice is rejected", twice.hit);

    // ---------------------------------------------------------------- ledger consistency
    for (const v of [vA1, vA2, vB1, vC1]) {
      const c = await inventory.verifyLedgerConsistency(v.id, W.id);
      check(`Ledger consistent for ${v.sku}`, c.consistent, JSON.stringify(c));
    }

    // ---------------------------------------------------------------- CSV: Shopify-style import
    const shopifyCsv = [
      "Name,Email,Financial Status,Paid at,Fulfillment Status,Currency,Subtotal,Shipping,Taxes,Total,Discount Code,Discount Amount,Shipping Method,Created at,Lineitem quantity,Lineitem name,Lineitem price,Lineitem sku,Lineitem requires shipping,Billing Name,Shipping Name,Shipping Street,Shipping Address1,Shipping Address2,Shipping Company,Shipping City,Shipping Zip,Shipping Province,Shipping Country,Shipping Phone,Notes,Tags,Risk Level,Source,Vendor,Id",
      `#${RUN}-S1,jane@example.com,paid,2026-09-01 10:00:00 +0000,unfulfilled,USD,40.00,5.00,3.20,48.20,,0.00,Standard,2026-09-01 10:00:00 +0000,2,P4 Widget,10.00,${skuA1},true,Jane Doe,Jane Doe,"12 Main St, Apt 4",12 Main St,Apt 4,,Austin,78701,TX,US,555-0100,Leave at door,vip,Low,web,P4 Vendor A,900001`,
      `#${RUN}-S1,,,,,,,,,,,,,,1,P4 Gadget,20.00,${skuB1},true,,,,,,,,,,,,,,,,,P4 Vendor B,900001`,
      `#${RUN}-S2,bob@example.com,pending,,unfulfilled,USD,5.00,0.00,0.00,5.00,,,Express,2026-09-02 09:30:00 +0000,1,P4 Client Box,5.00,${skuC1},true,Bob Roe,Bob Roe,,9 High St,,,Denver,80202,CO,US,,,,Low,web,P4 Client C,900002`,
    ].join("\n");
    const prev = await csv.previewOrderCsv(shopifyCsv);
    check("Shopify export detected; 2 orders, both valid; Shopify-only columns ignored", prev.format === "shopify-orders" && prev.summary.totalOrders === 2 && prev.summary.validOrders === 2 && prev.unknownColumns.includes("Risk Level") && prev.missingRequired.length === 0, JSON.stringify(prev.summary));
    const imp = await csv.executeOrderImport(prev, { defaultWarehouseId: W.id, reserve: true }, admin.id);
    const s1o = (await orders.getOrder(imp.created.find((c) => c.name === `#${RUN}-S1`)!.orderId))!;
    check("Shopify CSV import: multi-owner order with mapped address, totals, financial status paid→PAID, reserved", imp.created.length === 2 && s1o.items.length === 2 && new Set(s1o.items.map((i) => i.ownerId)).size === 2 && s1o.shipAddress1 === "12 Main St" && s1o.shipAddress2 === "Apt 4" && s1o.shipCity === "Austin" && s1o.customerEmail === "jane@example.com" && s1o.financialStatus === "PAID" && s1o.total?.toString() === "48.2" && s1o.tags === "vip" && s1o.items.every((i) => i.reservedQty === i.quantity) && s1o.source === "CSV_IMPORT" && s1o.sourceRef === `#${RUN}-S1`);

    // ---------------------------------------------------------------- CSV: validation errors + failed rows
    const badCsv = [
      "Name,Lineitem sku,Lineitem quantity,Lineitem price,Shipping Name",
      `#${RUN}-X1,NOPE-${RUN},1,1.00,Unknown Sku`,
      `#${RUN}-X2,${skuA1},abc,1.00,Bad Qty`,
      `#${RUN}-X3,${skuA1},2,1.00,Good Order`,
      `#${RUN}-X3,${skuB1},0,1.00,`,
      `#${RUN}-S1,${skuA1},1,1.00,Duplicate`,
      `,${skuA1},1,1.00,No Name`,
    ].join("\n");
    const bad = await csv.previewOrderCsv(badCsv);
    const g = (n: string) => bad.groups.find((x) => x.name === `#${RUN}-${n}`)!;
    check("Row-level errors: unknown SKU, invalid quantity, zero quantity poisons its order, duplicate order, missing Name", g("X1").errors.length > 0 && bad.rows.find((r) => r.name === `#${RUN}-X1`)!.errors[0].includes("Unknown SKU") && bad.rows.find((r) => r.name === `#${RUN}-X2`)!.errors[0].includes("Invalid Lineitem quantity") && g("X3").errors.length > 0 && bad.groups.find((x) => x.name === `#${RUN}-S1`)!.duplicate && bad.rows.find((r) => r.index === 7)!.errors[0].includes("Name"), JSON.stringify(bad.summary));
    check("Preview summary: 0 valid, 3 failed, 1 duplicate", bad.summary.validOrders === 0 && bad.summary.failedOrders === 3 && bad.summary.duplicateOrders === 1);
    const badImp = await csv.executeOrderImport(bad, { defaultWarehouseId: W.id, reserve: true }, admin.id);
    check("Importing the bad file creates nothing (no partial orders)", badImp.created.length === 0 && badImp.failed.length === 3 && badImp.duplicates.length === 1);
    const failedCsv = csv.failedRowsCsv(bad, badImp);
    const failedParsed = parseCsv(failedCsv);
    check("Failed-rows CSV: original columns + Error, includes the good line of the poisoned order, excludes nothing valid", failedParsed.headers.includes("Error") && failedParsed.rows.length === 6 && failedParsed.rows.every((r) => r.Error.length > 0) && failedParsed.rows.some((r) => r["Shipping Name"] === "Good Order"));
    const missing = await csv.previewOrderCsv("Order,SKU,Qty\nA,B,1");
    check("Missing required columns → format unknown, all rows fail", missing.format === "unknown" && missing.missingRequired.length === 3 && missing.summary.failedRows === 1);

    // ---------------------------------------------------------------- CSV: V3PL-style import
    const v3plCsv = ["Name,Lineitem sku,Lineitem quantity,V3PL Warehouse,V3PL Financial Status,V3PL Invoice Reference,V3PL Owner Code", `${RUN}-M1,${skuA1},2,${RUN}-W2,INVOICED,INV-77,${RUN}-A`, `${RUN}-M2,${skuA1},1,,PAID,,${RUN}-B`].join("\n");
    const vp = await csv.previewOrderCsv(v3plCsv);
    const vi = await csv.executeOrderImport(vp, { defaultWarehouseId: W.id, reserve: false }, admin.id);
    const m1 = (await orders.getOrder(vi.created[0].orderId))!;
    check("V3PL import: format v3pl-orders, warehouse by code, financial status + invoice honoured, owner-code mismatch rejected", vp.format === "v3pl-orders" && vi.created.length === 1 && vi.failed.length === 1 && vi.failed[0].name === `${RUN}-M2` && m1.warehouse?.code === `${RUN}-W2` && m1.financialStatus === "INVOICED" && m1.invoiceReference === "INV-77" && m1.items[0].reservedQty === 0);

    // ---------------------------------------------------------------- CSV: export + filters + round trip
    const exp = await csv.exportOrdersCsv({ status: "ALL", fulfillmentStatus: "ALL", shipmentStatus: "ALL", source: "CSV_IMPORT", ownerId: A.id });
    const expRows = parseCsv(exp.csv);
    const s1rows = expRows.rows.filter((r) => r.Name === `#${RUN}-S1`);
    check("Export: Shopify layout (header fields on first row only), V3PL columns present, Vendor = owner", s1rows.length === 2 && s1rows[0].Email === "jane@example.com" && s1rows[1].Email === "" && s1rows[0]["Financial Status"] === "paid" && s1rows[0]["V3PL Financial Status"] === "PAID" && s1rows[0]["V3PL Order Number"] === s1o.orderNumber && s1rows[1].Vendor === `P4 Vendor B ${RUN}` && expRows.headers.includes("V3PL Tracking Number"));
    check("Export owner filter: only orders containing Vendor A lines (M2 excluded, none of Vendor B only)", expRows.rows.every((r) => r.Name !== `${RUN}-M2`) && expRows.rows.some((r) => r.Name === `${RUN}-M1`));
    const expShipped = await csv.exportOrdersCsv({ status: "ALL", fulfillmentStatus: "FULFILLED", shipmentStatus: "ALL", source: "ALL", ownerId: A.id });
    check("Export fulfilment filter returns the delivered multi-owner order with tracking", parseCsv(expShipped.csv).rows.some((r) => r["V3PL Order Number"] === mo.orderNumber && r["V3PL Tracking Number"].length > 0));
    const rtText = exp.csv.replace(new RegExp(`#${RUN}-S`, "g"), `#${RUN}-RT`).replace(new RegExp(`${RUN}-M1`, "g"), `${RUN}-RTM1`);
    const rtPrev = await csv.previewOrderCsv(rtText);
    const rtImp = await csv.executeOrderImport(rtPrev, { defaultWarehouseId: W.id, reserve: false }, admin.id);
    const rtS1 = (await orders.getOrder(rtImp.created.find((c) => c.name === `#${RUN}-RT1`)!.orderId))!;
    check("Round trip: exported file re-imports (renamed) with same lines, quantities, address, totals, financial status; unrenamed order detected as duplicate", rtImp.created.length === 2 && rtImp.duplicates.length === 1 && rtImp.failed.length === 0 && rtS1.items.length === 2 && rtS1.items.find((i) => i.sku === skuA1)!.quantity === 2 && rtS1.shipAddress1 === "12 Main St" && rtS1.shipCity === "Austin" && rtS1.total?.toString() === "48.2" && rtS1.financialStatus === "PAID", JSON.stringify(rtImp.failed));

    // ---------------------------------------------------------------- import jobs
    const jobCsv = ["Name,Lineitem sku,Lineitem quantity", `${RUN}-J1,${skuC1},2`, `${RUN}-J2,BAD-${RUN},1`].join("\n");
    const { jobId, preview: jp } = await imports.createOrderImportPreview("test.csv", jobCsv, { defaultWarehouseId: W.id, reserve: true }, admin.id);
    created.jobIds.push(jobId);
    const outcome = await imports.confirmImportJob(jobId, admin.id);
    const job = (await imports.getImportJob(jobId))!;
    const reconfirm = await expectError(() => imports.confirmImportJob(jobId, admin.id), "BAD_STATUS");
    const report = await imports.failedRowsCsvForJob(jobId);
    check("Import job: preview stored, confirm creates 1 / fails 1, status COMPLETED, re-confirm rejected, failed-rows report available", jp.summary.validOrders === 1 && outcome.created.length === 1 && outcome.failed.length === 1 && job.status === "COMPLETED" && job.successCount === 1 && reconfirm.hit && !!report && parseCsv(report.csv).rows.length === 1);

    // ---------------------------------------------------------------- HTTP + portal isolation
    await trackOrders();
    const auth = firebaseAdminAuth();
    const uC = await users.createUserAccount({ name: "P4 Client C user", email: `${RUN.toLowerCase()}-c@example.test`, password: "E2eTestPass123", role: "THREEPL_CLIENT", ownerId: C.id, phone: null, notes: null }, admin.id);
    const uA = await users.createUserAccount({ name: "P4 Vendor A user", email: `${RUN.toLowerCase()}-a@example.test`, password: "E2eTestPass123", role: "VENDOR", ownerId: A.id, phone: null, notes: null }, admin.id);
    created.userIds.push(uC.id, uA.id);
    created.firebaseUids.push(uC.firebaseUid, uA.firebaseUid);
    async function sessionFor(uid: string, audience: "staff" | "portal") {
      const custom = await auth.createCustomToken(uid);
      const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${process.env.NEXT_PUBLIC_FIREBASE_API_KEY}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: custom, returnSecureToken: true }) });
      const { idToken } = await r.json();
      const res = await fetch(`${base}/api/auth/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken, audience }) });
      return (res.headers.get("set-cookie") ?? "").split(";")[0];
    }
    const get = (path: string, cookie: string) => fetch(`${base}${path}`, { redirect: "manual", headers: { Cookie: cookie } });
    const adminCookie = await sessionFor(admin.firebaseUid, "staff");
    for (const path of ["/admin/orders", "/admin/orders/new", `/admin/orders/${mo.orderId}`, "/admin/orders/export", "/admin/fulfillment", "/admin/imports", `/admin/imports/${jobId}`, "/admin"]) {
      const res = await get(path, adminCookie);
      check(`Admin GET ${path} → 200`, res.status === 200, String(res.status));
    }
    let res = await get(`/api/orders/export?status=ALL&source=CSV_IMPORT`, adminCookie);
    check("Export API returns CSV with order count header", res.status === 200 && (res.headers.get("content-type") ?? "").includes("text/csv") && Number(res.headers.get("x-order-count")) >= 3);
    res = await get(`/api/imports/${jobId}/failed-rows`, adminCookie);
    check("Failed-rows API returns CSV", res.status === 200 && (await res.text()).includes("Error"));

    const cCookie = await sessionFor(uC.firebaseUid, "portal");
    res = await get("/portal/3pl/orders", cCookie);
    let html = await res.text();
    check("3PL portal orders list shows orders with its lines (multi-owner order visible)", res.status === 200 && html.includes(mo.orderNumber));
    res = await get(`/portal/3pl/orders/${mo.orderId}`, cCookie);
    html = await res.text();
    check("3PL portal order detail shows only its own line (C1), not A1/B1, no totals", res.status === 200 && html.includes(skuC1) && !html.includes(skuA1) && !html.includes(skuB1) && !html.includes("Totals"));
    res = await get(`/portal/3pl/orders/${co.orderId}`, cCookie);
    check("3PL portal cannot open an order without its lines (404)", res.status === 404);
    res = await get("/portal/3pl/orders/new", cCookie);
    check("3PL portal new-order page renders", res.status === 200);
    const aCookie = await sessionFor(uA.firebaseUid, "portal");
    res = await get(`/api/orders/export?status=ALL`, aCookie);
    const aCsv = parseCsv(await res.text());
    check("Vendor portal export is scoped: contains A1 lines, never B1/C1", res.status === 200 && aCsv.rows.some((r) => r["Lineitem sku"] === skuA1) && aCsv.rows.every((r) => r["Lineitem sku"] !== skuB1 && r["Lineitem sku"] !== skuC1));
    res = await get("/admin/orders", aCookie);
    check("Vendor cannot open admin orders (redirected)", res.status === 307);
    await fetch(`${base}/api/auth/session`, { method: "DELETE", headers: { Cookie: adminCookie } });
  } finally {
    unregister();
    await trackOrders();
    const { firebaseAdminAuth } = await import("../src/lib/firebase/admin");
    for (const uid of created.firebaseUids) await firebaseAdminAuth().deleteUser(uid).catch(() => undefined);
    const orderIds = [...created.orderIds];
    await prisma.inventoryTransaction.deleteMany({ where: { OR: [{ orderId: { in: orderIds } }, { variant: { productId: { in: created.productIds } } }] } });
    await prisma.returnItem.deleteMany({ where: { return: { orderId: { in: orderIds } } } });
    await prisma.return.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.shipmentItem.deleteMany({ where: { shipment: { orderId: { in: orderIds } } } });
    await prisma.shipment.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.fulfillmentItem.deleteMany({ where: { fulfillment: { orderId: { in: orderIds } } } });
    await prisma.fulfillment.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.orderEvent.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await prisma.importJob.deleteMany({ where: { id: { in: created.jobIds } } });
    await prisma.inventoryLevel.deleteMany({ where: { variant: { productId: { in: created.productIds } } } });
    await prisma.inventoryBalance.deleteMany({ where: { variant: { productId: { in: created.productIds } } } });
    await prisma.receivingItem.deleteMany({ where: { variant: { productId: { in: created.productIds } } } });
    await prisma.receivingRecord.deleteMany({ where: { ownerId: { in: created.ownerIds } } });
    await prisma.productVariant.deleteMany({ where: { productId: { in: created.productIds } } });
    await prisma.product.deleteMany({ where: { id: { in: created.productIds } } });
    await prisma.location.deleteMany({ where: { warehouseId: { in: created.warehouseIds } } });
    await prisma.warehouse.deleteMany({ where: { id: { in: created.warehouseIds } } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: [...created.ownerIds, ...created.productIds, ...created.warehouseIds, ...created.userIds, ...orderIds, ...created.jobIds] } }, { entityType: { in: ["ReceivingRecord", "Location", "Shipment", "Return"] }, createdAt: { gte: new Date(Date.now() - 30 * 60 * 1000) } }] } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: created.userIds } } });
    await prisma.owner.deleteMany({ where: { id: { in: created.ownerIds } } });
    await prisma.$disconnect();
    console.log(`Cleanup done (${orderIds.length} orders removed).`);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
