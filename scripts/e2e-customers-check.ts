/**
 * Customer directory + order customer workflow (D-060): create/update/search, owner isolation, manual
 * and 3PL orders selecting or saving customers, duplicate reuse, historical orders untouched, order
 * snapshot independence, reserved Shopify fields inert, page/permission checks.
 *
 * Usage: npm run e2e:customers -- http://localhost:3100 vendor3pl@gmail.com
 */
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });
loadEnv();

const [base = "http://localhost:3100", adminEmail = "vendor3pl@gmail.com"] = process.argv.slice(2);
const RUN = `cu${Date.now().toString(36)}`.toUpperCase();
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

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const owners = await import("../src/server/services/owners");
  const users = await import("../src/server/services/users");
  const products = await import("../src/server/services/products");
  const warehouses = await import("../src/server/services/warehouses");
  const receiving = await import("../src/server/services/receiving");
  const orders = await import("../src/server/services/orders");
  const customers = await import("../src/server/services/customers");
  const { customerFormSchema, normalizePhone } = await import("../src/lib/validation/customers");
  const { manualOrderFormSchema } = await import("../src/lib/validation/orders");
  const { productFormSchema } = await import("../src/lib/validation/products");

  const admin = await prisma.user.findFirstOrThrow({ where: { email: adminEmail, role: "ADMIN" } });
  const created = { ownerIds: [] as string[], warehouseIds: [] as string[], userIds: [] as string[], firebaseUids: [] as string[], orderIds: new Set<string>(), customerIds: new Set<string>() };
  const ownerInput = (code: string, businessName: string) => ({ code, businessName, contactName: "Contact", email: null, phone: null, addressLine1: null, addressLine2: null, city: "Austin", state: null, postalCode: null, country: "US", notes: null });
  const sku = (s: string) => `${RUN}-${s}`.toUpperCase();
  const cf = (v: Record<string, unknown>) => customerFormSchema.parse({ name: "x", ...v });
  const ALL = { ownerId: undefined } as const;

  try {
    const V = await owners.createOwner("VENDOR", ownerInput(`${RUN}-V`, `CU Vendor ${RUN}`), admin.id);
    const C = await owners.createOwner("THREEPL_CLIENT", ownerInput(`${RUN}-C`, `CU Client ${RUN}`), admin.id);
    const C2 = await owners.createOwner("THREEPL_CLIENT", ownerInput(`${RUN}-C2`, `CU Client Two ${RUN}`), admin.id);
    created.ownerIds.push(V.id, C.id, C2.id);
    const W = await warehouses.createWarehouse({ code: `${RUN}-W`, name: "CU Warehouse", addressLine1: null, addressLine2: null, city: "Dallas", state: null, postalCode: null, country: "US", notes: null }, admin.id);
    created.warehouseIds.push(W.id);
    const main = (await warehouses.getDefaultLocation(W.id))!;
    const pC = await products.createProduct(productFormSchema.parse({ ownerId: C.id, name: `CU Box ${RUN}`, status: "ACTIVE", variants: [{ sku: sku("BOX"), price: "4.00", status: "ACTIVE" }] }), admin.id);
    const pV = await products.createProduct(productFormSchema.parse({ ownerId: V.id, name: `CU Widget ${RUN}`, status: "ACTIVE", variants: [{ sku: sku("WID"), price: "9.00", status: "ACTIVE" }] }), admin.id);
    await receiving.createReceiving({ ownerId: C.id, warehouseId: W.id, reference: `${RUN}-RC`, notes: null, lines: [{ variantId: pC.variants[0].id, locationId: main.id, quantity: 20 }] }, admin.id);
    await receiving.createReceiving({ ownerId: V.id, warehouseId: W.id, reference: `${RUN}-RV`, notes: null, lines: [{ variantId: pV.variants[0].id, locationId: main.id, quantity: 20 }] }, admin.id);

    // ---------------------------------------------------------------- 1/2. create + update
    check("normalizePhone keeps digits only and ignores short fragments", normalizePhone("+1 (512) 555-0100") === "15125550100" && normalizePhone("12-34") === null);
    const company = await customers.createCustomer(ALL, cf({ name: `Ada Lovelace ${RUN}`, email: `ADA.${RUN}@Example.com `, phone: "+1 (512) 555-0100", shipName: "Ada Lovelace", shipAddress1: "1 Analytical Way", shipCity: "London", shipCountry: "GB", billName: "Ada Lovelace", billAddress1: "PO Box 1", billCity: "London", billCountry: "GB" }), admin.id);
    created.customerIds.add(company.id);
    check("Create: company customer stored with lower-cased e-mail, normalised phone, shipping + billing, timestamps, source MANUAL", company.ownerId === null && company.email === `ada.${RUN.toLowerCase()}@example.com` && company.phoneNormalized === "15125550100" && company.billAddress1 === "PO Box 1" && company.source === "MANUAL" && company.createdAt instanceof Date && company.shopifyCustomerId === null);
    const updated = await customers.updateCustomer(ALL, company.id, cf({ name: `Ada Lovelace ${RUN}`, email: company.email, phone: "512-555-0199", shipName: "Ada L.", shipAddress1: "2 Difference Engine Rd", shipCity: "London", shipCountry: "GB" }), admin.id);
    check("Update: fields change, phone re-normalised, updatedAt moves, audit rows written", updated.phoneNormalized === "5125550199" && updated.shipAddress1 === "2 Difference Engine Rd" && updated.billAddress1 === null && updated.updatedAt >= company.updatedAt && (await prisma.auditLog.count({ where: { entityId: company.id, action: { in: ["customer.created", "customer.updated"] } } })) === 2);

    // ---------------------------------------------------------------- 3/4/5. search
    const clientCust = await customers.createCustomer({ ownerId: C.id }, cf({ name: `Grace Hopper ${RUN}`, email: `grace.${RUN}@example.com`, phone: "(212) 555-0142", shipName: "Grace Hopper", shipAddress1: "10 Navy St", shipCity: "New York", shipCountry: "US" }), admin.id, "THREEPL_PORTAL");
    const vendorCust = await customers.createCustomer({ ownerId: V.id }, cf({ name: `Grace Hopper ${RUN}`, email: `grace.${RUN}@example.com`, phone: "212 555 0142" }), admin.id);
    created.customerIds.add(clientCust.id);
    created.customerIds.add(vendorCust.id);
    const byName = await customers.listCustomers(ALL, { q: `Lovelace ${RUN}` });
    const byEmail = await customers.listCustomers(ALL, { q: `grace.${RUN}` });
    const byPhone = await customers.listCustomers(ALL, { q: "212-555-0142" });
    check("Search by name / e-mail / phone (digits compared without punctuation) across the whole directory for staff", byName.items.length === 1 && byName.items[0].id === company.id && byEmail.items.length === 2 && byPhone.items.length === 2 && byPhone.items.every((c) => c.name.startsWith("Grace")));
    check("Same person may exist under two owners (e-mail/phone are not platform-unique)", clientCust.email === vendorCust.email && clientCust.ownerId === C.id && vendorCust.ownerId === V.id);

    // ---------------------------------------------------------------- 6. isolation
    const clientScope = { ownerId: C.id };
    const c2Scope = { ownerId: C2.id };
    const clientList = await customers.listCustomers(clientScope, { q: RUN });
    const c2List = await customers.listCustomers(c2Scope, {});
    check("Isolation: a 3PL client's scope lists only its own customers; another client sees none; company customers hidden from portals", clientList.items.length === 1 && clientList.items[0].id === clientCust.id && c2List.total === 0 && (await customers.getCustomer(clientScope, company.id)) === null && (await customers.getCustomer(clientScope, vendorCust.id)) === null && (await customers.getCustomer(clientScope, clientCust.id))?.id === clientCust.id);
    const foreignUpdate = await expectError(() => customers.updateCustomer(clientScope, vendorCust.id, cf({ name: "Hacked" }), admin.id));
    const forcedOwner = await customers.createCustomer(clientScope, cf({ name: `Forced ${RUN}`, ownerId: V.id }), admin.id, "THREEPL_PORTAL");
    created.customerIds.add(forcedOwner.id);
    check("Isolation: updating another owner's customer is NOT_FOUND; a browser-supplied ownerId is ignored for portal scope", foreignUpdate.hit && foreignUpdate.code === "NOT_FOUND" && forcedOwner.ownerId === C.id && (await prisma.customer.findUnique({ where: { id: vendorCust.id } }))?.name.startsWith("Grace") === true);
    const vendorSearch = await customers.searchCustomers({ ownerId: V.id }, "Grace");
    check("Vendor scope search returns only the vendor's record", vendorSearch.length === 1 && vendorSearch[0].id === vendorCust.id);

    // ---------------------------------------------------------------- 11. duplicates
    const dupes = await customers.findDuplicateCustomers(C.id, { email: `GRACE.${RUN}@example.com`, phone: "212.555.0142", name: "Somebody Else" });
    const noDupes = await customers.findDuplicateCustomers(C2.id, { email: `grace.${RUN}@example.com` });
    const nameOnly = await customers.findDuplicateCustomers(null, { name: `ada lovelace ${RUN.toLowerCase()}` });
    check("Duplicate detection is per owner pool: same e-mail+phone matched in the client's pool, nothing in another client's pool, case-insensitive name match for company", dupes.length === 1 && dupes[0].matchedBy.join(",") === "email,phone" && noDupes.length === 0 && nameOnly.length === 1 && nameOnly[0].matchedBy.includes("name"));

    // ---------------------------------------------------------------- 7. manual order selecting an existing customer (admin, company pool)
    const manualForm = manualOrderFormSchema.parse({ customerId: company.id, warehouseId: W.id, reserve: true, customerName: `Ada Lovelace ${RUN}`, customerEmail: company.email, customerPhone: "512-555-0199", shipName: "Ada L.", shipAddress1: "Order-specific address 99", shipCity: "London", shipCountry: "GB", lines: [{ variantId: pV.variants[0].id, quantity: 1 }] });
    const { lines: l1, reserve: r1, warehouseId: w1, shippingMethod: sm1, notes: n1, tags: t1, customerId: cid1, saveCustomer: sc1, ...shipTo1 } = manualForm;
    void sm1;
    void n1;
    void t1;
    const res1 = await customers.resolveOrderCustomer(ALL, { customerId: cid1, saveCustomer: sc1, shipTo: shipTo1, ownerIdForNew: null, source: "ORDER" }, admin.id);
    const o1 = await orders.createOrder({ source: "MANUAL", ...shipTo1, customerId: res1.customerId, warehouseId: w1, reserve: r1, lines: l1.map((l) => ({ variantId: l.variantId, quantity: l.quantity })) }, admin.id);
    created.orderIds.add(o1.orderId);
    const order1 = await orders.getOrder(o1.orderId);
    check("Manual order with an existing customer: order linked (customerId) and keeps its own order-specific ship-to", res1.customerId === company.id && !res1.created && order1?.customer?.id === company.id && order1.shipAddress1 === "Order-specific address 99" && order1.customerName === `Ada Lovelace ${RUN}`);

    // ---------------------------------------------------------------- 8. manual order saving a new customer, and reuse instead of duplicate
    const shipTo2 = { customerName: `Linus T ${RUN}`, customerEmail: `linus.${RUN}@example.com`, customerPhone: "+358 40 123 4567", shipName: `Linus T ${RUN}`, shipAddress1: "Kernel St 1", shipCity: "Helsinki", shipCountry: "FI" };
    const res2 = await customers.resolveOrderCustomer(ALL, { customerId: null, saveCustomer: true, shipTo: shipTo2, ownerIdForNew: null, source: "ORDER" }, admin.id);
    if (res2.customerId) created.customerIds.add(res2.customerId);
    const saved = res2.customerId ? await prisma.customer.findUnique({ where: { id: res2.customerId } }) : null;
    check("Manual order 'save as new customer': company customer created from the ship-to with source ORDER", res2.created && saved?.ownerId === null && saved.source === "ORDER" && saved.email === `linus.${RUN.toLowerCase()}@example.com` && saved.shipCity === "Helsinki" && saved.phoneNormalized === "358401234567");
    const res3 = await customers.resolveOrderCustomer(ALL, { customerId: null, saveCustomer: true, shipTo: { ...shipTo2, customerName: "Linus Torvalds (typo)", customerEmail: `LINUS.${RUN}@example.com` }, ownerIdForNew: null, source: "ORDER" }, admin.id);
    check("Second 'save as new customer' with the same e-mail reuses the existing record instead of creating a duplicate", res3.reused && !res3.created && res3.customerId === res2.customerId && (await prisma.customer.count({ where: { email: `linus.${RUN.toLowerCase()}@example.com` } })) === 1);
    const noName = await expectError(() => customers.resolveOrderCustomer(ALL, { customerId: null, saveCustomer: true, shipTo: { customerEmail: `x.${RUN}@example.com` }, ownerIdForNew: null, source: "ORDER" }, admin.id));
    check("Saving a customer without any name is refused with a field error", noName.hit && (noName.message ?? "").includes("name"));

    // ---------------------------------------------------------------- 9/10. 3PL and vendor order isolation
    const foreignPick = await expectError(() => customers.resolveOrderCustomer(clientScope, { customerId: company.id, saveCustomer: false, shipTo: {}, ownerIdForNew: C.id, source: "THREEPL_PORTAL" }, admin.id));
    const otherClientPick = await expectError(() => customers.resolveOrderCustomer(c2Scope, { customerId: clientCust.id, saveCustomer: false, shipTo: {}, ownerIdForNew: C2.id, source: "THREEPL_PORTAL" }, admin.id));
    check("3PL order: picking a company customer or another client's customer is refused (FORBIDDEN)", foreignPick.hit && foreignPick.code === "FORBIDDEN" && otherClientPick.hit && otherClientPick.code === "FORBIDDEN");
    const ownPick = await customers.resolveOrderCustomer(clientScope, { customerId: clientCust.id, saveCustomer: false, shipTo: {}, ownerIdForNew: C.id, source: "THREEPL_PORTAL" }, admin.id);
    const o3 = await orders.createOrder({ source: "THREEPL_PORTAL", ...customers.customerSnapshot(clientCust), customerId: ownPick.customerId, warehouseId: W.id, submittedByOwnerId: C.id, reserve: true, lines: [{ variantId: pC.variants[0].id, quantity: 2 }] }, null);
    created.orderIds.add(o3.orderId);
    const savedFrom3pl = await customers.resolveOrderCustomer(clientScope, { customerId: null, saveCustomer: true, shipTo: { customerName: `New 3PL Cust ${RUN}`, customerEmail: `n3.${RUN}@example.com`, shipName: `New 3PL Cust ${RUN}` }, ownerIdForNew: C.id, source: "THREEPL_PORTAL" }, admin.id);
    if (savedFrom3pl.customerId) created.customerIds.add(savedFrom3pl.customerId);
    const c3 = savedFrom3pl.customerId ? await prisma.customer.findUnique({ where: { id: savedFrom3pl.customerId } }) : null;
    check("3PL order: own customer linked with snapshot copied; a customer saved from the 3PL flow belongs to that client (source THREEPL_PORTAL), invisible to other clients", (await orders.getOrder(o3.orderId, C.id))?.customer?.id === clientCust.id && c3?.ownerId === C.id && c3.source === "THREEPL_PORTAL" && (await customers.getCustomer(c2Scope, c3.id)) === null && (await customers.getCustomer(ALL, c3.id))?.id === c3.id);
    const vendorPick = await expectError(() => customers.resolveOrderCustomer({ ownerId: V.id }, { customerId: clientCust.id, saveCustomer: false, shipTo: {}, ownerIdForNew: V.id, source: "ORDER" }, admin.id));
    const vendorOwn = await customers.resolveOrderCustomer({ ownerId: V.id }, { customerId: vendorCust.id, saveCustomer: false, shipTo: {}, ownerIdForNew: V.id, source: "ORDER" }, admin.id);
    check("Vendor scope: the shared service accepts the vendor's own customer and refuses a 3PL client's (no separate vendor implementation)", vendorPick.hit && vendorPick.code === "FORBIDDEN" && vendorOwn.customerId === vendorCust.id);

    // ---------------------------------------------------------------- 12/13. historical orders + snapshot independence
    const legacy = await orders.createOrder({ source: "MANUAL", warehouseId: W.id, reserve: false, customerName: "Legacy Buyer", customerEmail: `legacy.${RUN}@example.com`, shipName: "Legacy Buyer", shipCity: "Austin", lines: [{ variantId: pV.variants[0].id, quantity: 1 }] }, admin.id);
    created.orderIds.add(legacy.orderId);
    const legacyRow = await orders.getOrder(legacy.orderId);
    const legacyList = await orders.listOrders({ status: "ALL", ownerId: V.id });
    check("Historical / unlinked orders: no customerId, all customer fields still shown and listed; no directory record created", legacyRow?.customerId === null && legacyRow.customer === null && legacyRow.customerName === "Legacy Buyer" && legacyList.items.some((o) => o.id === legacy.orderId) && (await prisma.customer.count({ where: { email: `legacy.${RUN.toLowerCase()}@example.com` } })) === 0);
    await customers.updateCustomer(ALL, company.id, cf({ name: `Ada Byron ${RUN}`, email: `byron.${RUN}@example.com`, phone: "000-000-0000", shipName: "Ada Byron", shipAddress1: "Changed later", shipCity: "Paris", shipCountry: "FR" }), admin.id);
    const order1After = await orders.getOrder(o1.orderId);
    check("Snapshot independence: editing the customer changes the directory but the linked order still shows what was entered at order time", order1After?.customerName === `Ada Lovelace ${RUN}` && order1After.customerEmail === company.email && order1After.shipAddress1 === "Order-specific address 99" && order1After.customer?.name === `Ada Byron ${RUN}`);
    const lockedOwner = await expectError(() => customers.updateCustomer(ALL, company.id, cf({ name: `Ada Byron ${RUN}`, ownerId: V.id }), admin.id));
    check("A customer with orders cannot be moved to another owner", lockedOwner.hit && lockedOwner.code === "OWNER_INVALID");

    // ---------------------------------------------------------------- 14. reserved Shopify fields inert
    const withShopify = await prisma.customer.update({ where: { id: vendorCust.id }, data: { shopifyStoreId: `store_${RUN}`, shopifyCustomerId: `gid://shopify/Customer/${RUN}` } });
    const stillListed = await customers.listCustomers({ ownerId: V.id }, { q: `grace.${RUN}` });
    const stillPick = await customers.resolveOrderCustomer({ ownerId: V.id }, { customerId: vendorCust.id, saveCustomer: false, shipTo: {}, ownerIdForNew: V.id, source: "ORDER" }, admin.id);
    const dupPair = await expectError(() => prisma.customer.create({ data: { name: "Dup pair", ownerId: V.id, shopifyStoreId: `store_${RUN}`, shopifyCustomerId: `gid://shopify/Customer/${RUN}` } }));
    check("Reserved Shopify fields: settable, unique per (store, customer), and irrelevant to listing/search/order linking", withShopify.shopifyCustomerId !== null && stillListed.items.some((c) => c.id === vendorCust.id) && stillPick.customerId === vendorCust.id && dupPair.hit && dupPair.code === "P2002");
    check("Customer detail lists linked orders (company customer: order 1 only)", (await customers.getCustomer(ALL, company.id))?.orders.map((o) => o.id).join() === o1.orderId);

    // ---------------------------------------------------------------- HTTP
    let adminCookie = "";
    let clientCookie = "";
    let c2Cookie = "";
    try {
      const { firebaseAdminAuth } = await import("../src/lib/firebase/admin");
      const mk = async (role: "ADMIN" | "THREEPL_CLIENT", ownerId: string | null, tag: string) => {
        const u = await users.createUserAccount({ name: `CU ${tag}`, email: `${RUN.toLowerCase()}-${tag}@example.test`, password: "E2eTestPass123", role, ownerId, phone: null, notes: null }, admin.id);
        created.userIds.push(u.id);
        created.firebaseUids.push(u.firebaseUid);
        const custom = await firebaseAdminAuth().createCustomToken(u.firebaseUid);
        const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${process.env.NEXT_PUBLIC_FIREBASE_API_KEY}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: custom, returnSecureToken: true }) });
        const { idToken } = await r.json();
        const res = await fetch(`${base}/api/auth/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken, audience: role === "ADMIN" ? "staff" : "portal" }) });
        return (res.headers.get("set-cookie") ?? "").split(";")[0];
      };
      adminCookie = await mk("ADMIN", null, "admin");
      clientCookie = await mk("THREEPL_CLIENT", C.id, "client");
      c2Cookie = await mk("THREEPL_CLIENT", C2.id, "client2");
    } catch (err) {
      console.log(`      (session unavailable: ${(err as Error).message.slice(0, 100)})`);
    }
    if (!adminCookie || !clientCookie || !c2Cookie) {
      for (const n of ["HTTP: admin customer list searches by name/email/phone and shows owner column", "HTTP: admin customer detail + edit pages render; orders linked", "HTTP: 3PL customers tab shows only own customers; foreign customer detail is 404", "HTTP: 3PL New Order page offers the customer picker and 'Save as new customer'", "HTTP: unauthenticated /admin/customers redirects"]) skip(n, "no session");
    } else {
      const get = (path: string, cookie: string) => fetch(`${base}${path}`, { redirect: "manual", headers: { Cookie: cookie } });
      const text = async (r: Response) => (await r.text()).replace(/<!--[\s\S]*?-->/g, "");
      let res = await get(`/admin/customers?q=${encodeURIComponent(`grace.${RUN}`)}`, adminCookie);
      let html = await text(res);
      const byPhoneHtml = await text(await get(`/admin/customers?q=${encodeURIComponent("212-555-0142")}`, adminCookie));
      check("HTTP: admin customer list searches by name/email/phone and shows owner column", res.status === 200 && html.includes(`Grace Hopper ${RUN}`) && html.includes(`CU Client ${RUN}`) && html.includes(`CU Vendor ${RUN}`) && byPhoneHtml.includes(`Grace Hopper ${RUN}`) && html.includes("Belongs to"));
      res = await get(`/admin/customers/${company.id}`, adminCookie);
      html = await text(res);
      const edit = await get(`/admin/customers/${company.id}/edit`, adminCookie);
      check("HTTP: admin customer detail + edit pages render; orders linked", res.status === 200 && html.includes(`Ada Byron ${RUN}`) && html.includes(order1!.orderNumber) && html.includes("Company (V3PL)") && edit.status === 200 && (await text(edit)).includes("Edit customer"));
      res = await get(`/portal/3pl/customers`, clientCookie);
      html = await text(res);
      const foreign = await get(`/portal/3pl/customers/${company.id}`, clientCookie);
      const other = await get(`/portal/3pl/customers/${clientCust.id}`, c2Cookie);
      check("HTTP: 3PL customers tab shows only own customers; foreign customer detail is 404", res.status === 200 && html.includes(`Grace Hopper ${RUN}`) && !html.includes(`Ada Byron ${RUN}`) && !html.includes("Belongs to") && foreign.status === 404 && other.status === 404);
      res = await get("/portal/3pl/orders/new", clientCookie);
      html = await text(res);
      check("HTTP: 3PL New Order page offers the customer picker and 'Save as new customer'", res.status === 200 && html.includes('data-slot="order-customer"') && html.includes("Save as new customer") && html.includes("Search customers by name, email or phone"));
      const anon = await fetch(`${base}/admin/customers`, { redirect: "manual" });
      check("HTTP: unauthenticated /admin/customers redirects", anon.status === 307);
    }
  } finally {
    const { firebaseAdminAuth } = await import("../src/lib/firebase/admin");
    for (const uid of created.firebaseUids) await firebaseAdminAuth().deleteUser(uid).catch(() => undefined);
    const productIds = (await prisma.product.findMany({ where: { ownerId: { in: created.ownerIds } }, select: { id: true } })).map((p) => p.id);
    const all = await prisma.order.findMany({ where: { OR: [{ items: { some: { ownerId: { in: created.ownerIds } } } }, { warehouseId: { in: created.warehouseIds } }] }, select: { id: true } });
    all.forEach((x) => created.orderIds.add(x.id));
    const orderIds = [...created.orderIds];
    await prisma.inventoryTransaction.deleteMany({ where: { OR: [{ orderId: { in: orderIds } }, { variant: { productId: { in: productIds } } }, { warehouseId: { in: created.warehouseIds } }] } });
    await prisma.orderEvent.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await prisma.customer.deleteMany({ where: { OR: [{ id: { in: [...created.customerIds] } }, { ownerId: { in: created.ownerIds } }, { email: { endsWith: `${RUN.toLowerCase()}@example.com` } }] } });
    await prisma.inventoryLevel.deleteMany({ where: { OR: [{ variant: { productId: { in: productIds } } }, { warehouseId: { in: created.warehouseIds } }] } });
    await prisma.inventoryBalance.deleteMany({ where: { OR: [{ variant: { productId: { in: productIds } } }, { warehouseId: { in: created.warehouseIds } }] } });
    await prisma.receivingItem.deleteMany({ where: { OR: [{ variant: { productId: { in: productIds } } }, { receiving: { warehouseId: { in: created.warehouseIds } } }] } });
    await prisma.receivingRecord.deleteMany({ where: { OR: [{ ownerId: { in: created.ownerIds } }, { warehouseId: { in: created.warehouseIds } }] } });
    await prisma.productVariant.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.location.deleteMany({ where: { warehouseId: { in: created.warehouseIds } } });
    await prisma.warehouse.deleteMany({ where: { id: { in: created.warehouseIds } } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: [...created.ownerIds, ...productIds, ...created.warehouseIds, ...created.userIds, ...orderIds, ...created.customerIds] } }, { userId: { in: created.userIds } }, { entityType: "Customer", newValues: { path: ["name"], string_contains: RUN } }] } });
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
