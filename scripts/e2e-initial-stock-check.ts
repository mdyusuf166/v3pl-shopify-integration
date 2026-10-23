/**
 * Initial inventory during product creation (D-058): quantities per generated variant are received
 * through the normal receiving service into the chosen warehouse/location — receipt record, RECEIVE
 * ledger rows with user/time/warehouse/location/reference, audit — never a direct balance write.
 *
 * Usage: npm run e2e:initial-stock -- http://localhost:3100 vendor3pl@gmail.com
 */
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });
loadEnv();

const [base = "http://localhost:3100", adminEmail = "vendor3pl@gmail.com"] = process.argv.slice(2);
const RUN = `is${Date.now().toString(36)}`.toUpperCase();
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
  const inventory = await import("../src/server/services/inventory");
  const { productFormSchema, initialStockSchema, variantFormSchema } = await import("../src/lib/validation/products");
  const { generateCombinations } = await import("../src/lib/variant-builder");

  const admin = await prisma.user.findFirstOrThrow({ where: { email: adminEmail, role: "ADMIN" } });
  const created = { ownerIds: [] as string[], warehouseIds: [] as string[], userIds: [] as string[], firebaseUids: [] as string[] };
  const ownerInput = (code: string, businessName: string) => ({ code, businessName, contactName: "Contact", email: null, phone: null, addressLine1: null, addressLine2: null, city: "Austin", state: null, postalCode: null, country: "US", notes: null });
  const whInput = (code: string, name: string) => ({ code, name, addressLine1: null, addressLine2: null, city: "Dallas", state: null, postalCode: null, country: "US", notes: null });
  const sku = (s: string) => `${RUN}-${s}`.toUpperCase();

  try {
    const V = await owners.createOwner("VENDOR", ownerInput(`${RUN}-V`, `IS Vendor ${RUN}`), admin.id);
    const C = await owners.createOwner("THREEPL_CLIENT", ownerInput(`${RUN}-C`, `IS Client ${RUN}`), admin.id);
    created.ownerIds.push(V.id, C.id);
    const W1 = await warehouses.createWarehouse(whInput(`${RUN}-W1`, "IS Warehouse 1"), admin.id);
    const W2 = await warehouses.createWarehouse(whInput(`${RUN}-W2`, "IS Warehouse 2"), admin.id);
    created.warehouseIds.push(W1.id, W2.id);
    const main1 = (await warehouses.getDefaultLocation(W1.id))!;
    const main2 = (await warehouses.getDefaultLocation(W2.id))!;
    const bin = await warehouses.createLocation(W2.id, { label: "A-01", zone: "A", rack: "01", shelf: null, bin: null, notes: null }, admin.id);

    // ---------------------------------------------------------------- schema
    check("Schema: initialQuantity accepts blank/0/whole numbers and rejects fractions or text", variantFormSchema.parse({ sku: "abc-1", initialQuantity: "", status: "ACTIVE" }).initialQuantity === null && variantFormSchema.parse({ sku: "abc-1", initialQuantity: "0", status: "ACTIVE" }).initialQuantity === 0 && variantFormSchema.parse({ sku: "abc-1", initialQuantity: 25, status: "ACTIVE" }).initialQuantity === 25 && !variantFormSchema.safeParse({ sku: "abc-1", initialQuantity: "2.5", status: "ACTIVE" }).success && !variantFormSchema.safeParse({ sku: "abc-1", initialQuantity: "ten", status: "ACTIVE" }).success && !initialStockSchema.safeParse({ warehouseId: "", locationId: "x" }).success);

    // ---------------------------------------------------------------- 1. different quantities per variant (2-option product, vendor)
    const combos = generateCombinations([{ name: "Color", values: ["White", "Black"] }, { name: "Size", values: ["L", "XL"] }]);
    const qty: Record<string, string> = { "White/L": "25", "White/XL": "30", "Black/L": "15", "Black/XL": "" };
    const values = productFormSchema.parse({ ownerId: V.id, name: `IS Tee ${RUN}`, status: "ACTIVE", options: ["Color", "Size"], variants: combos.map((c, i) => ({ sku: sku(`T${i}`), optionValues: c, price: "20.00", initialQuantity: qty[c.join("/")], status: "ACTIVE" })) });
    const before = await prisma.inventoryTransaction.count();
    const r1 = await products.createProductWithInitialStock(values, { warehouseId: W1.id, locationId: main1.id }, admin.id);
    const stock1 = new Map(await Promise.all(r1.product.variants.map(async (v) => [v.sku, await inventory.stockForVariant(v.id)] as const)));
    check("Multiple variants receive different initial quantities (25 / 30 / 15) and the blank one stays at zero", r1.stock?.units === 70 && r1.stock.lines === 3 && stock1.get(sku("T0"))?.[0]?.onHand === 25 && stock1.get(sku("T1"))?.[0]?.onHand === 30 && stock1.get(sku("T2"))?.[0]?.onHand === 15 && (stock1.get(sku("T3"))?.length ?? 0) === 0);
    check("Product itself is intact: 4 variants, options, prices; initialQuantity is not persisted on the variant", r1.product.variants.length === 4 && (await prisma.product.findUnique({ where: { id: r1.product.id } }))?.options.join("/") === "Color/Size" && !("initialQuantity" in ((await prisma.productVariant.findFirst({ where: { productId: r1.product.id } })) ?? {})));

    // ---------------------------------------------------------------- 4. ledger / receipt correctness
    const receipt = await prisma.receivingRecord.findFirst({ where: { ownerId: V.id, reference: "Initial stock" }, include: { items: true } });
    const ledger = await prisma.inventoryTransaction.findMany({ where: { variant: { productId: r1.product.id } }, orderBy: { createdAt: "asc" } });
    check("One receiving record (reference 'Initial stock', 3 lines, user, warehouse, location) is written", !!receipt && receipt.userId === admin.id && receipt.warehouseId === W1.id && receipt.items.length === 3 && receipt.items.every((i) => i.locationId === main1.id) && receipt.id === r1.stock?.receivingId && /created/.test(receipt.notes ?? ""));
    check("Ledger: exactly 3 RECEIVE rows with before/after, user, warehouse, location and the receipt reference — no direct balance write", ledger.length === 3 && (await prisma.inventoryTransaction.count()) === before + 3 && ledger.every((t) => t.type === "RECEIVE" && t.userId === admin.id && t.warehouseId === W1.id && t.locationId === main1.id && t.receivingId === receipt?.id && t.beforeQty === 0 && t.afterQty === t.quantity) && ledger.map((t) => t.quantity).sort((a, b) => a - b).join(",") === "15,25,30");
    const audit = await prisma.auditLog.findMany({ where: { OR: [{ entityId: r1.product.id }, { entityId: receipt?.id ?? "" }] }, select: { action: true } });
    check("Audit: product.created and inventory.received recorded", audit.some((a) => a.action === "product.created") && audit.some((a) => a.action === "inventory.received"));
    const consistency = await Promise.all(r1.product.variants.filter((v) => [sku("T0"), sku("T1"), sku("T2")].includes(v.sku)).map((v) => inventory.verifyLedgerConsistency(v.id, W1.id)));
    check("Ledger consistency holds (balance = Σ levels = Σ ledger) for the new SKUs", consistency.every((c) => c.consistent) && consistency.map((c) => c.onHand).sort((a, b) => a - b).join(",") === "15,25,30");

    // ---------------------------------------------------------------- 3. warehouse/location respected (3PL owner, non-default location)
    const values3pl = productFormSchema.parse({ ownerId: C.id, name: `IS Client Box ${RUN}`, status: "ACTIVE", variants: [{ sku: sku("BOX"), price: "4.00", initialQuantity: "12", status: "ACTIVE" }] });
    const r2 = await products.createProductWithInitialStock(values3pl, { warehouseId: W2.id, locationId: bin.id }, admin.id);
    const boxStock = await inventory.stockForVariant(r2.product.variants[0].id);
    const boxLevel = await prisma.inventoryLevel.findFirst({ where: { variantId: r2.product.variants[0].id } });
    check("3PL-owned product: 12 units land in the chosen warehouse (W2) and the chosen non-default location (A-01)", boxStock.length === 1 && boxStock[0].warehouse.id === W2.id && boxStock[0].onHand === 12 && boxLevel?.locationId === bin.id && boxLevel.warehouseId === W2.id && (await prisma.receivingRecord.findFirst({ where: { ownerId: C.id, reference: "Initial stock" } }))?.warehouseId === W2.id);
    check("Vendor stock never appears under the 3PL client and vice versa (owner scoping)", (await inventory.listStock({ ownerId: C.id })).items.every((s) => s.variant.sku === sku("BOX")) && (await inventory.listStock({ ownerId: V.id })).items.every((s) => s.variant.sku.startsWith(sku("T"))));

    // ---------------------------------------------------------------- 5. product creation without initial inventory
    const plain = await products.createProductWithInitialStock(productFormSchema.parse({ ownerId: V.id, name: `IS Plain ${RUN}`, status: "ACTIVE", variants: [{ sku: sku("PLAIN"), initialQuantity: "", status: "ACTIVE" }, { sku: sku("PLAIN0"), initialQuantity: "0", status: "ACTIVE" }] }), null, admin.id);
    check("Blank / zero quantities: product created, no receipt, no ledger rows, stock zero", plain.stock === null && plain.product.variants.length === 2 && (await prisma.inventoryTransaction.count({ where: { variant: { productId: plain.product.id } } })) === 0 && (await inventory.stockForVariant(plain.product.variants[0].id)).length === 0);
    const noWarehouse = await expectError(() => products.createProductWithInitialStock(productFormSchema.parse({ ownerId: V.id, name: `IS NoWh ${RUN}`, status: "ACTIVE", variants: [{ sku: sku("NOWH"), initialQuantity: "5", status: "ACTIVE" }] }), null, admin.id));
    check("Quantity without a warehouse/location is refused before anything is created", noWarehouse.hit && (await prisma.productVariant.count({ where: { sku: sku("NOWH") } })) === 0);

    // ---------------------------------------------------------------- compensation: receipt refused → product removed again
    const wrongLocation = await expectError(() => products.createProductWithInitialStock(productFormSchema.parse({ ownerId: V.id, name: `IS Wrong ${RUN}`, status: "ACTIVE", variants: [{ sku: sku("WRONG"), initialQuantity: "3", status: "ACTIVE" }] }), { warehouseId: W1.id, locationId: main2.id }, admin.id));
    check("A location of another warehouse is refused by the inventory service and the product is rolled back (all-or-nothing)", wrongLocation.hit && (await prisma.productVariant.count({ where: { sku: sku("WRONG") } })) === 0 && (await prisma.product.count({ where: { name: `IS Wrong ${RUN}` } })) === 0);
    check("Existing behaviour unchanged: plain createProduct still ignores stock fields and writes no ledger", (await products.createProduct(productFormSchema.parse({ ownerId: V.id, name: `IS Legacy ${RUN}`, status: "ACTIVE", variants: [{ sku: sku("LEG"), initialQuantity: "9", status: "ACTIVE" }] }), admin.id)).variants.length === 1 && (await prisma.inventoryTransaction.count({ where: { variant: { sku: sku("LEG") } } })) === 0);

    // ---------------------------------------------------------------- HTTP: new product page shows the initial inventory card
    let adminCookie = "";
    try {
      const { firebaseAdminAuth } = await import("../src/lib/firebase/admin");
      const u = await users.createUserAccount({ name: "IS Admin", email: `${RUN.toLowerCase()}-admin@example.test`, password: "E2eTestPass123", role: "ADMIN", ownerId: null, phone: null, notes: null }, admin.id);
      created.userIds.push(u.id);
      created.firebaseUids.push(u.firebaseUid);
      const custom = await firebaseAdminAuth().createCustomToken(u.firebaseUid);
      const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${process.env.NEXT_PUBLIC_FIREBASE_API_KEY}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: custom, returnSecureToken: true }) });
      const { idToken } = await r.json();
      const res = await fetch(`${base}/api/auth/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken, audience: "staff" }) });
      adminCookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
    } catch (err) {
      console.log(`      (session unavailable: ${(err as Error).message.slice(0, 100)})`);
    }
    if (!adminCookie) {
      skip("HTTP: new product page renders the Initial inventory card with warehouse/location and per-SKU quantity", "no session");
      skip("HTTP: edit page has no initial inventory card (create flow only)", "no session");
    } else {
      const get = (path: string) => fetch(`${base}${path}`, { redirect: "manual", headers: { Cookie: adminCookie } });
      let html = (await (await get("/admin/products/new")).text()).replace(/<!--[\s\S]*?-->/g, "");
      check("HTTP: new product page renders the Initial inventory card with warehouse/location and per-SKU quantity", html.includes('data-slot="initial-stock"') && html.includes("Initial inventory (optional)") && html.includes(`${RUN}-W1`) && html.includes("Initial quantity for") && html.includes("Location"));
      html = (await (await get(`/admin/products/${r1.product.id}/edit`)).text()).replace(/<!--[\s\S]*?-->/g, "");
      check("HTTP: edit page has no initial inventory card (create flow only)", !html.includes('data-slot="initial-stock"') && html.includes("25 on hand"));
    }
  } finally {
    const { firebaseAdminAuth } = await import("../src/lib/firebase/admin");
    for (const uid of created.firebaseUids) await firebaseAdminAuth().deleteUser(uid).catch(() => undefined);
    const productIds = (await prisma.product.findMany({ where: { ownerId: { in: created.ownerIds } }, select: { id: true } })).map((p) => p.id);
    await prisma.inventoryTransaction.deleteMany({ where: { OR: [{ variant: { productId: { in: productIds } } }, { warehouseId: { in: created.warehouseIds } }] } });
    await prisma.inventoryLevel.deleteMany({ where: { OR: [{ variant: { productId: { in: productIds } } }, { warehouseId: { in: created.warehouseIds } }] } });
    await prisma.inventoryBalance.deleteMany({ where: { OR: [{ variant: { productId: { in: productIds } } }, { warehouseId: { in: created.warehouseIds } }] } });
    await prisma.receivingItem.deleteMany({ where: { OR: [{ variant: { productId: { in: productIds } } }, { receiving: { warehouseId: { in: created.warehouseIds } } }] } });
    await prisma.receivingRecord.deleteMany({ where: { OR: [{ ownerId: { in: created.ownerIds } }, { warehouseId: { in: created.warehouseIds } }] } });
    await prisma.productVariant.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.location.deleteMany({ where: { warehouseId: { in: created.warehouseIds } } });
    await prisma.warehouse.deleteMany({ where: { id: { in: created.warehouseIds } } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: [...created.ownerIds, ...productIds, ...created.warehouseIds, ...created.userIds] } }, { userId: { in: created.userIds } }, { entityType: "ReceivingRecord", newValues: { path: ["ownerId"], string_contains: RUN.slice(0, 2) } }] } });
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
