/**
 * Batch 2 check — Product & SKU enhancements (D-057; QA PRD-03/08, PRC-01/03/04, SKU-01/03, UI-11):
 * - option/value builder: combinations for 1, 2 and 3 options, preservation of existing rows, renames,
 *   removals, locked (history) rows, duplicate protection
 * - variant/SKU integrity: server-side duplicate SKU protection, product-level inventory computed
 * - wholesale price + weight/dimensions persisted through service, CSV export/import
 * - retail price still defaults order lines; wholesale never used for orders
 * - Shopify store conflict detection (read-only, mappings untouched)
 * - HTTP: product pages render the builder, wholesale and physical data
 *
 * Usage: npm run e2e:batch2 -- http://localhost:3100 vendor3pl@gmail.com
 */
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });
loadEnv();

const [base = "http://localhost:3100", adminEmail = "vendor3pl@gmail.com"] = process.argv.slice(2);
const RUN = `b2${Date.now().toString(36)}`.toUpperCase();
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
  const receiving = await import("../src/server/services/receiving");
  const orders = await import("../src/server/services/orders");
  const { productFormSchema, variantFormSchema } = await import("../src/lib/validation/products");
  const builder = await import("../src/lib/variant-builder");
  const { parseCsv } = await import("../src/lib/csv");

  const admin = await prisma.user.findFirstOrThrow({ where: { email: adminEmail, role: "ADMIN" } });
  const created = { ownerIds: [] as string[], warehouseIds: [] as string[], userIds: [] as string[], firebaseUids: [] as string[], orderIds: new Set<string>(), storeIds: [] as string[] };
  const ownerInput = (code: string, businessName: string) => ({ code, businessName, contactName: "Contact", email: null, phone: null, addressLine1: null, addressLine2: null, city: "Austin", state: null, postalCode: null, country: "US", notes: null });
  const sku = (s: string) => `${RUN}-${s}`.toUpperCase();
  type Row = { id?: string; sku: string; optionValues?: string[]; price?: string | null };
  const blank = (values: string[]): Row => ({ sku: "", optionValues: values, price: "" });

  try {
    const A = await owners.createOwner("VENDOR", ownerInput(`${RUN}-A`, `B2 Vendor ${RUN}`), admin.id);
    const B = await owners.createOwner("THREEPL_CLIENT", ownerInput(`${RUN}-B`, `B2 Client ${RUN}`), admin.id);
    created.ownerIds.push(A.id, B.id);
    const W = await warehouses.createWarehouse({ code: `${RUN}-W`, name: "B2 Warehouse", addressLine1: null, addressLine2: null, city: "Dallas", state: null, postalCode: null, country: "US", notes: null }, admin.id);
    created.warehouseIds.push(W.id);
    const main = (await warehouses.getDefaultLocation(W.id))!;

    // ---------------------------------------------------------------- 1. builder: combinations
    check("parseOptionValues trims, splits on commas/semicolons/newlines and de-duplicates case-insensitively", builder.parseOptionValues(" White, Black ;white\nBLACK, Grey ").join("|") === "White|Black|Grey");
    const one = builder.generateCombinations([{ name: "Size", values: ["S", "M"] }]);
    const two = builder.generateCombinations([{ name: "Color", values: ["White", "Black"] }, { name: "Size", values: ["L", "XL", "XXL"] }]);
    const three = builder.generateCombinations([{ name: "Color", values: ["White", "Black"] }, { name: "Size", values: ["L", "XL"] }, { name: "Material", values: ["Cotton", "Linen"] }]);
    check("1 option → 2 combinations; 2 options (2×3) → 6 in Shopify order (first option slowest); 3 options (2×2×2) → 8", one.length === 2 && two.length === 6 && two.map((c) => c.join("/")).join(",") === "White/L,White/XL,White/XXL,Black/L,Black/XL,Black/XXL" && three.length === 8 && three[0].join("/") === "White/L/Cotton" && three[7].join("/") === "Black/XL/Linen");
    check("An option without values (or no options) yields no combinations", builder.generateCombinations([{ name: "Color", values: ["White"] }, { name: "Size", values: [] }]).length === 0 && builder.generateCombinations([]).length === 0);
    check("Duplicate combinations are detected case-insensitively", builder.duplicateCombinationIndexes([{ optionValues: ["White", "L"] }, { optionValues: ["white", "l"] }, { optionValues: ["Black", "L"] }], 2).join(",") === "1");

    // ---------------------------------------------------------------- 2. builder: merge / preserve / rename / locked
    const existing: Row[] = [{ id: "v1", sku: "TS-WHT-L", optionValues: ["White", "L"], price: "20" }, { id: "v2", sku: "TS-WHT-XL", optionValues: ["White", "XL"], price: "21" }];
    const grown = builder.mergeVariantRows(existing, [{ name: "Color", values: ["White", "Black"] }, { name: "Size", values: ["L", "XL"] }], blank);
    check("Adding a value keeps existing rows (SKU, price, id) and adds only the new combinations", grown.rows.length === 4 && grown.rows[0].sku === "TS-WHT-L" && grown.rows[0].id === "v1" && grown.rows[1].price === "21" && grown.added.length === 2 && grown.added.map((a) => a.join("/")).join(",") === "Black/L,Black/XL" && grown.removed.length === 0);
    const shrunk = builder.mergeVariantRows(grown.rows, [{ name: "Color", values: ["White"] }, { name: "Size", values: ["L", "XL"] }], blank);
    check("Removing a value drops its (unlocked) combinations and keeps the rest untouched", shrunk.rows.length === 2 && shrunk.removed.length === 2 && shrunk.rows.every((r) => r.optionValues[0] === "White") && shrunk.rows[0].sku === "TS-WHT-L");
    const lockedRows: Row[] = [...existing, { id: "v3", sku: "TS-BLK-L", optionValues: ["Black", "L"], price: "22" }];
    const withLocked = builder.mergeVariantRows(lockedRows, [{ name: "Color", values: ["White"] }, { name: "Size", values: ["L", "XL"] }], blank, (r) => r.id === "v3");
    check("A row with stock history whose value was removed is kept as orphaned (never dropped)", withLocked.rows.length === 3 && withLocked.orphaned.length === 1 && withLocked.orphaned[0].sku === "TS-BLK-L" && withLocked.removed.length === 0);
    const renamed = builder.renameOptionValue(grown.rows, 0, "white", "Ivory");
    const afterRename = builder.mergeVariantRows(renamed, [{ name: "Color", values: ["Ivory", "Black"] }, { name: "Size", values: ["L", "XL"] }], blank);
    check("Renaming a value updates the rows in place so their SKUs survive regeneration", renamed[0].optionValues?.[0] === "Ivory" && afterRename.rows.length === 4 && afterRename.added.length === 0 && afterRename.rows[0].sku === "TS-WHT-L");
    check("Duplicate values in the input never produce duplicate combinations", builder.mergeVariantRows([], [{ name: "Size", values: builder.parseOptionValues("S, s, M") }], blank).rows.length === 2);
    check("valuesFromRows derives the option value lists from variants (source of truth)", builder.valuesFromRows(grown.rows, 2).map((l) => l.join("/")).join(";") === "White/Black;L/XL");

    // ---------------------------------------------------------------- 3. schema: new fields
    const parsedVariant = variantFormSchema.parse({ sku: "abc-1", price: "10", wholesalePrice: "7.50", weightGrams: "250", lengthCm: "10.5", widthCm: "", heightCm: "3", status: "ACTIVE" });
    check("Variant schema: wholesale price, grams (number) and centimetres parse; blanks become null", parsedVariant.wholesalePrice === "7.50" && parsedVariant.weightGrams === 250 && parsedVariant.lengthCm === "10.5" && parsedVariant.widthCm === null && parsedVariant.heightCm === "3");
    check("Variant schema rejects non-numeric grams, negative/3-decimal centimetres and bad wholesale price", !variantFormSchema.safeParse({ sku: "abc-1", weightGrams: "12g", status: "ACTIVE" }).success && !variantFormSchema.safeParse({ sku: "abc-1", lengthCm: "-1", status: "ACTIVE" }).success && !variantFormSchema.safeParse({ sku: "abc-1", heightCm: "1.234", status: "ACTIVE" }).success && !variantFormSchema.safeParse({ sku: "abc-1", wholesalePrice: "x", status: "ACTIVE" }).success);
    check("Product schema still rejects duplicate SKUs and duplicate combinations", !productFormSchema.safeParse({ ownerId: A.id, name: "X", status: "ACTIVE", variants: [{ sku: sku("D"), status: "ACTIVE" }, { sku: sku("d"), status: "ACTIVE" }] }).success && !productFormSchema.safeParse({ ownerId: A.id, name: "X", status: "ACTIVE", options: ["Size"], variants: [{ sku: sku("D1"), optionValues: ["S"], status: "ACTIVE" }, { sku: sku("D2"), optionValues: ["s"], status: "ACTIVE" }] }).success);

    // ---------------------------------------------------------------- 4. service: 3-option product with all fields
    const combos = builder.generateCombinations([{ name: "Color", values: ["White", "Black"] }, { name: "Size", values: ["L", "XL"] }, { name: "Material", values: ["Cotton", "Linen"] }]);
    const tee = await products.createProduct(
      productFormSchema.parse({
        ownerId: A.id,
        name: `B2 Tee ${RUN}`,
        status: "ACTIVE",
        options: ["Color", "Size", "Material"],
        variants: combos.map((values, i) => ({ sku: sku(`T${i}`), optionValues: values, price: `${20 + i}.00`, wholesalePrice: `${12 + i}.50`, weightGrams: String(200 + i), lengthCm: "30", widthCm: "20.5", heightCm: "2", status: "ACTIVE" })),
      }),
      admin.id,
    );
    const teeRow = await prisma.product.findUniqueOrThrow({ where: { id: tee.id }, include: { variants: { orderBy: { sku: "asc" } } } });
    const t0 = teeRow.variants.find((v) => v.sku === sku("T0"))!;
    check("3-option product persisted: 8 variants, labels derived, wholesale/weight/dimensions stored per variant", teeRow.options.length === 3 && teeRow.variants.length === 8 && t0.name === "White / L / Cotton" && t0.price?.toString() === "20" && t0.wholesalePrice?.toString() === "12.5" && t0.weightGrams === 200 && t0.lengthCm?.toString() === "30" && t0.widthCm?.toString() === "20.5" && t0.heightCm?.toString() === "2");

    // Edit safely: rename "White" → "Ivory", drop "Linen" (no history) — ids/SKUs of surviving rows preserved.
    type FullRow = Row & { wholesalePrice: string; weightGrams: string; lengthCm: string; widthCm: string; heightCm: string };
    const rows: FullRow[] = teeRow.variants.map((v) => ({ id: v.id, sku: v.sku, optionValues: v.optionValues, price: v.price?.toString() ?? "", wholesalePrice: v.wholesalePrice?.toString() ?? "", weightGrams: v.weightGrams?.toString() ?? "", lengthCm: v.lengthCm?.toString() ?? "", widthCm: v.widthCm?.toString() ?? "", heightCm: v.heightCm?.toString() ?? "" }));
    const renamedRows = builder.renameOptionValue(rows, 0, "White", "Ivory");
    const merged = builder.mergeVariantRows(renamedRows, [{ name: "Color", values: ["Ivory", "Black"] }, { name: "Size", values: ["L", "XL"] }, { name: "Material", values: ["Cotton"] }], (values) => ({ ...blank(values), wholesalePrice: "", weightGrams: "", lengthCm: "", widthCm: "", heightCm: "" }));
    await products.updateProduct(tee.id, productFormSchema.parse({ ownerId: A.id, name: teeRow.name, status: "ACTIVE", options: ["Color", "Size", "Material"], variants: merged.rows.map((r) => ({ id: r.id, sku: r.sku, optionValues: r.optionValues, price: r.price, wholesalePrice: r.wholesalePrice, weightGrams: r.weightGrams, lengthCm: r.lengthCm, widthCm: r.widthCm, heightCm: r.heightCm, status: "ACTIVE" })) }), admin.id);
    const teeV2 = await prisma.product.findUniqueOrThrow({ where: { id: tee.id }, include: { variants: { orderBy: { sku: "asc" } } } });
    check("Edit: rename + remove value → 4 variants remain with their original ids and SKUs, labels updated, Linen rows gone", teeV2.variants.length === 4 && merged.removed.length === 4 && teeV2.variants.find((v) => v.sku === sku("T0"))?.id === t0.id && teeV2.variants.find((v) => v.sku === sku("T0"))?.name === "Ivory / L / Cotton" && !teeV2.variants.some((v) => v.optionValues.includes("Linen")));
    check("Edit preserves wholesale price, weight and dimensions of the surviving variants", teeV2.variants.find((v) => v.sku === sku("T0"))?.wholesalePrice?.toString() === "12.5" && teeV2.variants.find((v) => v.sku === sku("T2"))?.weightGrams === 202 && teeV2.variants.find((v) => v.sku === sku("T2"))?.widthCm?.toString() === "20.5");

    // Locked variant: give T0 stock; removing its value must fail server-side unless kept
    await receiving.createReceiving({ ownerId: A.id, warehouseId: W.id, reference: `${RUN}-R`, notes: null, lines: [{ variantId: t0.id, locationId: main.id, quantity: 6 }] }, admin.id);
    const dropLocked = await expectError(() => products.updateProduct(tee.id, productFormSchema.parse({ ownerId: A.id, name: teeRow.name, status: "ACTIVE", options: ["Color", "Size", "Material"], variants: teeV2.variants.filter((v) => v.id !== t0.id).map((v) => ({ id: v.id, sku: v.sku, optionValues: v.optionValues, status: "ACTIVE" })) }), admin.id));
    check("Server refuses to drop a variant with stock history (builder keeps it as orphaned instead)", dropLocked.hit && dropLocked.code === "VARIANT_HAS_HISTORY");

    // ---------------------------------------------------------------- 5. SKU integrity + computed inventory
    const dupCreate = await expectError(() => products.createProduct(productFormSchema.parse({ ownerId: B.id, name: "Dup", status: "ACTIVE", variants: [{ sku: sku("T2"), status: "ACTIVE" }] }), admin.id));
    const other = await products.createProduct(productFormSchema.parse({ ownerId: B.id, name: `B2 Other ${RUN}`, status: "ACTIVE", variants: [{ sku: sku("O1"), price: "5.00", wholesalePrice: "3.00", status: "ACTIVE" }] }), admin.id);
    const dupUpdate = await expectError(() => products.updateProduct(other.id, productFormSchema.parse({ ownerId: B.id, name: "Other", status: "ACTIVE", variants: [{ id: other.variants[0].id, sku: sku("T2"), status: "ACTIVE" }] }), admin.id));
    check("Duplicate SKU protection server-side on create and on edit (SKU_TAKEN), across owners", dupCreate.hit && dupCreate.code === "SKU_TAKEN" && dupUpdate.hit && dupUpdate.code === "SKU_TAKEN");
    const list = await products.listProducts({ q: `B2 Tee ${RUN}`, status: "ALL" });
    const inv = products.inventorySummary(list.items[0].variants);
    check("Product-level inventory is computed from variants (6 on hand from one variant, 0 reserved)", inv.onHand === 6 && inv.reserved === 0 && inv.available === 6 && inv.warehouses === 1);

    // ---------------------------------------------------------------- 6. pricing: retail for orders
    const found = await products.searchVariants(sku("O1"), { ownerId: B.id });
    const o = await orders.createOrder({ source: "MANUAL", warehouseId: W.id, reserve: false, shipName: "B2 Price", lines: [{ variantId: other.variants[0].id, quantity: 1 }] }, admin.id);
    created.orderIds.add(o.orderId);
    const line = await prisma.orderItem.findFirstOrThrow({ where: { orderId: o.orderId } });
    check("SKU search exposes the retail price; an order line defaults to retail (5.00), never wholesale (3.00)", found[0]?.price?.toString() === "5" && line.unitPrice?.toString() === "5");
    const typed = await orders.createOrder({ source: "MANUAL", warehouseId: W.id, reserve: false, shipName: "B2 Typed", lines: [{ variantId: other.variants[0].id, quantity: 1, unitPrice: "4.25" }] }, admin.id);
    created.orderIds.add(typed.orderId);
    check("A typed unit price still overrides the saved retail price", (await prisma.orderItem.findFirstOrThrow({ where: { orderId: typed.orderId } })).unitPrice?.toString() === "4.25");

    // ---------------------------------------------------------------- 7. Shopify store conflicts (read-only)
    const s1 = await prisma.shopifyStore.create({ data: { name: `B2 Store One ${RUN}`, shopDomain: `${RUN.toLowerCase()}-one.myshopify.com`, apiVersion: "2026-07", status: "CONNECTED" } });
    const s2 = await prisma.shopifyStore.create({ data: { name: `B2 Store Two ${RUN}`, shopDomain: `${RUN.toLowerCase()}-two.myshopify.com`, apiVersion: "2026-07", status: "CONNECTED" } });
    const s3 = await prisma.shopifyStore.create({ data: { name: `B2 Store Pending ${RUN}`, shopDomain: `${RUN.toLowerCase()}-three.myshopify.com`, apiVersion: "2026-07", status: "PENDING_INSTALL" } });
    created.storeIds.push(s1.id, s2.id, s3.id);
    const gid = (n: number) => `gid://shopify/ProductVariant/${RUN}${n}`;
    await prisma.shopifyVariantMapping.createMany({
      data: [
        { storeId: s1.id, shopifyProductId: "gid://shopify/Product/1", shopifyVariantId: gid(1), shopifySku: sku("O1"), shopifyProductTitle: "Other in Shopify", status: "MATCHED", matchedBy: "SKU_EXACT", variantId: other.variants[0].id },
        { storeId: s1.id, shopifyProductId: "gid://shopify/Product/2", shopifyVariantId: gid(2), shopifySku: sku("NEW-1"), shopifyProductTitle: "Unmapped thing", status: "UNMATCHED" },
        { storeId: s2.id, shopifyProductId: "gid://shopify/Product/3", shopifyVariantId: gid(3), shopifySku: sku("NEW-1"), shopifyProductTitle: "Unmapped thing (store two)", status: "UNMATCHED" },
        { storeId: s3.id, shopifyProductId: "gid://shopify/Product/4", shopifyVariantId: gid(4), shopifySku: sku("PENDING"), status: "UNMATCHED" },
      ],
    });
    const conflicts = await products.skuStoreConflicts([sku("O1"), sku("NEW-1"), sku("PENDING"), sku("CLEAN")]);
    const messages = products.describeSkuStoreConflicts(conflicts);
    check("Conflict detection: mapped SKU flagged with its store; SKU present in two connected stores flagged twice; pending store ignored; clean SKU silent", conflicts.filter((c) => c.sku === sku("O1")).length === 1 && conflicts.find((c) => c.sku === sku("O1"))?.mappingStatus === "MATCHED" && conflicts.filter((c) => c.sku === sku("NEW-1")).length === 2 && !conflicts.some((c) => c.sku === sku("PENDING")) && !conflicts.some((c) => c.sku === sku("CLEAN")));
    check("Warnings are clear: 'already mapped in store', 'exists as a Shopify SKU', and 'appears in 2 connected stores' (one SKU → one store rule)", (messages[sku("O1")] ?? []).some((m) => /already mapped in Shopify store/.test(m)) && (messages[sku("NEW-1")] ?? []).some((m) => /exists as a Shopify SKU/.test(m)) && (messages[sku("NEW-1")] ?? []).some((m) => /appears in 2 connected stores/.test(m)) && !(sku("CLEAN") in messages));
    const ownProduct = await products.skuStoreConflicts([sku("O1")], other.id);
    const foreignProduct = await products.skuStoreConflicts([sku("O1")], tee.id);
    check("Editing the product that owns the mapping is not a conflict; another product reusing that SKU is", ownProduct.length === 0 && foreignProduct.length === 1 && /already mapped/.test(products.describeSkuStoreConflicts(foreignProduct)[sku("O1")][0]));
    await products.updateProduct(other.id, productFormSchema.parse({ ownerId: B.id, name: `B2 Other ${RUN} edited`, status: "ACTIVE", variants: [{ id: other.variants[0].id, sku: sku("O1"), price: "5.00", wholesalePrice: "3.10", status: "ACTIVE" }] }), admin.id);
    const mappingAfter = await prisma.shopifyVariantMapping.findFirst({ where: { storeId: s1.id, shopifySku: sku("O1") } });
    check("Saving a product never changes an existing Shopify mapping (no silent overwrite)", mappingAfter?.status === "MATCHED" && mappingAfter.variantId === other.variants[0].id);

    // ---------------------------------------------------------------- 8. CSV: new columns round trip
    const exp = await productCsv.exportProductsCsv({ ownerId: A.id, status: "ALL" });
    const rowsCsv = parseCsv(exp.csv);
    const t2row = rowsCsv.rows.find((r) => r["Variant SKU"] === sku("T2"));
    check("Export carries Variant Grams (weight), V3PL Wholesale Price and L/W/H columns", rowsCsv.headers.includes("V3PL Wholesale Price") && rowsCsv.headers.includes("V3PL Length (cm)") && t2row?.["Variant Grams"] === "202" && t2row["V3PL Wholesale Price"] === "14.5" && t2row["V3PL Width (cm)"] === "20.5");
    const H = `${RUN.toLowerCase()}-csv`;
    const importCsv = (await import("../src/lib/csv")).toCsv(
      ["Handle", "Title", "Option1 Name", "Option1 Value", "Option2 Name", "Option2 Value", "Variant SKU", "Variant Price", "Variant Grams", "V3PL Wholesale Price", "V3PL Length (cm)", "V3PL Width (cm)", "V3PL Height (cm)"],
      [
        { Handle: H, Title: `B2 CSV ${RUN}`, "Option1 Name": "Color", "Option1 Value": "Red", "Option2 Name": "Size", "Option2 Value": "S", "Variant SKU": sku("C-RED-S"), "Variant Price": "15.00", "Variant Grams": "120", "V3PL Wholesale Price": "9.00", "V3PL Length (cm)": "10", "V3PL Width (cm)": "5.5", "V3PL Height (cm)": "1" },
        { Handle: H, "Option1 Value": "Red", "Option2 Value": "M", "Variant SKU": sku("C-RED-M"), "Variant Price": "15.00", "Variant Grams": "130.0", "V3PL Wholesale Price": "9.00", "V3PL Length (cm)": "", "V3PL Width (cm)": "", "V3PL Height (cm)": "" },
        { Handle: H, "Option1 Value": "Red", "Option2 Value": "L", "Variant SKU": sku("C-RED-L"), "Variant Price": "15.00", "Variant Grams": "heavy", "V3PL Wholesale Price": "x", "V3PL Length (cm)": "1.234", "V3PL Width (cm)": "", "V3PL Height (cm)": "" },
      ],
    );
    const prev = await productCsv.previewProductCsv(importCsv, { ownerId: A.id, stockWarehouseId: null });
    const badRow = prev.rows.find((r) => r.index === 4)!;
    check("Import validates grams, wholesale and centimetres per row (row 4 errors on all three)", badRow.errors.some((e) => /Variant Grams/.test(e)) && badRow.errors.some((e) => /Wholesale/.test(e)) && badRow.errors.some((e) => /Length/.test(e)) && prev.groups[0].variants[0].weightGrams === 120 && prev.groups[0].variants[0].wholesalePrice === "9.00" && prev.groups[0].variants[1].weightGrams === 130);
    const fixedCsv = importCsv.replace("heavy", "140").replace(",x,", ",8.00,").replace("1.234", "12.34");
    const prev2 = await productCsv.previewProductCsv(fixedCsv, { ownerId: A.id, stockWarehouseId: null });
    const imp = await productCsv.executeProductImport(prev2, { ownerId: A.id, stockWarehouseId: null }, admin.id, `${RUN} csv`);
    const csvProduct = await prisma.product.findFirst({ where: { name: `B2 CSV ${RUN}` }, include: { variants: { orderBy: { sku: "asc" } } } });
    const redS = csvProduct?.variants.find((v) => v.sku === sku("C-RED-S"));
    check("Import persists weight, wholesale price and dimensions on the created variants", imp.created.length === 1 && prev2.summary.failedRows === 0 && redS?.weightGrams === 120 && redS.wholesalePrice?.toString() === "9" && redS.lengthCm?.toString() === "10" && redS.widthCm?.toString() === "5.5" && csvProduct?.variants.find((v) => v.sku === sku("C-RED-L"))?.lengthCm?.toString() === "12.34");

    // ---------------------------------------------------------------- 9. HTTP (session)
    let adminCookie = "";
    try {
      const { firebaseAdminAuth } = await import("../src/lib/firebase/admin");
      const uAdmin = await users.createUserAccount({ name: "B2 Admin", email: `${RUN.toLowerCase()}-admin@example.test`, password: "E2eTestPass123", role: "ADMIN", ownerId: null, phone: null, notes: null }, admin.id);
      created.userIds.push(uAdmin.id);
      created.firebaseUids.push(uAdmin.firebaseUid);
      const custom = await firebaseAdminAuth().createCustomToken(uAdmin.firebaseUid);
      const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${process.env.NEXT_PUBLIC_FIREBASE_API_KEY}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: custom, returnSecureToken: true }) });
      const { idToken } = await r.json();
      const res = await fetch(`${base}/api/auth/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken, audience: "staff" }) });
      adminCookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
    } catch (err) {
      console.log(`      (session unavailable: ${(err as Error).message.slice(0, 100)})`);
    }
    const get = (path: string) => fetch(`${base}${path}`, { redirect: "manual", headers: { Cookie: adminCookie } });
    const text = (h: string) => h.replace(/<!--[\s\S]*?-->/g, "");
    if (!adminCookie) {
      for (const n of ["HTTP: new product page renders the option/value builder and the pricing + physical columns", "HTTP: product detail shows Retail and Wholesale columns plus weight/dimensions", "HTTP: edit page renders the option values and per-variant wholesale/weight fields"]) skip(n, "no session");
    } else {
      let res = await get("/admin/products/new");
      let html = text(await res.text());
      check("HTTP: new product page renders the option/value builder and the pricing + physical columns", res.status === 200 && html.includes("Has variants") && html.includes(">Retail<") && html.includes(">Wholesale<") && html.includes("Weight g") && html.includes("L × W × H cm"));
      res = await get(`/admin/products/${tee.id}`);
      html = text(await res.text());
      check("HTTP: product detail shows Retail and Wholesale columns plus weight/dimensions", res.status === 200 && html.includes(">Retail<") && html.includes(">Wholesale<") && html.includes("Ivory / L / Cotton") && html.includes("30 × 20.5 × 2 cm") && html.includes("200 g") && html.includes(sku("T2")));
      res = await get(`/admin/products/${csvProduct!.id}/edit`);
      html = text(await res.text());
      check("HTTP: edit page renders the option values and per-variant wholesale/weight fields", res.status === 200 && html.includes('data-slot="option-builder"') && html.includes(">Red<") && html.includes(">S<") && html.includes("Color *") && html.includes(">Wholesale<"));
    }
  } finally {
    const { firebaseAdminAuth } = await import("../src/lib/firebase/admin");
    for (const uid of created.firebaseUids) await firebaseAdminAuth().deleteUser(uid).catch(() => undefined);
    await prisma.shopifyVariantMapping.deleteMany({ where: { storeId: { in: created.storeIds } } });
    await prisma.shopifyStore.deleteMany({ where: { id: { in: created.storeIds } } });
    const productIds = (await prisma.product.findMany({ where: { ownerId: { in: created.ownerIds } }, select: { id: true } })).map((p) => p.id);
    const all = await prisma.order.findMany({ where: { OR: [{ items: { some: { ownerId: { in: created.ownerIds } } } }, { warehouseId: { in: created.warehouseIds } }] }, select: { id: true } });
    all.forEach((x) => created.orderIds.add(x.id));
    const orderIds = [...created.orderIds];
    await prisma.inventoryTransaction.deleteMany({ where: { OR: [{ orderId: { in: orderIds } }, { variant: { productId: { in: productIds } } }, { warehouseId: { in: created.warehouseIds } }] } });
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
