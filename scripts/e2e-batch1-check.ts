/**
 * Batch 1 regression check (QA-MASTER bugs PRC-04/UI-08, UI-07, CSV-05, ORD-07, UI-03/04, UI-05, UI-06):
 * - SKU search returns the saved price; order lines default to it (helper + service)
 * - Dropdown placement helper never clips (portal + fixed positioning)
 * - Official Shopify product export with image-only rows imports without false errors
 * - Orders list defaults to all orders; completed orders stay discoverable
 * - Portal navigation has no scroll container; global navigation progress bar is mounted
 * - 3PL SKU search: the search action never redirects a portal user away (server-action HTTP call)
 *
 * HTTP checks need a running production build (`npm run build && npx next start -p 3100`) and a working
 * Firebase Admin credential (sessions are minted with custom tokens). When Firebase is unavailable the
 * HTTP checks are reported as SKIPPED — never as passed. The server-action check resolves the action id
 * from the chunks the server serves, so it always matches the running build (ids change per build).
 *
 * Usage: npm run e2e:batch1 -- http://localhost:3100 vendor3pl@gmail.com
 */
import { readFileSync } from "node:fs";
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });
loadEnv();

const [base = "http://localhost:3100", adminEmail = "vendor3pl@gmail.com"] = process.argv.slice(2);
const RUN = `b1${Date.now().toString(36)}`.toUpperCase();
const results: { name: string; ok: boolean; skipped?: boolean }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const skip = (name: string, why: string) => {
  results.push({ name, ok: true, skipped: true });
  console.log(`SKIP  ${name} — ${why}`);
};

const actionRef = (exportName: string) => new RegExp(`createServerReference\\)\\("([0-9a-f]+)"[^)]*"${exportName}"\\)`);

/**
 * Server action id of `exportName` as registered in the build the server is actually serving: scan the
 * client chunks referenced by the page HTML (fetched from the server), not the local `.next` folder.
 * Action ids are per build — a stale local build or a server still holding an older manifest makes the
 * server answer 404 "Server action not found." for a locally scraped id.
 */
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

