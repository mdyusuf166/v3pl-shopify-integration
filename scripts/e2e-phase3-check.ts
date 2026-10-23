/**
 * Phase 3 end-to-end check: products/SKUs, warehouses/locations, inventory ledger,
 * receiving, adjustments, moves, reservations, shipping, transfers, concurrency and
 * owner-scoped portal visibility. Runs through the core services (no HTTP needed for
 * the engine) plus a few HTTP checks against a running server for pages/isolation.
 *
 * Usage: npm run e2e:phase3 -- http://localhost:3100 vendor3pl@gmail.com
 * Creates temporary data (real Firebase account for one portal user) and removes it all.
 */
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });
loadEnv();

const [base = "http://localhost:3100", adminEmail = "vendor3pl@gmail.com"] = process.argv.slice(2);
const RUN = `p3${Date.now().toString(36)}`;
const results: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const expectError = async (fn: () => Promise<unknown>, codeOrClass: string): Promise<{ hit: boolean; code?: string }> => {
  try {
    await fn();
    return { hit: false };
  } catch (e) {
    const code = (e as { code?: string }).code;
    return { hit: code === codeOrClass || (e as Error).constructor.name === codeOrClass, code };
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
  const transfers = await import("../src/server/services/transfers");
  const hooks = await import("../src/server/services/inventory-hooks");

  const admin = await prisma.user.findFirstOrThrow({ where: { email: adminEmail, role: "ADMIN" } });
  const created = { ownerIds: [] as string[], productIds: [] as string[], warehouseIds: [] as string[], userIds: [] as string[], firebaseUids: [] as string[] };
  const ownerInput = (code: string, businessName: string) => ({ code, businessName, contactName: null, email: null, phone: null, addressLine1: null, addressLine2: null, city: null, state: null, postalCode: null, country: null, notes: null });

  // Hook registry: record every change delivered to integrations.
  const hookCalls: number[] = [];
  const unregister = hooks.registerInventoryChangeHandler(async (_tx, changes) => {
    hookCalls.push(changes.length);
  });

  try {
    // --- Setup ------------------------------------------------------------------
    const vendorA = await owners.createOwner("VENDOR", ownerInput(`${RUN}-A`, `P3 Vendor A ${RUN}`), admin.id);
    const vendorB = await owners.createOwner("VENDOR", ownerInput(`${RUN}-B`, `P3 Vendor B ${RUN}`), admin.id);
    created.ownerIds.push(vendorA.id, vendorB.id);

    const whA = await warehouses.createWarehouse({ code: `${RUN}-WA`.toUpperCase(), name: "P3 Warehouse A", addressLine1: null, addressLine2: null, city: null, state: null, postalCode: null, country: null, notes: null }, admin.id);
    const whB = await warehouses.createWarehouse({ code: `${RUN}-WB`.toUpperCase(), name: "P3 Warehouse B", addressLine1: null, addressLine2: null, city: null, state: null, postalCode: null, country: null, notes: null }, admin.id);
    created.warehouseIds.push(whA.id, whB.id);
    const mainA = (await warehouses.getDefaultLocation(whA.id))!;
    const mainB = (await warehouses.getDefaultLocation(whB.id))!;
    check("Warehouses get a default MAIN location", mainA.label === "MAIN" && mainB.label === "MAIN");
    const binA = await warehouses.createLocation(whA.id, { label: "A-01-1-B1", zone: "A", rack: "01", shelf: "1", bin: "B1", notes: null }, admin.id);
    const dupLabel = await expectError(() => warehouses.createLocation(whA.id, { label: "A-01-1-B1", zone: null, rack: null, shelf: null, bin: null, notes: null }, admin.id), "LABEL_TAKEN");
    check("Duplicate location label rejected", dupLabel.hit);

    const skuA1 = `${RUN}-A1`.toUpperCase();
    const skuA2 = `${RUN}-A2`.toUpperCase();
    const skuB1 = `${RUN}-B1`.toUpperCase();
    const prodA = await products.createProduct(
      { ownerId: vendorA.id, name: "P3 Widget", category: "Test", description: null, notes: null, status: "ACTIVE", variants: [
        { sku: skuA1, name: "Red", barcode: null, price: "12.50", cost: "5.00", status: "ACTIVE" },
        { sku: skuA2, name: "Blue", barcode: null, price: "12.50", cost: null, status: "ACTIVE" },
      ] },
      admin.id,
    );
    const prodB = await products.createProduct({ ownerId: vendorB.id, name: "P3 Gadget", category: null, description: null, notes: null, status: "ACTIVE", variants: [{ sku: skuB1, name: null, barcode: null, price: "7.00", cost: null, status: "ACTIVE" }] }, admin.id);
    created.productIds.push(prodA.id, prodB.id);
    const vA1 = prodA.variants.find((v) => v.sku === skuA1)!;
    const vA2 = prodA.variants.find((v) => v.sku === skuA2)!;
    const vB1 = prodB.variants[0];
    check("Products with variants created; single-variant product marks default", (await prisma.productVariant.findUnique({ where: { id: vB1.id } }))?.isDefault === true);

    const dupSku = await expectError(() => products.createProduct({ ownerId: vendorB.id, name: "Dup", category: null, description: null, notes: null, status: "ACTIVE", variants: [{ sku: skuA1, name: null, barcode: null, price: null, cost: null, status: "ACTIVE" }] }, admin.id), "SKU_TAKEN");
    check("Global SKU uniqueness enforced across owners", dupSku.hit);

    // --- Receiving -----------------------------------------------------------------
    const rec = await receiving.createReceiving({ ownerId: vendorA.id, warehouseId: whA.id, reference: `${RUN}-PO1`, notes: null, lines: [{ variantId: vA1.id, locationId: mainA.id, quantity: 100 }, { variantId: vA2.id, locationId: binA.id, quantity: 40 }] }, admin.id);
    let stock = await inventory.stockForVariant(vA1.id);
    check("Receiving books +100 into WA/MAIN", stock[0]?.onHand === 100 && stock[0]?.available === 100, JSON.stringify(stock[0]));
    const wrongOwner = await expectError(() => receiving.createReceiving({ ownerId: vendorA.id, warehouseId: whA.id, reference: null, notes: null, lines: [{ variantId: vB1.id, locationId: mainA.id, quantity: 1 }] }, admin.id), "SKU_OWNER_MISMATCH");
    check("Receiving rejects a SKU of another owner", wrongOwner.hit);

    // --- Reservations ---------------------------------------------------------------
    await inventory.reserveStock({ userId: admin.id, variantId: vA1.id, warehouseId: whA.id, quantity: 20, refs: { externalEventId: `${RUN}-ORD1` } });
    stock = await inventory.stockForVariant(vA1.id);
    check("Reserve 20 → onHand 100, reserved 20, available 80", stock[0].onHand === 100 && stock[0].reserved === 20 && stock[0].available === 80);
    const over = await expectError(() => inventory.reserveStock({ userId: admin.id, variantId: vA1.id, warehouseId: whA.id, quantity: 90 }), "INSUFFICIENT_STOCK");
    check("Reserving more than available is rejected (no negative available)", over.hit);
    await inventory.releaseStock({ userId: admin.id, variantId: vA1.id, warehouseId: whA.id, quantity: 5, refs: { externalEventId: `${RUN}-ORD1` } });
    const tooMuchRelease = await expectError(() => inventory.releaseStock({ userId: admin.id, variantId: vA1.id, warehouseId: whA.id, quantity: 50 }), "INSUFFICIENT_RESERVED");
    check("Release 5 ok; releasing more than reserved rejected", tooMuchRelease.hit && (await inventory.stockForVariant(vA1.id))[0].reserved === 15);

    // Removing reserved units via adjustment must fail; removing available is fine.
    const eatReserved = await expectError(() => inventory.adjustStock({ userId: admin.id, variantId: vA1.id, warehouseId: whA.id, locationId: mainA.id, kind: "ADJUSTMENT_OUT", quantity: 90, reason: "test" }), "INSUFFICIENT_STOCK");
    check("Adjustment cannot remove reserved units (90 > 85 available)", eatReserved.hit);

    // --- Ship consumes reservation --------------------------------------------------
    await inventory.shipStock({ userId: admin.id, variantId: vA1.id, warehouseId: whA.id, locationId: mainA.id, quantity: 15, reservedQuantity: 15, refs: { externalEventId: `${RUN}-SHP1` } });
    stock = await inventory.stockForVariant(vA1.id);
    check("Ship 15 → onHand 85, reserved 0", stock[0].onHand === 85 && stock[0].reserved === 0);

    // --- Adjustments with before/after -------------------------------------------------
    await inventory.adjustStock({ userId: admin.id, variantId: vA1.id, warehouseId: whA.id, locationId: mainA.id, kind: "DAMAGE", quantity: 2, reason: "Crushed box" });
    await inventory.adjustStock({ userId: admin.id, variantId: vA1.id, warehouseId: whA.id, locationId: mainA.id, kind: "MISSING", quantity: 1, reason: "Cycle count" });
    await inventory.adjustStock({ userId: admin.id, variantId: vA1.id, warehouseId: whA.id, locationId: mainA.id, kind: "ADJUSTMENT_IN", quantity: 10, reason: "Found pallet", notes: "behind rack" });
    const dmg = await prisma.inventoryTransaction.findFirst({ where: { variantId: vA1.id, type: "DAMAGE" } });
    check("Damage row records before/after (85 → 83) and reason", dmg?.beforeQty === 85 && dmg?.afterQty === 83 && dmg.reason === "Crushed box");
    stock = await inventory.stockForVariant(vA1.id);
    check("After damage −2, missing −1, adjustment +10 → onHand 92", stock[0].onHand === 92);

    // --- Move between locations ---------------------------------------------------------
    await inventory.moveStock({ userId: admin.id, variantId: vA1.id, warehouseId: whA.id, fromLocationId: mainA.id, toLocationId: binA.id, quantity: 30 });
    stock = await inventory.stockForVariant(vA1.id);
    const locs = Object.fromEntries(stock[0].locations.map((l) => [l.label, l.onHand]));
    check("Move 30 MAIN → A-01-1-B1 keeps warehouse total 92", stock[0].onHand === 92 && locs["MAIN"] === 62 && locs["A-01-1-B1"] === 30, JSON.stringify(locs));
    const overMove = await expectError(() => inventory.moveStock({ userId: admin.id, variantId: vA1.id, warehouseId: whA.id, fromLocationId: binA.id, toLocationId: mainA.id, quantity: 31 }), "INSUFFICIENT_STOCK");
    check("Cannot move more than the source location holds", overMove.hit);

    // --- Transfers: out at once, in on completion; cancel returns --------------------------
    const tr = await transfers.createTransfer({ sourceWarehouseId: whA.id, destWarehouseId: whB.id, reference: `${RUN}-TR1`, notes: null, lines: [{ variantId: vA1.id, sourceLocationId: binA.id, quantity: 20 }] }, admin.id);
    stock = await inventory.stockForVariant(vA1.id);
    check("Transfer created → source onHand 72, destination still 0 (in transit)", stock.find((s) => s.warehouse.id === whA.id)?.onHand === 72 && !stock.find((s) => s.warehouse.id === whB.id && s.onHand > 0));
    await transfers.completeTransfer(tr.id, undefined, admin.id);
    stock = await inventory.stockForVariant(vA1.id);
    check("Transfer completed → destination MAIN +20; both legs share transferId", stock.find((s) => s.warehouse.id === whB.id)?.onHand === 20 && (await prisma.inventoryTransaction.count({ where: { transferId: tr.id } })) === 2);
    const tr2 = await transfers.createTransfer({ sourceWarehouseId: whA.id, destWarehouseId: whB.id, reference: `${RUN}-TR2`, notes: null, lines: [{ variantId: vA1.id, sourceLocationId: mainA.id, quantity: 10 }] }, admin.id);
    await transfers.cancelTransfer(tr2.id, "truck did not leave", admin.id);
    stock = await inventory.stockForVariant(vA1.id);
    check("Cancelled transfer returns stock to source (72)", stock.find((s) => s.warehouse.id === whA.id)?.onHand === 72);
    const overTransfer = await expectError(() => transfers.createTransfer({ sourceWarehouseId: whA.id, destWarehouseId: whB.id, reference: null, notes: null, lines: [{ variantId: vA1.id, sourceLocationId: mainA.id, quantity: 999 }] }, admin.id), "INSUFFICIENT_STOCK");
    check("Transfer more than available rejected", overTransfer.hit);

    // --- Concurrency: 10 parallel reservations of 10 against whatever is available at WA ----
    const before = (await inventory.stockForVariant(vA1.id)).find((s) => s.warehouse.id === whA.id)!;
    const expectedOk = Math.floor(before.available / 10);
    const attempts = await Promise.allSettled(Array.from({ length: 10 }, () => inventory.reserveStock({ userId: admin.id, variantId: vA1.id, warehouseId: whA.id, quantity: 10 })));
    const okCount = attempts.filter((a) => a.status === "fulfilled").length;
    stock = await inventory.stockForVariant(vA1.id);
    const bal = stock.find((s) => s.warehouse.id === whA.id)!;
    check(
      `Concurrent reservations: exactly ${expectedOk} of 10 succeed (${before.available} available), never negative`,
      okCount === expectedOk && bal.reserved === before.reserved + expectedOk * 10 && bal.available === before.available - expectedOk * 10 && bal.available >= 0,
      `ok=${okCount} reserved=${bal.reserved} available=${bal.available}`,
    );

    // --- Ledger consistency ---------------------------------------------------------------
    for (const wh of [whA.id, whB.id]) {
      const c = await inventory.verifyLedgerConsistency(vA1.id, wh);
      check(`Ledger Σ = balance = Σ locations (${wh === whA.id ? "WA" : "WB"})`, c.consistent, JSON.stringify(c));
    }
    const available = await inventory.availableForVariants([vA1.id, vA2.id, vB1.id], [whA.id, whB.id]);
    check("availableForVariants (Shopify contract) sums across warehouses", available.get(vA1.id) === 2 + 20 && available.get(vA2.id) === 40 && available.get(vB1.id) === 0, JSON.stringify([...available]));
    check("Inventory change hooks fired for every movement batch", hookCalls.length >= 15 && hookCalls.every((n) => n >= 1), `${hookCalls.length} calls`);

    // --- Product rules ----------------------------------------------------------------------
    const ownerChange = await expectError(() => products.updateProduct(prodA.id, { ownerId: vendorB.id, name: "P3 Widget", category: null, description: null, notes: null, status: "ACTIVE", variants: [{ id: vA1.id, sku: skuA1, name: "Red", barcode: null, price: null, cost: null, status: "ACTIVE" }, { id: vA2.id, sku: skuA2, name: "Blue", barcode: null, price: null, cost: null, status: "ACTIVE" }] }, admin.id), "OWNER_LOCKED");
    check("Owner cannot change once the product has inventory history", ownerChange.hit);
    const removeVariant = await expectError(() => products.updateProduct(prodA.id, { ownerId: vendorA.id, name: "P3 Widget", category: null, description: null, notes: null, status: "ACTIVE", variants: [{ id: vA1.id, sku: skuA1, name: "Red", barcode: null, price: null, cost: null, status: "ACTIVE" }] }, admin.id), "VARIANT_HAS_HISTORY");
    check("Variant with history cannot be deleted (archive instead)", removeVariant.hit);
    const whDeactivate = await expectError(() => warehouses.setWarehouseStatus(whB.id, "INACTIVE", admin.id), "HAS_STOCK");
    check("Warehouse holding stock cannot be deactivated", whDeactivate.hit);
    const dbCheck = await expectError(() => prisma.inventoryBalance.update({ where: { variantId_warehouseId: { variantId: vA1.id, warehouseId: whA.id } }, data: { onHand: -1 } }), "PrismaClientKnownRequestError");
    check("DB CHECK blocks negative onHand even from raw writes", dbCheck.hit);

    // --- HTTP: admin pages + portal isolation ---------------------------------------------------
    const auth = firebaseAdminAuth();
    const portalUser = await users.createUserAccount({ name: "P3 Vendor A user", email: `${RUN}-a@example.test`, password: "E2eTestPass123", role: "VENDOR", ownerId: vendorA.id, phone: null, notes: null }, admin.id);
    created.userIds.push(portalUser.id);
    created.firebaseUids.push(portalUser.firebaseUid);
    async function sessionFor(uid: string, audience: "staff" | "portal") {
      const custom = await auth.createCustomToken(uid);
      const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${process.env.NEXT_PUBLIC_FIREBASE_API_KEY}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: custom, returnSecureToken: true }) });
      const { idToken } = await r.json();
      const res = await fetch(`${base}/api/auth/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken, audience }) });
      return (res.headers.get("set-cookie") ?? "").split(";")[0];
    }
    const get = (path: string, cookie: string) => fetch(`${base}${path}`, { redirect: "manual", headers: { Cookie: cookie } });
    const adminCookie = await sessionFor(admin.firebaseUid, "staff");
    for (const path of ["/admin/products", `/admin/products/${prodA.id}`, "/admin/warehouses", `/admin/warehouses/${whA.id}`, "/admin/inventory", "/admin/inventory/movements", "/admin/inventory/adjust", "/admin/receiving", `/admin/receiving/${rec.id}`, "/admin/receiving/new", "/admin/transfers", `/admin/transfers/${tr.id}`, "/admin/transfers/new", "/admin"]) {
      const res = await get(path, adminCookie);
      check(`Admin GET ${path} → 200`, res.status === 200, String(res.status));
    }
    let res = await get(`/admin/inventory?q=${encodeURIComponent(RUN)}`, adminCookie);
    let html = await res.text();
    check("Inventory overview lists the test SKUs with figures", html.includes(skuA1) && html.includes(skuA2));

    const vendorCookie = await sessionFor(portalUser.firebaseUid, "portal");
    res = await get("/portal/vendor/products", vendorCookie);
    html = await res.text();
    check("Vendor portal products shows own SKUs only", res.status === 200 && html.includes(skuA1) && !html.includes(skuB1));
    res = await get("/portal/vendor/inventory", vendorCookie);
    html = await res.text();
    check("Vendor portal history shows own movements only", res.status === 200 && html.includes(skuA1) && !html.includes(skuB1));
    res = await get(`/admin/products/${prodB.id}`, vendorCookie);
    check("Vendor cannot open admin product pages", res.status === 307);
    await fetch(`${base}/api/auth/session`, { method: "DELETE", headers: { Cookie: adminCookie } });
  } finally {
    unregister();
    // --- Cleanup (test data only) ---------------------------------------------------------------
    for (const uid of created.firebaseUids) await auth_delete(uid);
    async function auth_delete(uid: string) {
      const { firebaseAdminAuth } = await import("../src/lib/firebase/admin");
      await firebaseAdminAuth().deleteUser(uid).catch(() => undefined);
    }
    const variantIds = (await prisma.productVariant.findMany({ where: { productId: { in: created.productIds } }, select: { id: true } })).map((v) => v.id);
    await prisma.inventoryTransaction.deleteMany({ where: { variantId: { in: variantIds } } });
    await prisma.inventoryLevel.deleteMany({ where: { variantId: { in: variantIds } } });
    await prisma.inventoryBalance.deleteMany({ where: { variantId: { in: variantIds } } });
    await prisma.transferItem.deleteMany({ where: { variantId: { in: variantIds } } });
    await prisma.transfer.deleteMany({ where: { OR: [{ sourceWarehouseId: { in: created.warehouseIds } }, { destWarehouseId: { in: created.warehouseIds } }] } });
    await prisma.receivingItem.deleteMany({ where: { variantId: { in: variantIds } } });
    await prisma.receivingRecord.deleteMany({ where: { ownerId: { in: created.ownerIds } } });
    await prisma.productVariant.deleteMany({ where: { id: { in: variantIds } } });
    await prisma.product.deleteMany({ where: { id: { in: created.productIds } } });
    await prisma.location.deleteMany({ where: { warehouseId: { in: created.warehouseIds } } });
    await prisma.warehouse.deleteMany({ where: { id: { in: created.warehouseIds } } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: [...created.ownerIds, ...created.productIds, ...created.warehouseIds, ...created.userIds] } }, { entityType: { in: ["ReceivingRecord", "Transfer", "Location"] }, createdAt: { gte: new Date(Date.now() - 30 * 60 * 1000) }, metadata: { equals: undefined } }] } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: created.userIds } } });
    await prisma.owner.deleteMany({ where: { id: { in: created.ownerIds } } });
    await prisma.$disconnect();
    console.log("Cleanup done.");
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
