/**
 * Phase 5 end-to-end check: portal dashboards, reports (activity/orders/shipments/returns/
 * inventory), report filters, CSV export permissions and content, pagination, role-based
 * access, empty states, deactivated owners. Cleans up everything it creates.
 *
 * Usage: npm run e2e:phase5 -- http://localhost:3100 vendor3pl@gmail.com
 */
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });
loadEnv();

const [base = "http://localhost:3100", adminEmail = "vendor3pl@gmail.com"] = process.argv.slice(2);
const RUN = `p5${Date.now().toString(36)}`.toUpperCase();
const results: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
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
  const returns = await import("../src/server/services/returns");
  const reports = await import("../src/server/services/reports");
  const { parseCsv } = await import("../src/lib/csv");

  const admin = await prisma.user.findFirstOrThrow({ where: { email: adminEmail, role: "ADMIN" } });
  const created = { ownerIds: [] as string[], productIds: [] as string[], warehouseIds: [] as string[], userIds: [] as string[], firebaseUids: [] as string[], orderIds: new Set<string>() };
  const ownerInput = (code: string, businessName: string) => ({ code, businessName, contactName: "Contact", email: null, phone: null, addressLine1: null, addressLine2: null, city: "Austin", state: null, postalCode: null, country: "US", notes: null });
  const whInput = (code: string, name: string) => ({ code, name, addressLine1: null, addressLine2: null, city: "Dallas", state: null, postalCode: null, country: "US", notes: null });
  const variantInput = (sku: string) => ({ sku, name: null, barcode: null, price: "9.00", cost: null, status: "ACTIVE" as const });

  try {
    // ---------------------------------------------------------------- setup
    const A = await owners.createOwner("VENDOR", ownerInput(`${RUN}-A`, `P5 Vendor A ${RUN}`), admin.id);
    const B = await owners.createOwner("VENDOR", ownerInput(`${RUN}-B`, `P5 Vendor B ${RUN}`), admin.id);
    const C = await owners.createOwner("THREEPL_CLIENT", ownerInput(`${RUN}-C`, `P5 Client C ${RUN}`), admin.id);
    const E = await owners.createOwner("VENDOR", ownerInput(`${RUN}-E`, `P5 Empty Vendor ${RUN}`), admin.id);
    created.ownerIds.push(A.id, B.id, C.id, E.id);
    const W = await warehouses.createWarehouse(whInput(`${RUN}-W`, "P5 Warehouse"), admin.id);
    created.warehouseIds.push(W.id);
    const main = (await warehouses.getDefaultLocation(W.id))!;
    const [skuA1, skuA2, skuB1, skuC1] = [`${RUN}-A1`, `${RUN}-A2`, `${RUN}-B1`, `${RUN}-C1`];
    const pA = await products.createProduct({ ownerId: A.id, name: "P5 Widget", category: null, description: null, notes: null, status: "ACTIVE", variants: [variantInput(skuA1), variantInput(skuA2)] }, admin.id);
    const pB = await products.createProduct({ ownerId: B.id, name: "P5 Gadget", category: null, description: null, notes: null, status: "ACTIVE", variants: [variantInput(skuB1)] }, admin.id);
    const pC = await products.createProduct({ ownerId: C.id, name: "P5 Box", category: null, description: null, notes: null, status: "ACTIVE", variants: [variantInput(skuC1)] }, admin.id);
    created.productIds.push(pA.id, pB.id, pC.id);
    const vA1 = pA.variants.find((v) => v.sku === skuA1)!;
    const vA2 = pA.variants.find((v) => v.sku === skuA2)!;
    const vB1 = pB.variants[0];
    const vC1 = pC.variants[0];
    await receiving.createReceiving({ ownerId: A.id, warehouseId: W.id, reference: `${RUN}-RA`, notes: null, lines: [{ variantId: vA1.id, locationId: main.id, quantity: 100 }, { variantId: vA2.id, locationId: main.id, quantity: 3 }] }, admin.id);
    await receiving.createReceiving({ ownerId: B.id, warehouseId: W.id, reference: `${RUN}-RB`, notes: null, lines: [{ variantId: vB1.id, locationId: main.id, quantity: 40 }] }, admin.id);
    await receiving.createReceiving({ ownerId: C.id, warehouseId: W.id, reference: `${RUN}-RC`, notes: null, lines: [{ variantId: vC1.id, locationId: main.id, quantity: 20 }] }, admin.id);
    await inventory.adjustStock({ userId: admin.id, variantId: vA1.id, warehouseId: W.id, locationId: main.id, kind: "DAMAGE", quantity: 2, reason: "p5 test damage" });
    await inventory.adjustStock({ userId: admin.id, variantId: vA1.id, warehouseId: W.id, locationId: main.id, kind: "MISSING", quantity: 1, reason: "p5 test missing" });

    // Orders: multi-owner (A+B+C) shipped in full; A-only open; C-only cancelled.
    const mo = await orders.createOrder({ source: "MANUAL", warehouseId: W.id, reserve: true, shipName: "P5 Multi", shipCity: "Austin", shipCountry: "US", lines: [{ variantId: vA1.id, quantity: 10 }, { variantId: vB1.id, quantity: 4 }, { variantId: vC1.id, quantity: 2 }] }, admin.id);
    const f = await fulfillment.startPicking({ orderId: mo.orderId, warehouseId: W.id }, admin.id);
    const ship = await fulfillment.shipFulfillment(f.id, { carrier: "UPS", trackingNumber: `${RUN}-TRK` }, admin.id);
    await fulfillment.updateShipmentStatus(ship.id, "DELIVERED", admin.id);
    const open = await orders.createOrder({ source: "MANUAL", warehouseId: W.id, reserve: true, shipName: "P5 Open", lines: [{ variantId: vA1.id, quantity: 5 }] }, admin.id);
    const canc = await orders.createOrder({ source: "MANUAL", warehouseId: W.id, reserve: true, shipName: "P5 Cancel", lines: [{ variantId: vC1.id, quantity: 1 }] }, admin.id);
    await orders.cancelOrder(canc.orderId, "p5", admin.id);
    const moFull = (await orders.getOrder(mo.orderId))!;
    const itemA = moFull.items.find((i) => i.sku === skuA1)!;
    const ret = await returns.receiveReturn({ orderId: mo.orderId, warehouseId: W.id, reference: `${RUN}-RMA`, reason: "size", lines: [{ orderItemId: itemA.id, quantity: 3 }] }, admin.id);
    const retItem = (await prisma.returnItem.findFirstOrThrow({ where: { returnId: ret.id } })).id;
    await returns.inspectReturn(ret.id, { lines: [{ returnItemId: retItem, condition: "DAMAGED", locationId: main.id }] }, admin.id);
    for (const o of [mo, open, canc]) created.orderIds.add(o.orderId);

    // ---------------------------------------------------------------- service-level reports
    const dashA = await reports.portalDashboard(A.id);
    check("Vendor A dashboard figures: 2 SKUs, on hand 100−2−1−10+3−3=87, reserved 5, shipped 10, received 100+3, damaged+missing 2+1+3", dashA.skuCount === 2 && dashA.stock.onHand === 87 + 3 && dashA.stock.reserved === 5 && dashA.shippedUnits30d === 10 && dashA.receivedUnits30d === 103 && dashA.lostUnits30d === 6, JSON.stringify({ onHand: dashA.stock.onHand, reserved: dashA.stock.reserved, shipped: dashA.shippedUnits30d, received: dashA.receivedUnits30d, lost: dashA.lostUnits30d }));
    check("Vendor A dashboard: 1 open order, 1 warehouse, recent orders only include A's orders", dashA.counters.open === 1 && dashA.byWarehouse.length === 1 && dashA.byWarehouse[0].code === `${RUN}-W` && dashA.recentOrders.every((o) => o.items.length > 0) && !dashA.recentOrders.some((o) => o.id === canc.orderId));
    const dashE = await reports.portalDashboard(E.id);
    check("Empty owner dashboard returns zeros, no orders, no movements", dashE.skuCount === 0 && dashE.stock.onHand === 0 && dashE.recentOrders.length === 0 && dashE.recentMovements.length === 0 && dashE.byWarehouse.length === 0);

    const actA = await reports.skuActivityReport({ ownerId: A.id });
    const rowA1 = actA.find((r) => r.sku === skuA1)!;
    check("SKU activity (A): only A's SKUs; A1 received 100, shipped 10, returned 3, damaged 2+3, missing 1, on hand 87", actA.length === 2 && actA.every((r) => r.ownerCode === `${RUN}-A`) && rowA1.received === 100 && rowA1.shipped === 10 && rowA1.returned === 3 && rowA1.damaged === 5 && rowA1.missing === 1 && rowA1.onHand === 87 && rowA1.reserved === 5 && rowA1.available === 82, JSON.stringify(rowA1));
    const actFuture = await reports.skuActivityReport({ ownerId: A.id, from: new Date(Date.now() + 86_400_000) });
    check("Date filter: future period has zero movements but still current stock", actFuture.every((r) => r.received === 0 && r.shipped === 0) && actFuture.find((r) => r.sku === skuA1)!.onHand === 87);
    const actAll = await reports.skuActivityReport({});
    check("Admin unscoped activity includes all three owners", [skuA1, skuB1, skuC1].every((s) => actAll.some((r) => r.sku === s)));
    const actOtherWh = await reports.skuActivityReport({ ownerId: A.id, warehouseId: "nonexistent" });
    check("Warehouse filter with no matches yields zero stock and movements", actOtherWh.every((r) => r.onHand === 0 && r.received === 0));

    const osA = await reports.ordersSummaryReport({ ownerId: A.id });
    check("Orders summary (A): 2 orders (multi + open), units ordered 15, shipped 10, returned 3, reserved 5; C's cancelled order excluded", osA.totalOrders === 2 && osA.units.ordered === 15 && osA.units.shipped === 10 && osA.units.returned === 3 && osA.units.reserved === 5 && (osA.byStatus.CANCELLED ?? 0) === 0, JSON.stringify(osA));
    const osC = await reports.ordersSummaryReport({ ownerId: C.id });
    check("Orders summary (C): multi + cancelled = 2 orders, 1 cancelled, units ordered 3 (only C's lines)", osC.totalOrders === 2 && osC.byStatus.CANCELLED === 1 && osC.units.ordered === 3);
    const shA = await reports.shipmentsReport({ ownerId: A.id });
    check("Shipments report (A): one shipment, items filtered to A's SKU only", shA.total === 1 && shA.items[0].items.length === 1 && shA.items[0].items[0].orderItem.sku === skuA1 && shA.items[0].trackingNumber === `${RUN}-TRK`);
    const shB = await reports.shipmentsReport({ ownerId: B.id, status: "DELIVERED" });
    const shBnone = await reports.shipmentsReport({ ownerId: B.id, status: "IN_TRANSIT" });
    check("Shipments status filter works for B (delivered=1, in transit=0)", shB.total === 1 && shBnone.total === 0);
    const rtA = await reports.returnsReport({ ownerId: A.id });
    const rtB = await reports.returnsReport({ ownerId: B.id });
    check("Returns report scoped: A sees its damaged return, B sees none", rtA.total === 1 && rtA.items[0].items[0].condition === "DAMAGED" && rtB.total === 0);
    const csvA = parseCsv(reports.skuActivityCsv(actA, false));
    const csvAll = parseCsv(reports.skuActivityCsv(actAll, true));
    check("Activity CSV: portal variant has no Owner column; admin variant has it", !csvA.headers.includes("Owner") && csvAll.headers.includes("Owner") && csvA.rows.length === 2);
    const invCsv = parseCsv(await reports.inventorySnapshotCsv({ ownerId: A.id }, false));
    check("Inventory snapshot CSV (A): rows per SKU × warehouse with available", invCsv.rows.length === 2 && invCsv.rows.find((r) => r.SKU === skuA1)!.Available === "82");

    // ---------------------------------------------------------------- HTTP: portals, admin, permissions
    const auth = firebaseAdminAuth();
    const uA = await users.createUserAccount({ name: "P5 Vendor A", email: `${RUN.toLowerCase()}-a@example.test`, password: "E2eTestPass123", role: "VENDOR", ownerId: A.id, phone: null, notes: null }, admin.id);
    const uC = await users.createUserAccount({ name: "P5 Client C", email: `${RUN.toLowerCase()}-c@example.test`, password: "E2eTestPass123", role: "THREEPL_CLIENT", ownerId: C.id, phone: null, notes: null }, admin.id);
    const uE = await users.createUserAccount({ name: "P5 Empty", email: `${RUN.toLowerCase()}-e@example.test`, password: "E2eTestPass123", role: "VENDOR", ownerId: E.id, phone: null, notes: null }, admin.id);
    const uW = await users.createUserAccount({ name: "P5 Warehouse", email: `${RUN.toLowerCase()}-w@example.test`, password: "E2eTestPass123", role: "WAREHOUSE", ownerId: null, phone: null, notes: null }, admin.id);
    for (const u of [uA, uC, uE, uW]) {
      created.userIds.push(u.id);
      created.firebaseUids.push(u.firebaseUid);
    }
    async function sessionFor(uid: string, audience: "staff" | "portal") {
      const custom = await auth.createCustomToken(uid);
      const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${process.env.NEXT_PUBLIC_FIREBASE_API_KEY}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: custom, returnSecureToken: true }) });
      const { idToken } = await r.json();
      const res = await fetch(`${base}/api/auth/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken, audience }) });
      return (res.headers.get("set-cookie") ?? "").split(";")[0];
    }
    const get = (path: string, cookie: string) => fetch(`${base}${path}`, { redirect: "manual", headers: { Cookie: cookie } });
    const loc = (res: Response) => new URL(res.headers.get("location") ?? "/", base).pathname;
  const text = (h: string) => h.replace(/<!--[\s\S]*?-->/g, "");

    const aCookie = await sessionFor(uA.firebaseUid, "portal");
    let res = await get("/portal/vendor", aCookie);
    let html = await res.text();
    check("Vendor dashboard renders with business name, stock tiles and recent order; no other owner", res.status === 200 && html.includes(A.businessName) && html.includes("Units on hand") && html.includes(moFull.orderNumber) && !html.includes(B.businessName) && !html.includes(skuB1));
    for (const p of ["/portal/vendor/reports", "/portal/vendor/reports?report=orders", "/portal/vendor/reports?report=inventory", "/portal/vendor/shipments", "/portal/vendor/returns", "/portal/vendor/products", "/portal/vendor/inventory", "/portal/vendor/orders"]) {
      res = await get(p, aCookie);
      check(`Vendor GET ${p} → 200`, res.status === 200, String(res.status));
    }
    res = await get("/portal/vendor/reports?report=activity", aCookie);
    html = await res.text();
    check("Vendor activity report shows A's SKUs only (no B/C SKUs, no Owner column)", html.includes(skuA1) && html.includes(skuA2) && !html.includes(skuB1) && !html.includes(skuC1) && !html.includes(">Owner<"));
    res = await get(`/portal/vendor/reports?report=activity&ownerId=${B.id}`, aCookie);
    html = await res.text();
    check("Vendor cannot widen scope with ownerId in the URL", res.status === 200 && !html.includes(skuB1) && html.includes(skuA1));
    res = await get("/portal/vendor/shipments", aCookie);
    html = await res.text();
    check("Vendor shipments page shows the delivered shipment with A's line only", html.includes(`${RUN}-TRK`) && html.includes(skuA1) && !html.includes(skuB1));
    res = await get("/portal/vendor/returns", aCookie);
    html = await res.text();
    check("Vendor returns page shows the damaged return", html.includes(`${RUN}-RMA`) && html.includes("damaged"));

    // CSV export permissions/content
    res = await get(`/api/reports/activity?ownerId=${B.id}`, aCookie);
    let csv = parseCsv(await res.text());
    check("Report CSV API for vendor: scoped to A even with ownerId=B, no Owner column", res.status === 200 && csv.rows.every((r) => r.SKU.startsWith(`${RUN}-A`)) && !csv.headers.includes("Owner") && csv.rows.length === 2);
    res = await get(`/api/reports/orders`, aCookie);
    csv = parseCsv(await res.text());
    check("Orders report CSV for vendor uses the Shopify-compatible layout and only A's lines", res.status === 200 && csv.headers.includes("Lineitem sku") && csv.headers.includes("V3PL Order Number") && csv.rows.every((r) => r["Lineitem sku"].startsWith(`${RUN}-A`)) && csv.rows.length === 2);
    res = await get(`/api/reports/shipments`, aCookie);
    csv = parseCsv(await res.text());
    check("Shipments CSV for vendor: one row (A's line), tracking present", csv.rows.length === 1 && csv.rows[0]["Tracking Number"] === `${RUN}-TRK` && !csv.headers.includes("Owner"));
    res = await get(`/api/reports/bogus`, aCookie);
    check("Unknown report → 404", res.status === 404);
    res = await fetch(`${base}/api/reports/activity`, { redirect: "manual" });
    check("Report CSV without session → 401", res.status === 401);

    // 3PL portal
    const cCookie = await sessionFor(uC.firebaseUid, "portal");
    res = await get("/portal/3pl", cCookie);
    html = await res.text();
    check("3PL dashboard renders with New order button and only C's data", res.status === 200 && html.includes(C.businessName) && html.includes("New order") && !html.includes(skuA1));
    res = await get("/portal/3pl/reports?report=orders", cCookie);
    html = await res.text();
    check("3PL orders summary shows 2 orders incl. 1 cancelled", res.status === 200 && html.includes("Cancelled"));
    res = await get("/portal/3pl/shipments", cCookie);
    html = await res.text();
    check("3PL shipments page shows the shipment with C's line only", res.status === 200 && html.includes(skuC1) && !html.includes(skuA1) && !html.includes(skuB1));

    // Empty owner
    const eCookie = await sessionFor(uE.firebaseUid, "portal");
    res = await get("/portal/vendor", eCookie);
    html = await res.text();
    check("Empty vendor dashboard shows friendly setup message and zero tiles", res.status === 200 && html.includes("Your account is ready") && html.includes("No orders yet"));
    res = await get("/portal/vendor/reports", eCookie);
    html = await res.text();
    check("Empty vendor report shows empty state", res.status === 200 && html.includes("No SKUs to report"));
    res = await get("/portal/vendor/reports?report=shipments", eCookie);
    html = await res.text();
    check("Empty vendor shipments report shows empty state", res.status === 200 && html.includes("No shipments match"));

    // Role-based access
    const wCookie = await sessionFor(uW.firebaseUid, "staff");
    res = await get("/admin/reports", wCookie);
    check("Warehouse role blocked from admin reports (ADMIN only, hard 307 redirect)", res.status === 307 && loc(res) === "/admin", `${res.status} ${res.headers.get("location") ?? ""}`);
    res = await get(`/api/reports/activity`, wCookie);
    csv = parseCsv(await res.text());
    check("Warehouse staff report CSV allowed (staff) and unscoped with Owner column", res.status === 200 && csv.headers.includes("Owner"));
    res = await get("/admin/reports", aCookie);
    check("Vendor blocked from admin reports", res.status === 307);
    const adminCookie = await sessionFor(admin.firebaseUid, "staff");
    res = await get("/admin/reports", adminCookie);
    html = await res.text();
    check("Admin reports page renders with owner filter and all owners' SKUs", res.status === 200 && html.includes(skuA1) && html.includes(skuB1) && html.includes(skuC1) && html.includes("Vendor / 3PL client"));
    res = await get(`/admin/reports?report=activity&ownerId=${B.id}`, adminCookie);
    html = await res.text();
    check("Admin owner filter narrows to B", html.includes(skuB1) && !html.includes(skuA1));
    res = await get(`/api/reports/activity?ownerId=${C.id}`, adminCookie);
    csv = parseCsv(await res.text());
    check("Admin report CSV honours ownerId filter", csv.rows.length === 1 && csv.rows[0].SKU === skuC1);
    res = await get(`/api/reports/shipments?from=2099-01-01`, adminCookie);
    csv = parseCsv(await res.text());
    check("Admin shipments CSV with future from-date is empty", csv.rows.length === 0);

    // Pagination: movements page 2 for A (create >50 movements)
    for (let i = 0; i < 52; i++) await inventory.adjustStock({ userId: admin.id, variantId: vA2.id, warehouseId: W.id, locationId: main.id, kind: "ADJUSTMENT_IN", quantity: 1, reason: `p5 pagination ${i}` });
    res = await get("/portal/vendor/inventory", aCookie);
    html = await res.text();
    const page2 = await get("/portal/vendor/inventory?page=2", aCookie);
    const html2 = await page2.text();
    check("Pagination: vendor history page 1 shows 'Page 1 of 2' and page 2 renders", text(html).includes("Page 1 of 2") && page2.status === 200 && text(html2).includes("Page 2 of 2"), `${text(html).match(/Page \d+ of \d+/)?.[0]} / ${text(html2).match(/Page \d+ of \d+/)?.[0]}`);

    // Deactivated owner lock-out on dashboard
    await owners.setOwnerStatus(A.id, "VENDOR", "INACTIVE", admin.id);
    res = await get("/portal/vendor", aCookie);
    check("Deactivated owner: dashboard redirects to login", res.status === 307 && loc(res) === "/user/login");
    res = await get("/api/reports/activity", aCookie);
    check("Deactivated owner: report CSV API → 401", res.status === 401);
    await owners.setOwnerStatus(A.id, "VENDOR", "ACTIVE", admin.id);

    // Loading/error/not-found boundaries exist as routes
    res = await get("/portal/vendor/orders/does-not-exist", aCookie);
    html = await res.text();
    check("Portal not-found page for unknown order (hard 404 with friendly message)", res.status === 404 && html.includes("find that"), String(res.status));
    await fetch(`${base}/api/auth/session`, { method: "DELETE", headers: { Cookie: adminCookie } });
  } finally {
    const { firebaseAdminAuth } = await import("../src/lib/firebase/admin");
    for (const uid of created.firebaseUids) await firebaseAdminAuth().deleteUser(uid).catch(() => undefined);
    const all = await prisma.order.findMany({ where: { items: { some: { ownerId: { in: created.ownerIds } } } }, select: { id: true } });
    all.forEach((o) => created.orderIds.add(o.id));
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
    await prisma.inventoryLevel.deleteMany({ where: { variant: { productId: { in: created.productIds } } } });
    await prisma.inventoryBalance.deleteMany({ where: { variant: { productId: { in: created.productIds } } } });
    await prisma.receivingItem.deleteMany({ where: { variant: { productId: { in: created.productIds } } } });
    await prisma.receivingRecord.deleteMany({ where: { ownerId: { in: created.ownerIds } } });
    await prisma.productVariant.deleteMany({ where: { productId: { in: created.productIds } } });
    await prisma.product.deleteMany({ where: { id: { in: created.productIds } } });
    await prisma.location.deleteMany({ where: { warehouseId: { in: created.warehouseIds } } });
    await prisma.warehouse.deleteMany({ where: { id: { in: created.warehouseIds } } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: [...created.ownerIds, ...created.productIds, ...created.warehouseIds, ...created.userIds, ...orderIds] } }, { entityType: { in: ["ReceivingRecord", "Location", "Shipment", "Return"] }, createdAt: { gte: new Date(Date.now() - 30 * 60 * 1000) } }] } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: created.userIds } } });
    await prisma.owner.deleteMany({ where: { id: { in: created.ownerIds } } });
    await prisma.$disconnect();
    console.log("Cleanup done.");
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
