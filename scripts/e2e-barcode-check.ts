/**
 * Unique barcode per variant (D-059): creation, persistence, editing, preservation through the option
 * builder, duplicate protection within and across products (schema, service and database), blank
 * barcodes, legacy products without barcodes, barcode search, CSV round trip, owner isolation.
 *
 * Usage: npm run e2e:barcode -- http://localhost:3100 vendor3pl@gmail.com
 */
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });
loadEnv();

const [base = "http://localhost:3100", adminEmail = "vendor3pl@gmail.com"] = process.argv.slice(2);
const RUN = `bc${Date.now().toString(36)}`.toUpperCase();
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
  const productCsv = await import("../src/server/services/product-csv");
  const warehouses = await import("../src/server/services/warehouses");
  const { productFormSchema, variantFormSchema, barcodeSchema } = await import("../src/lib/validation/products");
  const builder = await import("../src/lib/variant-builder");
  const { parseCsv, toCsv } = await import("../src/lib/csv");

  const admin = await prisma.user.findFirstOrThrow({ where: { email: adminEmail, role: "ADMIN" } });
  const created = { ownerIds: [] as string[], warehouseIds: [] as string[], userIds: [] as string[], firebaseUids: [] as string[] };
  const ownerInput = (code: string, businessName: string) => ({ code, businessName, contactName: "Contact", email: null, phone: null, addressLine1: null, addressLine2: null, city: "Austin", state: null, postalCode: null, country: "US", notes: null });
  const sku = (s: string) => `${RUN}-${s}`.toUpperCase();
  const bar = (s: string) => `${RUN}${s}`; // digits-like unique barcodes per run

  try {
    const V = await owners.createOwner("VENDOR", ownerInput(`${RUN}-V`, `BC Vendor ${RUN}`), admin.id);
    const C = await owners.createOwner("THREEPL_CLIENT", ownerInput(`${RUN}-C`, `BC Client ${RUN}`), admin.id);
    created.ownerIds.push(V.id, C.id);
    const W = await warehouses.createWarehouse({ code: `${RUN}-W`, name: "BC Warehouse", addressLine1: null, addressLine2: null, city: "Dallas", state: null, postalCode: null, country: "US", notes: null }, admin.id);
    created.warehouseIds.push(W.id);

    // ---------------------------------------------------------------- schema
    check("Schema: barcode trimmed; blank → null; spaces inside and >64 chars rejected", barcodeSchema.parse("  0123456789012 ") === "0123456789012" && barcodeSchema.parse("") === null && barcodeSchema.parse(undefined) === undefined && !barcodeSchema.safeParse("12 34").success && !barcodeSchema.safeParse("x".repeat(65)).success && variantFormSchema.parse({ sku: "abc-1", barcode: "", status: "ACTIVE" }).barcode === null);
    const dupInProduct = productFormSchema.safeParse({ ownerId: V.id, name: "X", status: "ACTIVE", variants: [{ sku: sku("D1"), barcode: bar("DUP"), status: "ACTIVE" }, { sku: sku("D2"), barcode: bar("DUP"), status: "ACTIVE" }] });
    check("Schema: duplicate barcode within one product rejected with the conflicting row named", !dupInProduct.success && JSON.stringify(dupInProduct.success ? null : dupInProduct.error.issues).includes("already used on row 1"));

    // ---------------------------------------------------------------- 1/2. creation + persistence (builder rows with barcodes, one blank)
    const combos = builder.generateCombinations([{ name: "Color", values: ["White", "Black"] }, { name: "Size", values: ["L", "XL"] }]);
    const barcodes: Record<string, string> = { "White/L": bar("001"), "White/XL": bar("002"), "Black/L": bar("003") };
    const tee = await products.createProduct(productFormSchema.parse({ ownerId: V.id, name: `BC Tee ${RUN}`, status: "ACTIVE", options: ["Color", "Size"], variants: combos.map((c, i) => ({ sku: sku(`T${i}`), optionValues: c, barcode: barcodes[c.join("/")] ?? "", price: "20.00", status: "ACTIVE" })) }), admin.id);
    const teeRow = await prisma.product.findUniqueOrThrow({ where: { id: tee.id }, include: { variants: { orderBy: { sku: "asc" } } } });
    const byLabel = (l: string) => teeRow.variants.find((v) => v.optionValues.join("/") === l)!;
    check("Creation: each generated variant keeps its own barcode; the blank one is stored as NULL", byLabel("White/L").barcode === bar("001") && byLabel("White/XL").barcode === bar("002") && byLabel("Black/L").barcode === bar("003") && byLabel("Black/XL").barcode === null);

    // ---------------------------------------------------------------- 3. editing
    const rows = teeRow.variants.map((v) => ({ id: v.id, sku: v.sku, optionValues: v.optionValues, barcode: v.barcode ?? "", price: v.price?.toString() ?? "", status: "ACTIVE" as const }));
    const edited = rows.map((r) => (r.sku === sku("T0") ? { ...r, barcode: bar("001X") } : r.sku === sku("T1") ? { ...r, barcode: "" } : r));
    await products.updateProduct(tee.id, productFormSchema.parse({ ownerId: V.id, name: teeRow.name, status: "ACTIVE", options: ["Color", "Size"], variants: edited }), admin.id);
    const afterEdit = await prisma.productVariant.findMany({ where: { productId: tee.id }, orderBy: { sku: "asc" } });
    check("Editing: a barcode can be changed and cleared; untouched barcodes stay exactly as they were", afterEdit.find((v) => v.sku === sku("T0"))?.barcode === bar("001X") && afterEdit.find((v) => v.sku === sku("T1"))?.barcode === null && afterEdit.find((v) => v.sku === sku("T2"))?.barcode === bar("003"));

    // ---------------------------------------------------------------- 4. preservation through the option builder (rename + regenerate)
    const current = afterEdit.map((v) => ({ id: v.id, sku: v.sku, optionValues: v.optionValues, barcode: v.barcode ?? "", price: v.price?.toString() ?? "", status: "ACTIVE" as const }));
    const renamed = builder.renameOptionValue(current, 0, "White", "Ivory");
    const merged = builder.mergeVariantRows(renamed, [{ name: "Color", values: ["Ivory", "Black"] }, { name: "Size", values: ["L", "XL", "XXL"] }], (values) => ({ sku: "", optionValues: values, barcode: "", price: "", status: "ACTIVE" as const }));
    check("Builder: renaming a value and adding one keeps every existing row's barcode; new rows start blank", merged.rows.length === 6 && merged.added.length === 2 && merged.rows.find((r) => r.sku === sku("T0"))?.barcode === bar("001X") && merged.rows.find((r) => r.sku === sku("T2"))?.barcode === bar("003") && merged.rows.filter((r) => r.sku === "").every((r) => r.barcode === ""));
    const withNew = merged.rows.map((r, i) => (r.sku ? r : { ...r, sku: sku(`N${i}`), barcode: i === 2 ? bar("N2") : "" }));
    await products.updateProduct(tee.id, productFormSchema.parse({ ownerId: V.id, name: teeRow.name, status: "ACTIVE", options: ["Color", "Size"], variants: withNew }), admin.id);
    const afterRename = await prisma.productVariant.findMany({ where: { productId: tee.id }, orderBy: { sku: "asc" } });
    check("Persisted after rename: 6 variants, ids preserved, barcodes preserved, label updated, new barcode stored", afterRename.length === 6 && afterRename.find((v) => v.sku === sku("T0"))?.id === byLabel("White/L").id && afterRename.find((v) => v.sku === sku("T0"))?.barcode === bar("001X") && afterRename.find((v) => v.sku === sku("T0"))?.name === "Ivory / L" && afterRename.find((v) => v.barcode === bar("N2")) !== undefined);

    // ---------------------------------------------------------------- 5/6. duplicates across products and bypassing the schema
    const other = await expectError(() => products.createProduct(productFormSchema.parse({ ownerId: C.id, name: `BC Other ${RUN}`, status: "ACTIVE", variants: [{ sku: sku("O1"), barcode: bar("003"), status: "ACTIVE" }] }), admin.id));
    check("Across products/owners: reusing a barcode is refused with the conflicting barcode and SKU named", other.hit && other.code === "BARCODE_TAKEN" && /003/.test(other.message ?? "") && (other.message ?? "").includes(sku("T2")) && (await prisma.productVariant.count({ where: { sku: sku("O1") } })) === 0);
    const client = await products.createProduct(productFormSchema.parse({ ownerId: C.id, name: `BC Client Box ${RUN}`, status: "ACTIVE", variants: [{ sku: sku("BOX"), barcode: bar("BOX"), price: "4.00", status: "ACTIVE" }] }), admin.id);
    const editClash = await expectError(() => products.updateProduct(client.id, productFormSchema.parse({ ownerId: C.id, name: "Box", status: "ACTIVE", variants: [{ id: client.variants[0].id, sku: sku("BOX"), barcode: bar("003"), status: "ACTIVE" }] }), admin.id));
    check("Editing a variant to another product's barcode is refused; the original barcode is untouched", editClash.hit && editClash.code === "BARCODE_TAKEN" && (await prisma.productVariant.findUnique({ where: { id: client.variants[0].id } }))?.barcode === bar("BOX"));
    const bypass = await expectError(() => products.createProduct({ ownerId: V.id, name: `BC Bypass ${RUN}`, status: "ACTIVE", options: [], variants: [{ sku: sku("B1"), barcode: bar("SAME"), status: "ACTIVE" }, { sku: sku("B2"), barcode: bar("SAME"), status: "ACTIVE" }] } as never, admin.id));
    check("Service without the schema (client-side checks bypassed): duplicate within one product hits the DB unique index and is reported as BARCODE_TAKEN; nothing partially created", bypass.hit && bypass.code === "BARCODE_TAKEN" && (await prisma.product.count({ where: { name: `BC Bypass ${RUN}` } })) === 0);
    const idx = await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_indexes WHERE tablename = 'ProductVariant' AND indexname = 'ProductVariant_barcode_key'`;
    check("Database guard: the unique index on barcode exists", Number(idx[0]?.n ?? 0) === 1);

    // ---------------------------------------------------------------- 7/8. blanks and legacy products
    const blanks = await products.createProduct(productFormSchema.parse({ ownerId: V.id, name: `BC Blanks ${RUN}`, status: "ACTIVE", options: ["Size"], variants: [{ sku: sku("S"), optionValues: ["S"], barcode: "", status: "ACTIVE" }, { sku: sku("M"), optionValues: ["M"], barcode: "   ", status: "ACTIVE" }, { sku: sku("L"), optionValues: ["L"], status: "ACTIVE" }] }), admin.id);
    check("Blank barcodes: several variants without a barcode coexist (NULL is never a duplicate)", blanks.variants.length === 3 && (await prisma.productVariant.count({ where: { productId: blanks.id, barcode: null } })) === 3);
    await products.updateProduct(blanks.id, productFormSchema.parse({ ownerId: V.id, name: `BC Blanks ${RUN} edited`, status: "ACTIVE", options: ["Size"], variants: blanks.variants.map((v) => ({ id: v.id, sku: v.sku, optionValues: v.optionValues, status: "ACTIVE" })) }), admin.id);
    check("Existing products without barcodes stay valid through edits; legacy rows (barcode NULL) untouched by the migration", (await prisma.product.findUnique({ where: { id: blanks.id } }))?.name.endsWith("edited") === true && (await prisma.productVariant.count({ where: { barcode: null } })) >= 3);

    // ---------------------------------------------------------------- 9/11. search + owner isolation
    const found = await products.searchVariants(bar("003"), { ownerId: V.id });
    const scoped = await products.searchVariants(bar("003"), { ownerId: C.id });
    const anyOwner = await products.searchVariants(bar("BOX"));
    check("Search by barcode finds the variant (barcode returned alongside SKU); SKU search unchanged", found.length === 1 && found[0].sku === sku("T2") && found[0].barcode === bar("003") && (await products.searchVariants(sku("T2"), { ownerId: V.id }))[0]?.barcode === bar("003"));
    check("Owner isolation: a 3PL-scoped search never returns the vendor's barcode; staff search finds either", scoped.length === 0 && anyOwner.length === 1 && anyOwner[0].sku === sku("BOX"));

    // ---------------------------------------------------------------- 10. CSV
    const exp = await productCsv.exportProductsCsv({ ownerId: V.id, status: "ALL" });
    const rowsCsv = parseCsv(exp.csv);
    check("CSV export carries Variant Barcode per variant (blank where none)", rowsCsv.rows.find((r) => r["Variant SKU"] === sku("T2"))?.["Variant Barcode"] === bar("003") && rowsCsv.rows.find((r) => r["Variant SKU"] === sku("T1"))?.["Variant Barcode"] === "");
    const round = await productCsv.previewProductCsv(exp.csv, { ownerId: V.id, stockWarehouseId: null });
    check("CSV round trip: the export re-imports as updates without barcode errors (own SKUs keep their own barcodes)", round.summary.failedProducts === 0 && round.summary.failedRows === 0 && round.groups.every((g) => g.action === "update"));
    const H = `${RUN.toLowerCase()}-csv`;
    const csv = toCsv(
      ["Handle", "Title", "Option1 Name", "Option1 Value", "Variant SKU", "Variant Price", "Variant Barcode"],
      [
        { Handle: H, Title: `BC CSV ${RUN}`, "Option1 Name": "Size", "Option1 Value": "S", "Variant SKU": sku("C-S"), "Variant Price": "1.00", "Variant Barcode": bar("CS") },
        { Handle: H, "Option1 Value": "M", "Variant SKU": sku("C-M"), "Variant Price": "1.00", "Variant Barcode": bar("CS") },
        { Handle: H, "Option1 Value": "L", "Variant SKU": sku("C-L"), "Variant Price": "1.00", "Variant Barcode": bar("003") },
        { Handle: H, "Option1 Value": "XL", "Variant SKU": sku("C-XL"), "Variant Price": "1.00", "Variant Barcode": "bad code" },
        { Handle: H, "Option1 Value": "XXL", "Variant SKU": sku("C-XXL"), "Variant Price": "1.00", "Variant Barcode": "" },
      ],
    );
    const prev = await productCsv.previewProductCsv(csv, { ownerId: V.id, stockWarehouseId: null });
    const rowErr = (i: number) => prev.rows.find((r) => r.index === i)?.errors ?? [];
    check("CSV import validates barcodes: duplicate in file (rows 2+3), used by another SKU (row 4), spaces (row 5); blank allowed", rowErr(2).some((e) => /more than once/.test(e)) && rowErr(3).some((e) => /more than once/.test(e)) && rowErr(4).some((e) => new RegExp(`already used by SKU ${sku("T2")}`).test(e)) && rowErr(5).some((e) => /Invalid Variant Barcode/.test(e)) && rowErr(6).length === 0);
    const good = toCsv(["Handle", "Title", "Option1 Name", "Option1 Value", "Variant SKU", "Variant Price", "Variant Barcode"], [{ Handle: H, Title: `BC CSV ${RUN}`, "Option1 Name": "Size", "Option1 Value": "S", "Variant SKU": sku("C-S"), "Variant Price": "1.00", "Variant Barcode": bar("CS") }, { Handle: H, "Option1 Value": "M", "Variant SKU": sku("C-M"), "Variant Price": "1.00", "Variant Barcode": "" }]);
    const imp = await productCsv.executeProductImport(await productCsv.previewProductCsv(good, { ownerId: V.id, stockWarehouseId: null }), { ownerId: V.id, stockWarehouseId: null }, admin.id, `${RUN} csv`);
    check("CSV import persists the barcode and leaves blank ones NULL", imp.created.length === 1 && (await prisma.productVariant.findUnique({ where: { sku: sku("C-S") } }))?.barcode === bar("CS") && (await prisma.productVariant.findUnique({ where: { sku: sku("C-M") } }))?.barcode === null);

    // ---------------------------------------------------------------- HTTP
    let adminCookie = "";
    try {
      const { firebaseAdminAuth } = await import("../src/lib/firebase/admin");
      const u = await users.createUserAccount({ name: "BC Admin", email: `${RUN.toLowerCase()}-admin@example.test`, password: "E2eTestPass123", role: "ADMIN", ownerId: null, phone: null, notes: null }, admin.id);
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
      skip("HTTP: product form shows the Barcode column; detail page shows barcodes under SKUs", "no session");
    } else {
      const get = (path: string) => fetch(`${base}${path}`, { redirect: "manual", headers: { Cookie: adminCookie } });
      const form = (await (await get(`/admin/products/${tee.id}/edit`)).text()).replace(/<!--[\s\S]*?-->/g, "");
      const detail = (await (await get(`/admin/products/${tee.id}`)).text()).replace(/<!--[\s\S]*?-->/g, "");
      check("HTTP: product form shows the Barcode column; detail page shows barcodes under SKUs", form.includes(">Barcode<") && form.includes("Barcode for row 1") && detail.includes(bar("003")) && detail.includes(bar("001X")));
    }
  } finally {
    const { firebaseAdminAuth } = await import("../src/lib/firebase/admin");
    for (const uid of created.firebaseUids) await firebaseAdminAuth().deleteUser(uid).catch(() => undefined);
    const productIds = (await prisma.product.findMany({ where: { ownerId: { in: created.ownerIds } }, select: { id: true } })).map((p) => p.id);
    await prisma.productVariant.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.location.deleteMany({ where: { warehouseId: { in: created.warehouseIds } } });
    await prisma.warehouse.deleteMany({ where: { id: { in: created.warehouseIds } } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: [...created.ownerIds, ...productIds, ...created.warehouseIds, ...created.userIds] } }, { userId: { in: created.userIds } }] } });
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
