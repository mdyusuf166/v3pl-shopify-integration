/**
 * Pre-Phase-6 refinement check (D-053 … D-056): Shopify-like product structure (options / variants),
 * SKU uniqueness, product create/edit, title suggestion, Shopify product CSV import + export (multi-
 * variant, existing SKUs, errors, round trip, import job), safe deletion (products, orders,
 * warehouses, locations), customer-facing order status presentation, sticky admin sidebar and the
 * Inter font. Cleans up everything it creates.
 *
 * Usage: npm run e2e:refinement -- http://localhost:3100 vendor3pl@gmail.com
 */
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });
loadEnv();

const [base = "http://localhost:3100", adminEmail = "vendor3pl@gmail.com"] = process.argv.slice(2);
const RUN = `rf${Date.now().toString(36)}`.toUpperCase();
const results: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
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
  const { firebaseAdminAuth } = await import("../src/lib/firebase/admin");
  const owners = await import("../src/server/services/owners");
  const users = await import("../src/server/services/users");
  const products = await import("../src/server/services/products");
  const productCsv = await import("../src/server/services/product-csv");
  const imports = await import("../src/server/services/imports");
  const warehouses = await import("../src/server/services/warehouses");
  const receiving = await import("../src/server/services/receiving");
  const inventory = await import("../src/server/services/inventory");
  const orders = await import("../src/server/services/orders");
  const fulfillment = await import("../src/server/services/fulfillment");
  const { productFormSchema, suggestedTitle, variantLabel } = await import("../src/lib/validation/products");
  const { presentOrderStatus, warehouseStageLabel } = await import("../src/lib/order-presentation");
  const { parseCsv, toCsv } = await import("../src/lib/csv");

  const admin = await prisma.user.findFirstOrThrow({ where: { email: adminEmail, role: "ADMIN" } });
  const created = { ownerIds: [] as string[], productIds: new Set<string>(), warehouseIds: [] as string[], userIds: [] as string[], firebaseUids: [] as string[], orderIds: new Set<string>(), importJobIds: [] as string[] };
  const ownerInput = (code: string, businessName: string) => ({ code, businessName, contactName: "Contact", email: null, phone: null, addressLine1: null, addressLine2: null, city: "Austin", state: null, postalCode: null, country: "US", notes: null });
  const whInput = (code: string, name: string) => ({ code, name, addressLine1: null, addressLine2: null, city: "Dallas", state: null, postalCode: null, country: "US", notes: null });
  const sku = (s: string) => `${RUN}-${s}`.toUpperCase();

  try {
    // ---------------------------------------------------------------- setup
    const A = await owners.createOwner("VENDOR", ownerInput(`${RUN}-A`, `RF Vendor A ${RUN}`), admin.id);
    const B = await owners.createOwner("VENDOR", ownerInput(`${RUN}-B`, `RF Vendor B ${RUN}`), admin.id);
    created.ownerIds.push(A.id, B.id);
    const W = await warehouses.createWarehouse(whInput(`${RUN}-W`, "RF Warehouse"), admin.id);
    created.warehouseIds.push(W.id);
    const main = (await warehouses.getDefaultLocation(W.id))!;

    // ---------------------------------------------------------------- 1. product structure
    check("Title is required (empty title rejected by the schema)", !productFormSchema.safeParse({ ownerId: A.id, name: "", status: "ACTIVE", variants: [{ sku: sku("X"), status: "ACTIVE" }] }).success);

    const single = await products.createProduct(productFormSchema.parse({ ownerId: A.id, name: sku("SIMPLE"), status: "ACTIVE", variants: [{ sku: sku("SIMPLE"), price: "10.00", status: "ACTIVE" }] }), admin.id);
    created.productIds.add(single.id);
    const singleRow = await prisma.product.findUniqueOrThrow({ where: { id: single.id }, include: { variants: true } });
    check("Single-variant product: no options, one default variant, label null", singleRow.options.length === 0 && singleRow.variants.length === 1 && singleRow.variants[0].isDefault && singleRow.variants[0].name === null && singleRow.variants[0].optionValues.length === 0);

    const tee = await products.createProduct(
      productFormSchema.parse({
        ownerId: A.id,
        name: `RF T-Shirt ${RUN}`,
        status: "ACTIVE",
        options: ["Color", "Size"],
        variants: [
          { sku: sku("TS-BLK-S"), optionValues: ["Black", "Small"], price: "20.00", status: "ACTIVE" },
          { sku: sku("TS-BLK-M"), optionValues: ["Black", "Medium"], price: "20.00", status: "ACTIVE" },
          { sku: sku("TS-WHT-S"), optionValues: ["White", "Small"], price: "21.00", status: "ACTIVE" },
          { sku: sku("TS-WHT-M"), optionValues: ["White", "Medium"], price: "21.00", status: "ACTIVE" },
        ],
      }),
      admin.id,
    );
    created.productIds.add(tee.id);
    const teeRow = await prisma.product.findUniqueOrThrow({ where: { id: tee.id }, include: { variants: { orderBy: { sku: "asc" } } } });
    check("Multi-variant product: options [Color, Size], 4 variants under ONE product, labels derived", teeRow.options.join("/") === "Color/Size" && teeRow.variants.length === 4 && teeRow.variants.find((v) => v.sku === sku("TS-BLK-S"))?.name === "Black / Small" && teeRow.variants.every((v) => !v.isDefault));
    check("variantLabel joins option values Shopify-style and falls back to legacy name", variantLabel({ optionValues: ["Black", "Small"] }) === "Black / Small" && variantLabel({ optionValues: [], name: "Red" }) === "Red" && variantLabel({ optionValues: [] }) === null);

    const missingValue = productFormSchema.safeParse({ ownerId: A.id, name: "X", status: "ACTIVE", options: ["Size"], variants: [{ sku: sku("V1"), optionValues: [""], status: "ACTIVE" }] });
    const dupCombo = productFormSchema.safeParse({ ownerId: A.id, name: "X", status: "ACTIVE", options: ["Size"], variants: [{ sku: sku("V1"), optionValues: ["S"], status: "ACTIVE" }, { sku: sku("V2"), optionValues: ["s"], status: "ACTIVE" }] });
    const dupOption = productFormSchema.safeParse({ ownerId: A.id, name: "X", status: "ACTIVE", options: ["Size", "size"], variants: [{ sku: sku("V1"), optionValues: ["S", "M"], status: "ACTIVE" }] });
    const tooMany = productFormSchema.safeParse({ ownerId: A.id, name: "X", status: "ACTIVE", options: ["A", "B", "C", "D"], variants: [{ sku: sku("V1"), optionValues: ["1", "2", "3", "4"], status: "ACTIVE" }] });
    const dupSkuInProduct = productFormSchema.safeParse({ ownerId: A.id, name: "X", status: "ACTIVE", variants: [{ sku: sku("V1"), status: "ACTIVE" }, { sku: sku("v1"), status: "ACTIVE" }] });
    check("Option validation: missing value, duplicate combination, duplicate option name, >3 options, duplicate SKU in product all rejected", !missingValue.success && !dupCombo.success && !dupOption.success && !tooMany.success && !dupSkuInProduct.success);

    const clash = await expectError(() => products.createProduct(productFormSchema.parse({ ownerId: B.id, name: "Clash", status: "ACTIVE", variants: [{ sku: sku("TS-BLK-S"), status: "ACTIVE" }] }), admin.id));
    check("SKU uniqueness is global: another owner cannot reuse TS-BLK-S", clash.hit && clash.code === "SKU_TAKEN");

    // Edit: rename options, change a value, add + remove variants (no history yet)
    await products.updateProduct(
      tee.id,
      productFormSchema.parse({
        ownerId: A.id,
        name: `RF T-Shirt ${RUN} v2`,
        status: "ACTIVE",
        options: ["Colour", "Size"],
        variants: [
          ...teeRow.variants.filter((v) => v.sku !== sku("TS-WHT-M")).map((v) => ({ id: v.id, sku: v.sku, optionValues: [v.optionValues[0] === "Black" ? "Jet Black" : v.optionValues[0], v.optionValues[1]], price: v.price?.toString() ?? null, status: "ACTIVE" })),
          { sku: sku("TS-RED-L"), optionValues: ["Red", "Large"], price: "22.00", status: "ACTIVE" },
        ],
      }),
      admin.id,
    );
    const teeV2 = await prisma.product.findUniqueOrThrow({ where: { id: tee.id }, include: { variants: { orderBy: { sku: "asc" } } } });
    check("Edit: title + option names changed, value renamed → labels re-derived, variant removed and added", teeV2.name.endsWith("v2") && teeV2.options[0] === "Colour" && teeV2.variants.length === 4 && teeV2.variants.find((v) => v.sku === sku("TS-BLK-S"))?.name === "Jet Black / Small" && !teeV2.variants.some((v) => v.sku === sku("TS-WHT-M")) && teeV2.variants.some((v) => v.sku === sku("TS-RED-L")));

    check("Title suggestion: simple new product → SKU (uppercased); not for edits, typed titles or products with options", suggestedTitle(" ts-001 ", { hasOptions: false, titleTouched: false, editing: false }) === "TS-001" && suggestedTitle("X", { hasOptions: true, titleTouched: false, editing: false }) === null && suggestedTitle("X", { hasOptions: false, titleTouched: true, editing: false }) === null && suggestedTitle("X", { hasOptions: false, titleTouched: false, editing: true }) === null);

    // Stock on one variant → it becomes locked / product undeletable
    const vBlkS = teeV2.variants.find((v) => v.sku === sku("TS-BLK-S"))!;
    await receiving.createReceiving({ ownerId: A.id, warehouseId: W.id, reference: `${RUN}-R1`, notes: null, lines: [{ variantId: vBlkS.id, locationId: main.id, quantity: 12 }] }, admin.id);
    const removeLocked = await expectError(() => products.updateProduct(tee.id, productFormSchema.parse({ ownerId: A.id, name: teeV2.name, status: "ACTIVE", options: teeV2.options, variants: teeV2.variants.filter((v) => v.id !== vBlkS.id).map((v) => ({ id: v.id, sku: v.sku, optionValues: v.optionValues, status: "ACTIVE" })) }), admin.id));
    check("A variant with inventory history cannot be removed from the product", removeLocked.hit && removeLocked.code === "VARIANT_HAS_HISTORY");

    // ---------------------------------------------------------------- 2. Shopify CSV import
    const H = (s: string) => `${RUN.toLowerCase()}-${s}`;
    const shopifyCsv = toCsv(
      ["Handle", "Title", "Body (HTML)", "Vendor", "Type", "Tags", "Published", "Option1 Name", "Option1 Value", "Option2 Name", "Option2 Value", "Option3 Name", "Option3 Value", "Variant SKU", "Variant Grams", "Variant Inventory Tracker", "Variant Inventory Qty", "Variant Inventory Policy", "Variant Fulfillment Service", "Variant Price", "Variant Requires Shipping", "Variant Taxable", "Variant Barcode", "Image Src", "Status"],
      [
        { Handle: H("hoodie"), Title: `RF Hoodie ${RUN}`, "Body (HTML)": "<p>Warm</p>", Vendor: "Brand", Published: "TRUE", "Option1 Name": "Color", "Option1 Value": "Black", "Option2 Name": "Size", "Option2 Value": "S", "Variant SKU": sku("HD-BLK-S"), "Variant Inventory Tracker": "shopify", "Variant Inventory Qty": "5", "Variant Inventory Policy": "deny", "Variant Fulfillment Service": "manual", "Variant Price": "45.00", "Variant Requires Shipping": "TRUE", "Variant Taxable": "TRUE", "Variant Barcode": "111", Status: "active" },
        { Handle: H("hoodie"), "Option1 Value": "Black", "Option2 Value": "M", "Variant SKU": sku("HD-BLK-M"), "Variant Inventory Qty": "7", "Variant Price": "45.00" },
        { Handle: H("hoodie"), "Option1 Value": "Grey", "Option2 Value": "S", "Variant SKU": sku("HD-GRY-S"), "Variant Inventory Qty": "0", "Variant Price": "$46.50" },
        { Handle: H("mug"), Title: `RF Mug ${RUN}`, Published: "TRUE", "Option1 Name": "Title", "Option1 Value": "Default Title", "Variant SKU": sku("MUG"), "Variant Inventory Qty": "30", "Variant Price": "9.99", Status: "draft" },
        { Handle: H("hat"), Title: `RF Hat ${RUN}`, "Option1 Name": "Title", "Option1 Value": "Default Title", "Variant SKU": sku("HAT"), "Variant Inventory Qty": "3", "Variant Price": "15.00", Status: "archived" },
      ],
    );
    const prev = await productCsv.previewProductCsv(shopifyCsv, { ownerId: A.id, stockWarehouseId: W.id });
    const hoodie = prev.groups.find((g) => g.handle === H("hoodie"))!;
    const mug = prev.groups.find((g) => g.handle === H("mug"))!;
    const hat = prev.groups.find((g) => g.handle === H("hat"))!;
    check("Shopify product CSV detected; 3 products, all valid; ignored columns listed", prev.format === "shopify-products" && prev.summary.totalProducts === 3 && prev.summary.validProducts === 3 && prev.unknownColumns.includes("Variant Inventory Tracker") && !prev.unknownColumns.includes("Variant Grams"));
    check("Multi-variant handle → ONE product with options [Color, Size] and 3 variants with option values", hoodie.options.join("/") === "Color/Size" && hoodie.variants.length === 3 && hoodie.variants[1].optionValues.join("/") === "Black/M" && hoodie.variants[2].price === "46.50" && hoodie.action === "create");
    check("Simple handle (Title / Default Title) → no options; draft → Active with note; archived → ARCHIVED", mug.options.length === 0 && mug.status === "ACTIVE" && mug.notes.some((n) => /draft/i.test(n)) && hat.status === "ARCHIVED");
    check("Preview summary: 5 new SKUs, 42 units to receive (archived hat's 3 units noted, not received)", prev.summary.newSkus === 5 && prev.summary.unitsToReceive === 42 && hat.notes.some((n) => /archived/.test(n)));

    const imp = await productCsv.executeProductImport(prev, { ownerId: A.id, stockWarehouseId: W.id }, admin.id, `${RUN} import`);
    for (const c of [...imp.created, ...imp.updated]) created.productIds.add(c.productId);
    const hoodieRow = await prisma.product.findFirstOrThrow({ where: { name: `RF Hoodie ${RUN}` }, include: { variants: { orderBy: { sku: "asc" } } } });
    const hdBlkM = hoodieRow.variants.find((v) => v.sku === sku("HD-BLK-M"))!;
    const stockM = await inventory.stockForVariant(hdBlkM.id);
    const stockGry = await inventory.stockForVariant(hoodieRow.variants.find((v) => v.sku === sku("HD-GRY-S"))!.id);
    check("Import created 3 products; hoodie has 3 variants with derived labels", imp.created.length === 3 && imp.failed.length === 0 && hoodieRow.variants.length === 3 && hdBlkM.name === "Black / M" && hoodieRow.options.join("/") === "Color/Size", JSON.stringify({ created: imp.created.length, failed: imp.failed, variants: hoodieRow.variants.map((v) => v.name) }));
    check("Quantities booked as receipts through the inventory service (HD-BLK-M on hand 7, zero-qty variant untouched)", stockM[0]?.onHand === 7 && stockGry.length === 0 && (await prisma.receivingRecord.count({ where: { ownerId: A.id, reference: { startsWith: `${RUN} import` } } })) > 0);

    // Update path: change price, add a variant, quantities for existing SKUs are ignored
    const updateCsv = toCsv(
      ["Handle", "Title", "Option1 Name", "Option1 Value", "Option2 Name", "Option2 Value", "Variant SKU", "Variant Inventory Qty", "Variant Price", "Status"],
      [
        { Handle: H("hoodie"), Title: `RF Hoodie ${RUN} (2nd run)`, "Option1 Name": "Color", "Option1 Value": "Black", "Option2 Name": "Size", "Option2 Value": "S", "Variant SKU": sku("HD-BLK-S"), "Variant Inventory Qty": "99", "Variant Price": "49.00", Status: "active" },
        { Handle: H("hoodie"), "Option1 Value": "Black", "Option2 Value": "M", "Variant SKU": sku("HD-BLK-M"), "Variant Inventory Qty": "99", "Variant Price": "49.00" },
        { Handle: H("hoodie"), "Option1 Value": "Grey", "Option2 Value": "S", "Variant SKU": sku("HD-GRY-S"), "Variant Price": "49.00" },
        { Handle: H("hoodie"), "Option1 Value": "Grey", "Option2 Value": "M", "Variant SKU": sku("HD-GRY-M"), "Variant Inventory Qty": "4", "Variant Price": "49.00" },
      ],
    );
    const prev2 = await productCsv.previewProductCsv(updateCsv, { ownerId: A.id, stockWarehouseId: W.id });
    const g2 = prev2.groups[0];
    check("Re-import: handle resolves to the existing product (update), 3 existing + 1 new SKU, quantity notes for existing SKUs", g2.action === "update" && g2.existingProductId === hoodieRow.id && prev2.summary.existingSkus === 3 && prev2.summary.newSkus === 1 && prev2.summary.unitsToReceive === 4 && g2.notes.some((n) => n.includes(sku("HD-BLK-M"))));
    const imp2 = await productCsv.executeProductImport(prev2, { ownerId: A.id, stockWarehouseId: W.id }, admin.id, `${RUN} import2`);
    const hoodie2 = await prisma.product.findUniqueOrThrow({ where: { id: hoodieRow.id }, include: { variants: { orderBy: { sku: "asc" } } } });
    check("Update applied: title + price changed, variant added, existing stock unchanged (7)", imp2.updated.length === 1 && hoodie2.name.endsWith("(2nd run)") && hoodie2.variants.length === 4 && hoodie2.variants.find((v) => v.sku === sku("HD-BLK-M"))?.price?.toString() === "49" && (await inventory.stockForVariant(hdBlkM.id))[0]?.onHand === 7 && (await inventory.stockForVariant(hoodie2.variants.find((v) => v.sku === sku("HD-GRY-M"))!.id))[0]?.onHand === 4);

    // Error cases
    const badCsv = toCsv(
      ["Handle", "Title", "Option1 Name", "Option1 Value", "Variant SKU", "Variant Inventory Qty", "Variant Price", "V3PL Owner Code"],
      [
        { Handle: H("nosku"), Title: "No SKU", "Option1 Name": "Title", "Option1 Value": "Default Title", "Variant SKU": "", "Variant Price": "1.00", "V3PL Owner Code": `${RUN}-A` },
        { Handle: H("dup"), Title: "Dup", "Option1 Name": "Size", "Option1 Value": "S", "Variant SKU": sku("DUP"), "Variant Price": "1.00", "V3PL Owner Code": `${RUN}-A` },
        { Handle: H("dup"), "Option1 Value": "M", "Variant SKU": sku("DUP"), "Variant Price": "1.00", "V3PL Owner Code": `${RUN}-A` },
        { Handle: H("steal"), Title: "Steal", "Option1 Name": "Title", "Option1 Value": "Default Title", "Variant SKU": sku("MUG"), "Variant Price": "1.00", "V3PL Owner Code": `${RUN}-B` },
        { Handle: H("badowner"), Title: "Bad owner", "Option1 Name": "Title", "Option1 Value": "Default Title", "Variant SKU": sku("BO"), "Variant Price": "1.00", "V3PL Owner Code": "NOPE-XYZ" },
        { Handle: H("badqty"), Title: "Bad qty", "Option1 Name": "Title", "Option1 Value": "Default Title", "Variant SKU": sku("BQ"), "Variant Inventory Qty": "-3", "Variant Price": "abc", "V3PL Owner Code": `${RUN}-A` },
        { Handle: H("mix"), Title: "Mix", "Option1 Name": "Title", "Option1 Value": "Default Title", "Variant SKU": sku("HAT"), "Variant Price": "1.00", "V3PL Owner Code": `${RUN}-A` },
        { Handle: H("mix"), "Option1 Value": "Default Title", "Variant SKU": sku("MUG"), "Variant Price": "1.00", "V3PL Owner Code": `${RUN}-A` },
        { Handle: H("good"), Title: `RF Good ${RUN}`, "Option1 Name": "Title", "Option1 Value": "Default Title", "Variant SKU": sku("GOOD"), "Variant Price": "1.00", "V3PL Owner Code": `${RUN}-B` },
      ],
    );
    const bad = await productCsv.previewProductCsv(badCsv, { ownerId: null, stockWarehouseId: null });
    const gb = (h: string) => bad.groups.find((g) => g.handle === H(h))!;
    const rowErr = (idx: number) => bad.rows.find((r) => r.index === idx)?.errors ?? [];
    check("Row errors: missing SKU, duplicate SKU in file, SKU of another owner, unknown owner code, bad qty/price", rowErr(2).some((e) => /SKU is required/.test(e)) && rowErr(3).some((e) => /more than once/.test(e)) && rowErr(5).some((e) => /another owner/.test(e)) && rowErr(6).some((e) => /Unknown V3PL Owner Code/.test(e)) && rowErr(7).some((e) => /Inventory Qty/.test(e)) && rowErr(7).some((e) => /Price/.test(e)));
    check("Handle mixing SKUs of two existing products is rejected; format detected as v3pl-products", gb("mix").errors.some((e) => /different V3PL products/.test(e)) && bad.format === "v3pl-products");
    check("Preview summary: 1 valid product out of 7", bad.summary.validProducts === 1 && bad.summary.failedProducts === 6);
    const badImp = await productCsv.executeProductImport(bad, { ownerId: null, stockWarehouseId: null }, admin.id, `${RUN} bad`);
    for (const c of badImp.created) created.productIds.add(c.productId);
    check("Importing the bad file creates only the good product (owner from the code column = B), nothing partial", badImp.created.length === 1 && badImp.failed.length === 6 && (await prisma.product.findFirst({ where: { id: badImp.created[0].productId }, select: { ownerId: true } }))?.ownerId === B.id);
    const failedCsv = parseCsv(productCsv.failedProductRowsCsv(bad, badImp));
    check("Failed-rows CSV: original columns + Error, only failed rows (8), good row excluded", failedCsv.headers.includes("Error") && failedCsv.rows.length === 8 && !failedCsv.rows.some((r) => r["Variant SKU"] === sku("GOOD")) && failedCsv.rows.every((r) => r.Error.length > 0));
    const missing = await productCsv.previewProductCsv(toCsv(["Title", "Price"], [{ Title: "x", Price: "1" }]), { ownerId: A.id, stockWarehouseId: null });
    check("Missing required columns → format unknown, all rows fail", missing.format === "unknown" && missing.missingRequired.length === 2 && missing.summary.failedRows === 1);

    // ---------------------------------------------------------------- 3. Export + round trip
    const exp = await productCsv.exportProductsCsv({ ownerId: A.id, status: "ALL" });
    const expRows = parseCsv(exp.csv);
    const hoodieRows = expRows.rows.filter((r) => r.Title === hoodie2.name || (r.Handle === expRows.rows.find((x) => x.Title === hoodie2.name)?.Handle));
    const mugRow = expRows.rows.find((r) => r["Variant SKU"] === sku("MUG"))!;
    const blkM = expRows.rows.find((r) => r["Variant SKU"] === sku("HD-BLK-M"))!;
    check("Export: one row per variant, product fields + option names on the first row only, values on every row", hoodieRows.length === 4 && hoodieRows[0].Title === hoodie2.name && hoodieRows[0]["Option1 Name"] === "Color" && hoodieRows[1].Title === "" && hoodieRows[1]["Option1 Name"] === "" && hoodieRows[1]["Option2 Value"] !== "");
    check("Export: simple product uses Title/Default Title; inventory qty = available; V3PL columns present; archived status", mugRow["Option1 Name"] === "Title" && mugRow["Option1 Value"] === "Default Title" && blkM["Variant Inventory Qty"] === "7" && blkM["V3PL On Hand"] === "7" && blkM["V3PL Owner Code"] === `${RUN}-A` && expRows.rows.find((r) => r["Variant SKU"] === sku("HAT"))!["Status"] === "archived" && expRows.headers.includes("Variant Inventory Tracker"));
    check("Export owner filter: only A's products (B's Good product excluded); count header value", !expRows.rows.some((r) => r["Variant SKU"] === sku("GOOD")) && exp.products === expRows.rows.filter((r) => r.Title !== "").length);
    const round = await productCsv.previewProductCsv(exp.csv, { ownerId: B.id, stockWarehouseId: W.id });
    check("Round trip: exported file re-imports without errors as updates (owner code column wins over the form's owner)", round.format === "v3pl-products" && round.summary.failedProducts === 0 && round.groups.every((g) => g.action === "update" && g.ownerId === A.id) && round.summary.newSkus === 0 && round.summary.unitsToReceive === 0);

    // Import job flow (preview stored → confirm → results → failed rows)
    const jobCsv = toCsv(
      ["Handle", "Title", "Option1 Name", "Option1 Value", "Variant SKU", "Variant Price"],
      [
        { Handle: H("job-ok"), Title: `RF Job OK ${RUN}`, "Option1 Name": "Title", "Option1 Value": "Default Title", "Variant SKU": sku("JOB-OK"), "Variant Price": "5.00" },
        { Handle: H("job-bad"), Title: `RF Job Bad ${RUN}`, "Option1 Name": "Title", "Option1 Value": "Default Title", "Variant SKU": "", "Variant Price": "5.00" },
      ],
    );
    const { jobId } = await imports.createProductImportPreview("rf-products.csv", jobCsv, { ownerId: A.id, stockWarehouseId: null }, admin.id);
    created.importJobIds.push(jobId);
    const jobBefore = await imports.getImportJob(jobId);
    const outcome = await imports.confirmImportJob(jobId, admin.id);
    const jobAfter = await imports.getImportJob(jobId);
    if ("updated" in outcome) for (const c of outcome.created) created.productIds.add(c.productId);
    const again = await expectError(() => imports.confirmImportJob(jobId, admin.id));
    const failedRows = await imports.failedRowsCsvForJob(jobId);
    check("Import job: type PRODUCTS, preview stored, confirm creates 1 / fails 1, COMPLETED, re-confirm rejected, failed-rows report", jobBefore?.type === "PRODUCTS" && jobBefore.status === "PREVIEW" && "updated" in outcome && outcome.created.length === 1 && outcome.failed.length === 1 && jobAfter?.status === "COMPLETED" && jobAfter.successCount === 1 && again.hit && !!failedRows && parseCsv(failedRows.csv).rows.length === 1);

    // ---------------------------------------------------------------- 4. deletion
    const delOk = await products.productDeleteCheck(single.id);
    await products.deleteProduct(single.id, admin.id);
    check("Product without history: delete allowed and removed (variants gone, audit written)", delOk.canDelete && (await prisma.product.findUnique({ where: { id: single.id } })) === null && (await prisma.productVariant.count({ where: { sku: sku("SIMPLE") } })) === 0 && (await prisma.auditLog.count({ where: { action: "product.deleted", entityId: single.id } })) === 1);
    created.productIds.delete(single.id);
    const delBlocked = await products.productDeleteCheck(tee.id);
    const delFail = await expectError(() => products.deleteProduct(tee.id, admin.id));
    check("Product with inventory history: blockers reported, delete refused, product intact", !delBlocked.canDelete && delBlocked.blockers.some((b) => /inventory history/i.test(b)) && delFail.hit && delFail.code === "HAS_HISTORY" && (await prisma.product.count({ where: { id: tee.id } })) === 1);

    // Orders: unreserved → deletable; reserved → not
    const draft = await orders.createOrder({ source: "MANUAL", warehouseId: W.id, reserve: false, shipName: "RF Draft", lines: [{ variantId: vBlkS.id, quantity: 1 }] }, admin.id);
    const reserved = await orders.createOrder({ source: "MANUAL", warehouseId: W.id, reserve: true, shipName: "RF Reserved", lines: [{ variantId: vBlkS.id, quantity: 2 }] }, admin.id);
    created.orderIds.add(draft.orderId);
    created.orderIds.add(reserved.orderId);
    const draftCheck = await orders.orderDeleteCheck(draft.orderId);
    await orders.deleteOrder(draft.orderId, admin.id);
    check("Order that never touched stock: delete allowed; rows removed; audit written", draftCheck.canDelete && (await prisma.order.findUnique({ where: { id: draft.orderId } })) === null && (await prisma.auditLog.count({ where: { action: "order.deleted", entityId: draft.orderId } })) === 1);
    created.orderIds.delete(draft.orderId);
    const reservedCheck = await orders.orderDeleteCheck(reserved.orderId);
    const reservedDel = await expectError(() => orders.deleteOrder(reserved.orderId, admin.id));
    check("Reserved order: ledger history blocks deletion (cancel instead); order intact and still reserved", !reservedCheck.canDelete && reservedCheck.blockers.some((b) => /ledger/i.test(b)) && reservedDel.hit && (await prisma.orderItem.findFirst({ where: { orderId: reserved.orderId } }))?.reservedQty === 2);

    // Warehouses / locations
    const W2 = await warehouses.createWarehouse(whInput(`${RUN}-W2`, "RF Empty Warehouse"), admin.id);
    created.warehouseIds.push(W2.id);
    const extraLoc = await warehouses.createLocation(W2.id, { label: "A-01", zone: null, rack: null, shelf: null, bin: null, notes: null }, admin.id);
    const defaultLoc = (await warehouses.getDefaultLocation(W2.id))!;
    const defDel = await expectError(() => warehouses.deleteLocation(defaultLoc.id, admin.id));
    await warehouses.deleteLocation(extraLoc.id, admin.id);
    check("Locations: default location cannot be deleted; unused location deleted", defDel.hit && defDel.code === "HAS_HISTORY" && (await prisma.location.findUnique({ where: { id: extraLoc.id } })) === null);
    const w2Check = await warehouses.warehouseDeleteCheck(W2.id);
    await warehouses.deleteWarehouse(W2.id, admin.id);
    check("Empty warehouse: delete allowed and removed with its default location", w2Check.canDelete && (await prisma.warehouse.findUnique({ where: { id: W2.id } })) === null && (await prisma.location.count({ where: { warehouseId: W2.id } })) === 0);
    created.warehouseIds.splice(created.warehouseIds.indexOf(W2.id), 1);
    const wCheck = await warehouses.warehouseDeleteCheck(W.id);
    const wDel = await expectError(() => warehouses.deleteWarehouse(W.id, admin.id));
    const mainDel = await expectError(() => warehouses.deleteLocation(main.id, admin.id));
    check("Warehouse / location with stock history: blockers listed, delete refused", !wCheck.canDelete && wCheck.blockers.length >= 2 && wDel.hit && wDel.code === "HAS_HISTORY" && mainDel.hit);

    // ---------------------------------------------------------------- 5. order status presentation
    const S = (status: string, fulfillmentStatus: string, items: { shippedQty: number; returnedQty?: number }[] = []) => presentOrderStatus({ status, fulfillmentStatus, items });
    check(
      "presentOrderStatus: Unfulfilled (new/reserved/picking/packed), Partially fulfilled, Fulfilled (shipped), Delivered, Returned, Cancelled",
      S("NEW", "UNFULFILLED") === "UNFULFILLED" && S("CONFIRMED", "RESERVED") === "UNFULFILLED" && S("CONFIRMED", "PICKING") === "UNFULFILLED" && S("CONFIRMED", "PACKED") === "UNFULFILLED" && S("CONFIRMED", "PARTIALLY_SHIPPED", [{ shippedQty: 1 }]) === "PARTIALLY_FULFILLED" && S("COMPLETED", "SHIPPED", [{ shippedQty: 2 }]) === "FULFILLED" && S("COMPLETED", "FULFILLED", [{ shippedQty: 2 }]) === "DELIVERED" && S("COMPLETED", "FULFILLED", [{ shippedQty: 2, returnedQty: 2 }]) === "RETURNED" && S("CANCELLED", "UNFULFILLED") === "CANCELLED",
    );
    check("Warehouse stage hint only for reserved/picking/packed", warehouseStageLabel("PICKING") === "Picking" && warehouseStageLabel("RESERVED") === "Reserved" && warehouseStageLabel("SHIPPED") === null && warehouseStageLabel("UNFULFILLED") === null);
    // Real orders: ship the reserved one, cancel another, then filter with `view`
    const f = await fulfillment.startPicking({ orderId: reserved.orderId, warehouseId: W.id }, admin.id);
    await fulfillment.shipFulfillment(f.id, { carrier: "UPS", trackingNumber: `${RUN}-TRK` }, admin.id);
    const canc = await orders.createOrder({ source: "MANUAL", warehouseId: W.id, reserve: true, shipName: "RF Cancel", lines: [{ variantId: vBlkS.id, quantity: 1 }] }, admin.id);
    created.orderIds.add(canc.orderId);
    await orders.cancelOrder(canc.orderId, "rf", admin.id);
    const openOne = await orders.createOrder({ source: "MANUAL", warehouseId: W.id, reserve: true, shipName: "RF Open", lines: [{ variantId: vBlkS.id, quantity: 1 }] }, admin.id);
    created.orderIds.add(openOne.orderId);
    const shippedList = await orders.listOrders({ status: "ALL", view: "FULFILLED", ownerId: A.id });
    const cancelledList = await orders.listOrders({ status: "ALL", view: "CANCELLED", ownerId: A.id });
    const unfulfilledList = await orders.listOrders({ status: "ALL", view: "UNFULFILLED", ownerId: A.id });
    check("Customer-facing filter: Fulfilled → shipped order only; Cancelled → cancelled only; Unfulfilled → open reserved only", shippedList.items.map((o) => o.id).join() === reserved.orderId && cancelledList.items.map((o) => o.id).join() === canc.orderId && unfulfilledList.items.map((o) => o.id).join() === openOne.orderId && presentOrderStatus(shippedList.items[0]) === "FULFILLED");

    // ---------------------------------------------------------------- 6. HTTP: pages, sidebar, font
    const auth = firebaseAdminAuth();
    const uAdmin = await users.createUserAccount({ name: "RF Admin", email: `${RUN.toLowerCase()}-admin@example.test`, password: "E2eTestPass123", role: "ADMIN", ownerId: null, phone: null, notes: null }, admin.id);
    const uVendor = await users.createUserAccount({ name: "RF Vendor", email: `${RUN.toLowerCase()}-vendor@example.test`, password: "E2eTestPass123", role: "VENDOR", ownerId: A.id, phone: null, notes: null }, admin.id);
    for (const u of [uAdmin, uVendor]) {
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
    const get = (path: string, cookie = "") => fetch(`${base}${path}`, { redirect: "manual", headers: cookie ? { Cookie: cookie } : {} });
    const text = (h: string) => h.replace(/<!--[\s\S]*?-->/g, "");
    const adminCookie = await sessionFor(uAdmin.firebaseUid, "staff");

    let res = await get("/admin", adminCookie);
    let html = text(await res.text());
    check("Admin sidebar is sticky (sticky top-0 h-screen aside) and content scrolls independently", res.status === 200 && /<aside class="[^"]*sticky top-0[^"]*h-screen[^"]*"/.test(html));
    const cssLinks = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+\.css[^"]*)"/g)].map((m) => m[1]);
    const cssText = (await Promise.all(cssLinks.map(async (h) => (await fetch(h.startsWith("http") ? h : `${base}${h}`)).text()))).join("\n");
    check("Inter is the global font (Inter in CSS, --font-inter variable on <html>, no Geist)", cssLinks.length > 0 && /font-family:\s*['"]?Inter/i.test(cssText) && /--font-inter/.test(cssText) && !/Geist/.test(cssText) && /__variable/.test(html));

    res = await get(`/admin/products?q=${encodeURIComponent(RUN)}&status=ALL`, adminCookie);
    html = text(await res.text());
    check("Products list: Shopify-like columns (Product, Status, Variants, Inventory, actions), variant counts and stock", res.status === 200 && html.includes(hoodie2.name) && html.includes("4 variants") && /\d+ available/.test(html) && html.includes("Export") && html.includes("Add product"));
    res = await get(`/admin/products/${hoodie2.id}`, adminCookie);
    html = text(await res.text());
    check("Product detail: variants listed underneath with option labels, SKUs and per-variant inventory; Delete offered", res.status === 200 && html.includes("Black / M") && html.includes(sku("HD-BLK-M")) && html.includes("Color / Size") && html.includes("Delete"));
    res = await get("/admin/products/new", adminCookie);
    html = text(await res.text());
    check("New product page: title defaults to the SKU, 'Has variants' switch", res.status === 200 && html.includes("Defaults to the SKU") && html.includes("Has variants"));
    res = await get(`/admin/products/${hoodie2.id}/edit`, adminCookie);
    html = text(await res.text());
    check("Edit page: option columns, variant SKUs and read-only inventory rendered", res.status === 200 && html.includes("Color *") && html.includes("Size *") && html.includes("7 on hand") && html.includes("Has variants"), `${res.status}`);
    res = await get(`/api/products/export?ownerId=${A.id}&status=ALL`, adminCookie);
    check("Products export API: CSV with product count header", res.status === 200 && (res.headers.get("content-type") ?? "").includes("text/csv") && Number(res.headers.get("x-product-count")) >= 4 && (await res.text()).includes("Variant SKU"));
    res = await get("/admin/imports", adminCookie);
    html = text(await res.text());
    check("Imports page offers the product CSV import and product export", res.status === 200 && html.includes("Import products from CSV") && html.includes("Export products"));
    res = await get(`/admin/imports/${jobId}`, adminCookie);
    html = text(await res.text());
    check("Product import job page renders results with handles and outcomes", res.status === 200 && html.includes(H("job-ok")) && html.includes("Created") && html.includes("Failed rows CSV"));

    res = await get(`/admin/orders?status=ALL&ownerId=${A.id}`, adminCookie);
    html = text(await res.text());
    check("Orders list leads with customer-facing statuses (Fulfilled / Cancelled / Unfulfilled), no raw workflow states as primary", res.status === 200 && html.includes(">Fulfilled<") && html.includes(">Cancelled<") && html.includes(">Unfulfilled<") && !html.includes(">Confirmed<") && html.includes("Any status"));
    res = await get(`/admin/orders/${reserved.orderId}`, adminCookie);
    html = text(await res.text());
    check("Order detail: primary status Fulfilled, Delete button offered with blockers dialog markup", res.status === 200 && html.includes(">Fulfilled<") && html.includes("Delete"));
    res = await get(`/admin/orders/${openOne.orderId}`, adminCookie);
    html = text(await res.text());
    check("Open order detail: Unfulfilled + warehouse stage hint 'Reserved'", res.status === 200 && html.includes(">Unfulfilled<") && html.includes(">Reserved<"));
    res = await get(`/admin/warehouses/${W.id}`, adminCookie);
    html = text(await res.text());
    check("Warehouse detail offers Delete alongside Deactivate", res.status === 200 && html.includes("Delete") && html.includes("Deactivate"));

    const vendorCookie = await sessionFor(uVendor.firebaseUid, "portal");
    res = await get("/portal/vendor/orders?status=ALL", vendorCookie);
    html = text(await res.text());
    check("Vendor portal orders use the same customer-facing statuses", res.status === 200 && html.includes(">Fulfilled<") && html.includes(">Cancelled<"));
    res = await get(`/portal/vendor/products?q=${encodeURIComponent(RUN)}`, vendorCookie);
    html = text(await res.text());
    check("Vendor portal products show variant labels for own products only", res.status === 200 && html.includes("Black / M") && !html.includes(sku("GOOD")));
    res = await get(`/api/products/export?status=ALL`, vendorCookie);
    const vendorCsv = parseCsv(await res.text());
    check("Vendor product export is scoped to the vendor's own products", res.status === 200 && vendorCsv.rows.some((r) => r["Variant SKU"] === sku("HD-BLK-M")) && !vendorCsv.rows.some((r) => r["Variant SKU"] === sku("GOOD")));
    res = await get("/admin/products", vendorCookie);
    check("Vendor cannot open admin products (redirected)", res.status === 307);
  } finally {
    const { firebaseAdminAuth } = await import("../src/lib/firebase/admin");
    for (const uid of created.firebaseUids) await firebaseAdminAuth().deleteUser(uid).catch(() => undefined);
    const productIds = [...created.productIds, ...(await prisma.product.findMany({ where: { ownerId: { in: created.ownerIds } }, select: { id: true } })).map((p) => p.id)];
    const all = await prisma.order.findMany({ where: { OR: [{ items: { some: { ownerId: { in: created.ownerIds } } } }, { warehouseId: { in: created.warehouseIds } }] }, select: { id: true } });
    all.forEach((o) => created.orderIds.add(o.id));
    const orderIds = [...created.orderIds];
    await prisma.inventoryTransaction.deleteMany({ where: { OR: [{ orderId: { in: orderIds } }, { variant: { productId: { in: productIds } } }, { warehouseId: { in: created.warehouseIds } }] } });
    await prisma.returnItem.deleteMany({ where: { return: { orderId: { in: orderIds } } } });
    await prisma.return.deleteMany({ where: { orderId: { in: orderIds } } });
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
    await prisma.importJob.deleteMany({ where: { id: { in: created.importJobIds } } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: [...created.ownerIds, ...productIds, ...created.warehouseIds, ...created.userIds, ...orderIds, ...created.importJobIds] } }, { userId: { in: created.userIds } }] } });
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