/** Build id of the running server (from the served HTML) and of the local `.next` folder, for diagnostics. */
function buildIds(html: string): { served: string | null; local: string | null } {
  const served = html.match(/\/_next\/static\/([^/"']+)\/_buildManifest\.js/)?.[1] ?? html.match(/"b":"([A-Za-z0-9_-]+)"/)?.[1] ?? null;
  let local: string | null = null;
  try {
    local = readFileSync(".next/BUILD_ID", "utf8").trim();
  } catch {
    /* no local build */
  }
  return { served, local };
}

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const owners = await import("../src/server/services/owners");
  const users = await import("../src/server/services/users");
  const products = await import("../src/server/services/products");
  const productCsv = await import("../src/server/services/product-csv");
  const warehouses = await import("../src/server/services/warehouses");
  const receiving = await import("../src/server/services/receiving");
  const orders = await import("../src/server/services/orders");
  const fulfillment = await import("../src/server/services/fulfillment");
  const { productFormSchema } = await import("../src/lib/validation/products");
  const { orderListQuerySchema } = await import("../src/lib/validation/orders");
  const { variantSearchScope } = await import("../src/lib/variant-search-scope");
  const { placeDropdown } = await import("../src/lib/dropdown-position");
  const { toCsv } = await import("../src/lib/csv");

  const admin = await prisma.user.findFirstOrThrow({ where: { email: adminEmail, role: "ADMIN" } });
  const created = { ownerIds: [] as string[], warehouseIds: [] as string[], userIds: [] as string[], firebaseUids: [] as string[], orderIds: new Set<string>() };
  const ownerInput = (code: string, businessName: string) => ({ code, businessName, contactName: "Contact", email: null, phone: null, addressLine1: null, addressLine2: null, city: "Austin", state: null, postalCode: null, country: "US", notes: null });
  const sku = (s: string) => `${RUN}-${s}`.toUpperCase();

  try {
    const A = await owners.createOwner("VENDOR", ownerInput(`${RUN}-A`, `B1 Vendor ${RUN}`), admin.id);
    const C = await owners.createOwner("THREEPL_CLIENT", ownerInput(`${RUN}-C`, `B1 Client ${RUN}`), admin.id);
    created.ownerIds.push(A.id, C.id);
    const W = await warehouses.createWarehouse({ code: `${RUN}-W`, name: "B1 Warehouse", addressLine1: null, addressLine2: null, city: "Dallas", state: null, postalCode: null, country: "US", notes: null }, admin.id);
    created.warehouseIds.push(W.id);
    const main = (await warehouses.getDefaultLocation(W.id))!;
    const pA = await products.createProduct(productFormSchema.parse({ ownerId: A.id, name: `B1 Widget ${RUN}`, status: "ACTIVE", variants: [{ sku: sku("A1"), price: "12.50", status: "ACTIVE" }, { sku: sku("A2"), price: null, status: "ACTIVE" }] }), admin.id);
    const pC = await products.createProduct(productFormSchema.parse({ ownerId: C.id, name: `B1 Client Box ${RUN}`, status: "ACTIVE", variants: [{ sku: sku("C1"), price: "4.00", status: "ACTIVE" }] }), admin.id);
    const vA1 = pA.variants.find((v) => v.sku === sku("A1"))!;
    const vC1 = pC.variants[0];
    await receiving.createReceiving({ ownerId: A.id, warehouseId: W.id, reference: `${RUN}-R`, notes: null, lines: [{ variantId: vA1.id, locationId: main.id, quantity: 10 }] }, admin.id);
    await receiving.createReceiving({ ownerId: C.id, warehouseId: W.id, reference: `${RUN}-RC`, notes: null, lines: [{ variantId: vC1.id, locationId: main.id, quantity: 5 }] }, admin.id);

    // ------------------------------------------------------------ 1. SKU search returns the saved price
    const found = await products.searchVariants(sku("A"), { ownerId: A.id });
    const a1 = found.find((v) => v.sku === sku("A1"));
    const a2 = found.find((v) => v.sku === sku("A2"));
    check("searchVariants returns price + currency for each match (12.50 / null)", !!a1 && a1.price?.toString() === "12.5" && a1.currency === "USD" && !!a2 && a2.price === null);
    const o = await orders.createOrder({ source: "MANUAL", warehouseId: W.id, reserve: false, shipName: "B1 Price", lines: [{ variantId: vA1.id, quantity: 1 }] }, admin.id);
    created.orderIds.add(o.orderId);
    const line = await prisma.orderItem.findFirstOrThrow({ where: { orderId: o.orderId } });
    check("Order line without a typed price falls back to the SKU's saved price (server side)", line.unitPrice?.toString() === "12.5");

    // ------------------------------------------------------------ 2. search scope (root cause of the 3PL disappearing screen)
    const staff = variantSearchScope({ role: "ADMIN", ownerId: null }, A.id);
    const staffAny = variantSearchScope({ role: "WAREHOUSE", ownerId: null });
    const portal = variantSearchScope({ role: "THREEPL_CLIENT", ownerId: C.id }, A.id);
    const vendor = variantSearchScope({ role: "VENDOR", ownerId: A.id });
    const anon = variantSearchScope(null, A.id);
    const broken = variantSearchScope({ role: "VENDOR", ownerId: null });
    check(
      "variantSearchScope: staff honour the filter, portal users are forced to their own owner (client id ignored), anonymous/ownerless refused without redirect",
      staff.ok && staff.ownerId === A.id && staffAny.ok && staffAny.ownerId === undefined && portal.ok && portal.ownerId === C.id && vendor.ok && vendor.ownerId === A.id && !anon.ok && anon.reason === "unauthenticated" && !broken.ok && broken.reason === "forbidden",
    );
    const scoped = await products.searchVariants(RUN, { ownerId: C.id });
    check("Portal-scoped search returns only the client's SKUs", scoped.length === 1 && scoped[0].sku === sku("C1"));

    // ------------------------------------------------------------ 3. dropdown placement (never clipped)
    const below = placeDropdown({ top: 100, bottom: 132, left: 40, width: 320 }, { width: 1280, height: 800 });
    const above = placeDropdown({ top: 740, bottom: 772, left: 40, width: 320 }, { width: 1280, height: 800 });
    const narrow = placeDropdown({ top: 100, bottom: 132, left: 1200, width: 100 }, { width: 1280, height: 800 });
    check("placeDropdown: opens below with room, flips above near the bottom, keeps a minimum width inside the viewport", below.direction === "below" && below.top === 136 && below.maxHeight === 256 && above.direction === "above" && above.top + above.maxHeight <= 740 && narrow.width === 160 && narrow.left + narrow.width <= 1280);

    // ------------------------------------------------------------ 4. official Shopify product export with image rows
    const H = `${RUN.toLowerCase()}-hoodie`;
    const shopifyHeaders = ["Handle", "Title", "Body (HTML)", "Vendor", "Product Category", "Type", "Tags", "Published", "Option1 Name", "Option1 Value", "Option1 Linked To", "Option2 Name", "Option2 Value", "Option2 Linked To", "Option3 Name", "Option3 Value", "Option3 Linked To", "Variant SKU", "Variant Grams", "Variant Inventory Tracker", "Variant Inventory Qty", "Variant Inventory Policy", "Variant Fulfillment Service", "Variant Price", "Variant Compare At Price", "Variant Requires Shipping", "Variant Taxable", "Variant Barcode", "Image Src", "Image Position", "Image Alt Text", "Gift Card", "SEO Title", "SEO Description", "Google Shopping / Google Product Category", "Variant Image", "Variant Weight Unit", "Variant Tax Code", "Cost per item", "Included / United States", "Price / United States", "Compare At Price / United States", "Included / International", "Price / International", "Compare At Price / International", "Status"];
    const row = (o: Record<string, string>) => Object.fromEntries(shopifyHeaders.map((h) => [h, o[h] ?? ""]));
    const shopifyExport = toCsv(shopifyHeaders, [
      row({ Handle: H, Title: `B1 Hoodie ${RUN}`, "Body (HTML)": "<p>Cozy</p>", Vendor: "B1 Brand", Type: "Apparel", Published: "TRUE", "Option1 Name": "Color", "Option1 Value": "Black", "Option2 Name": "Size", "Option2 Value": "S", "Variant SKU": sku("HD-BLK-S"), "Variant Grams": "500", "Variant Inventory Tracker": "shopify", "Variant Inventory Qty": "3", "Variant Inventory Policy": "deny", "Variant Fulfillment Service": "manual", "Variant Price": "45.00", "Variant Requires Shipping": "TRUE", "Variant Taxable": "TRUE", "Image Src": "https://cdn.shopify.com/s/files/1/hoodie-1.jpg", "Image Position": "1", "Image Alt Text": "Front", "Gift Card": "FALSE", "Variant Weight Unit": "g", "Cost per item": "20.00", "Included / United States": "TRUE", "Included / International": "TRUE", Status: "active" }),
      row({ Handle: H, "Option1 Value": "Black", "Option2 Value": "M", "Variant SKU": sku("HD-BLK-M"), "Variant Grams": "520", "Variant Inventory Tracker": "shopify", "Variant Inventory Qty": "2", "Variant Inventory Policy": "deny", "Variant Fulfillment Service": "manual", "Variant Price": "45.00", "Variant Requires Shipping": "TRUE", "Variant Taxable": "TRUE", "Variant Weight Unit": "g", "Cost per item": "20.00" }),
      row({ Handle: H, "Image Src": "https://cdn.shopify.com/s/files/1/hoodie-2.jpg", "Image Position": "2", "Image Alt Text": "Back" }),
      row({ Handle: H, "Image Src": "https://cdn.shopify.com/s/files/1/hoodie-3.jpg", "Image Position": "3" }),
      row({ Handle: H, "Option1 Value": "Grey", "Option2 Value": "S", "Variant SKU": sku("HD-GRY-S"), "Variant Grams": "500", "Variant Inventory Tracker": "shopify", "Variant Inventory Qty": "0", "Variant Inventory Policy": "deny", "Variant Fulfillment Service": "manual", "Variant Price": "46.00", "Variant Requires Shipping": "TRUE", "Variant Taxable": "TRUE", "Variant Weight Unit": "g" }),
      row({ Handle: `${RUN.toLowerCase()}-mug`, Title: `B1 Mug ${RUN}`, Published: "TRUE", "Option1 Name": "Title", "Option1 Value": "Default Title", "Variant SKU": sku("MUG"), "Variant Inventory Tracker": "shopify", "Variant Inventory Qty": "8", "Variant Inventory Policy": "deny", "Variant Fulfillment Service": "manual", "Variant Price": "9.99", "Variant Requires Shipping": "TRUE", "Variant Taxable": "TRUE", "Image Src": "https://cdn.shopify.com/s/files/1/mug-1.jpg", "Image Position": "1", Status: "active" }),
      row({ Handle: `${RUN.toLowerCase()}-mug`, "Image Src": "https://cdn.shopify.com/s/files/1/mug-2.jpg", "Image Position": "2" }),
    ]);
    const prev = await productCsv.previewProductCsv(shopifyExport, { ownerId: A.id, stockWarehouseId: null });
    const hoodie = prev.groups.find((g) => g.handle === H)!;
    const mug = prev.groups.find((g) => g.handle === `${RUN.toLowerCase()}-mug`)!;
    const mediaRows = prev.rows.filter((r) => r.media).map((r) => r.index);
    check("Official Shopify export: detected, 2 products, 0 failed, 3 image-only rows recognised as media (rows 4, 5, 8)", prev.format === "shopify-products" && prev.summary.totalProducts === 2 && prev.summary.failedProducts === 0 && prev.summary.failedRows === 0 && prev.summary.mediaRows === 3 && mediaRows.join(",") === "4,5,8");
    check("No false 'Variant SKU is required' / 'Color value is required' errors on image rows", prev.rows.every((r) => r.errors.length === 0));
    check("Multi-variant hoodie preserved: options Color/Size, 3 variants with values, Cost per item → cost, price and qty parsed", hoodie.options.join("/") === "Color/Size" && hoodie.variants.length === 3 && hoodie.variants.map((v) => v.optionValues.join("/")).join(";") === "Black/S;Black/M;Grey/S" && hoodie.variants[0].cost === "20.00" && hoodie.variants[2].price === "46.00" && hoodie.variants[1].quantity === 2);
    check("Simple product with an extra image row stays a simple product with one variant", mug.options.length === 0 && mug.variants.length === 1 && mug.variants[0].sku === sku("MUG"));
    check("Unused Shopify columns are listed as ignored, used ones are not", prev.unknownColumns.includes("Variant Weight Unit") && prev.unknownColumns.includes("Google Shopping / Google Product Category") && !prev.unknownColumns.includes("Cost per item") && !prev.unknownColumns.includes("Image Src"));
    const imp = await productCsv.executeProductImport(prev, { ownerId: A.id, stockWarehouseId: null }, admin.id, `${RUN} shopify`);
    const hoodieRow = await prisma.product.findFirst({ where: { name: `B1 Hoodie ${RUN}` }, include: { variants: { orderBy: { sku: "asc" } } } });
    check("Import creates both products; hoodie has exactly 3 variants (no phantom variants from image rows)", imp.created.length === 2 && imp.failed.length === 0 && hoodieRow?.variants.length === 3 && hoodieRow.variants.find((v) => v.sku === sku("HD-BLK-S"))?.cost?.toString() === "20");
    // A real variant row still needs a SKU; a media-looking row WITH a title is a product row, not media.
    const stillStrict = await productCsv.previewProductCsv(toCsv(["Handle", "Title", "Option1 Name", "Option1 Value", "Variant SKU", "Variant Price", "Image Src"], [{ Handle: `${RUN.toLowerCase()}-x`, Title: "X", "Option1 Name": "Size", "Option1 Value": "S", "Variant SKU": "", "Variant Price": "1.00", "Image Src": "" }, { Handle: `${RUN.toLowerCase()}-y`, Title: "Y only image", "Option1 Name": "", "Option1 Value": "", "Variant SKU": "", "Variant Price": "", "Image Src": "https://x/y.jpg" }]), { ownerId: A.id, stockWarehouseId: null });
    check("Real variant rows without SKU still error; a titled row is never treated as media", stillStrict.rows[0].errors.some((e) => /SKU is required/.test(e)) && !stillStrict.rows[1].media && stillStrict.rows[1].errors.some((e) => /SKU is required/.test(e)));
    const skuLess = await productCsv.previewProductCsv(toCsv(["Handle", "Title", "Variant SKU", "Image Src", "Image Position"], [{ Handle: `${RUN.toLowerCase()}-z`, Title: "", "Variant SKU": "", "Image Src": "https://x/z.jpg", "Image Position": "1" }]), { ownerId: A.id, stockWarehouseId: null });
    check("Handle with only image rows → clear 'No variants' error instead of SKU/option errors", skuLess.groups[0]?.errors.some((e) => /No variants/.test(e)) && skuLess.rows[0].media === true);

    // ------------------------------------------------------------ 5. orders list default
    const parsed = orderListQuerySchema.parse({});
    check("Orders list query defaults to status=ALL (completed orders are never hidden by default)", parsed.status === "ALL" && parsed.view === "ALL");
    const shipMe = await orders.createOrder({ source: "MANUAL", warehouseId: W.id, reserve: true, shipName: "B1 Ship", lines: [{ variantId: vA1.id, quantity: 2 }] }, admin.id);
    created.orderIds.add(shipMe.orderId);
    const f = await fulfillment.startPicking({ orderId: shipMe.orderId, warehouseId: W.id }, admin.id);
    await fulfillment.shipFulfillment(f.id, { carrier: "UPS", trackingNumber: `${RUN}-TRK` }, admin.id);
    const completed = await orders.getOrder(shipMe.orderId);
    const listWith = (input: Record<string, string>) => {
      const { from, to, ...rest } = orderListQuerySchema.parse(input);
      void from;
      void to;
      return orders.listOrders({ ...rest, ownerId: A.id });
    };
    const defaultList = await listWith({});
    const openList = await listWith({ status: "OPEN" });
    const search = await listWith({ q: completed!.orderNumber });
    check("A fully shipped (COMPLETED) order is in the default list, out of 'Open only', and found by number search", completed?.status === "COMPLETED" && defaultList.items.some((x) => x.id === shipMe.orderId) && !openList.items.some((x) => x.id === shipMe.orderId) && search.items.some((x) => x.id === shipMe.orderId));

    // ------------------------------------------------------------ 6a. HTTP without a session (public page)
    {
      const res = await fetch(`${base}/admin/login`, { redirect: "manual" });
      const html = await res.text();
      check("HTTP: global navigation progress bar is mounted by the root layout (public login page)", res.status === 200 && html.includes('data-slot="navigation-progress"'));
    }

    // ------------------------------------------------------------ 6. HTTP checks (need a session)
    let firebaseOk = true;
    let adminCookie = "";
    let clientCookie = "";
    let uAdmin: { id: string; firebaseUid: string } | null = null;
    let uClient: { id: string; firebaseUid: string } | null = null;
    try {
      const { firebaseAdminAuth } = await import("../src/lib/firebase/admin");
      uAdmin = await users.createUserAccount({ name: "B1 Admin", email: `${RUN.toLowerCase()}-admin@example.test`, password: "E2eTestPass123", role: "ADMIN", ownerId: null, phone: null, notes: null }, admin.id);
      uClient = await users.createUserAccount({ name: "B1 Client", email: `${RUN.toLowerCase()}-client@example.test`, password: "E2eTestPass123", role: "THREEPL_CLIENT", ownerId: C.id, phone: null, notes: null }, admin.id);
      for (const u of [uAdmin, uClient]) {
        created.userIds.push(u.id);
        created.firebaseUids.push(u.firebaseUid);
      }
      const sessionFor = async (uid: string, audience: "staff" | "portal") => {
        const custom = await firebaseAdminAuth().createCustomToken(uid);
        const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${process.env.NEXT_PUBLIC_FIREBASE_API_KEY}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: custom, returnSecureToken: true }) });
        const { idToken } = await r.json();
        const res = await fetch(`${base}/api/auth/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken, audience }) });
        return (res.headers.get("set-cookie") ?? "").split(";")[0];
      };
      adminCookie = await sessionFor(uAdmin.firebaseUid, "staff");
      clientCookie = await sessionFor(uClient.firebaseUid, "portal");
      if (!adminCookie || !clientCookie) throw new Error("no session cookie");
    } catch (err) {
      firebaseOk = false;
      console.log(`      (Firebase Admin unavailable: ${(err as Error).message.slice(0, 120)})`);
    }
    const get = (path: string, cookie: string) => fetch(`${base}${path}`, { redirect: "manual", headers: { Cookie: cookie } });
    const text = (h: string) => h.replace(/<!--[\s\S]*?-->/g, "");

    if (!firebaseOk) {
      for (const n of ["HTTP: orders list defaults to all orders and shows the completed order + filter caption", "HTTP: vendor/3PL portal nav has no scroll container and is sticky", "HTTP: global navigation progress bar mounted in admin and portal", "HTTP: 3PL New Order page renders the SKU picker", "HTTP: search action as 3PL user returns results (200, no redirect) — regression for the disappearing screen", "HTTP: search action ignores a foreign ownerId for portal users"]) skip(n, "Firebase Admin credential unavailable — cannot mint a session");
    } else {
      let res = await get(`/admin/orders?ownerId=${A.id}`, adminCookie);
      let html = text(await res.text());
      check("HTTP: orders list defaults to all orders and shows the completed order + filter caption", res.status === 200 && html.includes(completed!.orderNumber) && html.includes("Showing all orders") && html.includes(">Fulfilled<"));
      res = await get("/portal/3pl", clientCookie);
      html = text(await res.text());
      const nav = html.match(/<nav[^>]*data-slot="portal-nav"[^>]*>[\s\S]*?<\/nav>/)?.[0] ?? "";
      check("HTTP: vendor/3PL portal nav has no scroll container and is sticky", res.status === 200 && nav.length > 0 && !nav.includes("overflow-x-auto") && nav.includes("flex-wrap") && /sticky top-14/.test(nav));
      const adminHome = text(await (await get("/admin", adminCookie)).text());
      check("HTTP: global navigation progress bar mounted in admin and portal", adminHome.includes('data-slot="navigation-progress"') && html.includes('data-slot="navigation-progress"'));
      res = await get("/portal/3pl/orders/new", clientCookie);
      html = text(await res.text());
      check("HTTP: 3PL New Order page renders the SKU picker", res.status === 200 && html.includes("Search SKU, barcode or product"));
      const ids = buildIds(html);
      if (ids.local && ids.served && ids.local !== ids.served) console.log(`      (note: server build ${ids.served} differs from local .next build ${ids.local} — action ids are taken from the served build)`);
      const actionId = await findServedActionId(html, "searchVariantsAction");
      if (!actionId) {
        check("HTTP: search action as 3PL user returns results (200, no redirect) — regression for the disappearing screen", false, `searchVariantsAction not found in the chunks served for /portal/3pl/orders/new (server build ${ids.served ?? "?"})`);
        check("HTTP: search action ignores a foreign ownerId for portal users", false, "action id unresolved");
      } else {
        const callAction = async (cookie: string, args: unknown[]) => fetch(`${base}/portal/3pl/orders/new`, { method: "POST", redirect: "manual", headers: { Cookie: cookie, "Next-Action": actionId, Accept: "text/x-component", "Content-Type": "text/plain;charset=UTF-8" }, body: JSON.stringify(args) });
        res = await callAction(clientCookie, [RUN, C.id]);
        const body = await res.text();
        check("HTTP: search action as 3PL user returns results (200, no redirect) — regression for the disappearing screen", res.status === 200 && !res.headers.get("x-action-redirect") && !res.headers.get("location") && body.includes(sku("C1")) && !body.includes(sku("A1")), `status ${res.status} redirect=${res.headers.get("x-action-redirect") ?? "none"} action=${actionId.slice(0, 8)}… build=${ids.served ?? "?"}${res.status === 404 ? " (404 = action id unknown to this server build: rebuild and restart `next start`)" : ""}`);
        res = await callAction(clientCookie, [RUN, A.id]);
        const body2 = await res.text();
        check("HTTP: search action ignores a foreign ownerId for portal users", res.status === 200 && body2.includes(sku("C1")) && !body2.includes(sku("A1")));
      }
    }
  } finally {
    const { firebaseAdminAuth } = await import("../src/lib/firebase/admin");
    for (const uid of created.firebaseUids) await firebaseAdminAuth().deleteUser(uid).catch(() => undefined);
    const productIds = (await prisma.product.findMany({ where: { ownerId: { in: created.ownerIds } }, select: { id: true } })).map((p) => p.id);
    const all = await prisma.order.findMany({ where: { OR: [{ items: { some: { ownerId: { in: created.ownerIds } } } }, { warehouseId: { in: created.warehouseIds } }] }, select: { id: true } });
    all.forEach((x) => created.orderIds.add(x.id));
    const orderIds = [...created.orderIds];
    await prisma.inventoryTransaction.deleteMany({ where: { OR: [{ orderId: { in: orderIds } }, { variant: { productId: { in: productIds } } }, { warehouseId: { in: created.warehouseIds } }] } });
    await prisma.shipmentItem.deleteMany({ where: { shipment: { orderId: { in: orderIds } } } });
    await prisma.shipment.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.fulfillmentItem.deleteMany({ where: { fulfillment: { orderId: { in: orderIds } } } });
    await prisma.fulfillment.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.orderEvent.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await prisma.inventoryLevel.deleteMany({ where: { OR: [{ variant: { productId: { in: productIds } } }, { warehouseId: { in: created.warehouseIds } }] } });
    await prisma.inventoryBalance.deleteMany({ where: { OR: [{ variant: { productId: { in: productIds } } }, { warehouseId: { in: created.warehouseIds } }] } });
    await prisma.receivingItem.deleteMany({ where: { OR: [{ variant: { productId: { in: productIds } } }, { receiving: { warehouseId: { in: created.warehouseIds } } }] } });
    await prisma.receivingRecord.deleteMany({ where: { OR: [{ ownerId: { in: created.ownerIds } }, { warehouseId: { in: created.warehouseIds } }] } });
    await prisma.productImage.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.productVariant.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.location.deleteMany({ where: { warehouseId: { in: created.warehouseIds } } });
    await prisma.warehouse.deleteMany({ where: { id: { in: created.warehouseIds } } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: [...created.ownerIds, ...productIds, ...created.warehouseIds, ...created.userIds, ...orderIds] } }, { userId: { in: created.userIds } }] } });
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
