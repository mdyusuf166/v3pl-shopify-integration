/**
 * Operational charges + owner settlement ledger (NR-8 / NR-9, D-063 / D-064).
 *
 * Charges: rule creation/validation, active/inactive, weight / dimension / combined ranges, per-unit / per-shipment /
 * per-order basis, historical immutability. Finance (D-064 rules): vendors get NO automatic payable at receiving or
 * shipping — Admin allocates received units into payables (never twice, never over the received quantity) and gross
 * margin is a report; 3PL clients get an automatic PRODUCT_VALUE payable per shipped unit, operational charges on the
 * separate receivable side, payments settle one side only, nothing is netted. Idempotency, owner isolation, admin
 * access, legacy compatibility, HTTP pages and permissions.
 *
 * Usage: npm run e2e:finance -- http://localhost:3100 vendor3pl@gmail.com
 */
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });
loadEnv();

const [base = "http://localhost:3100", adminEmail = "vendor3pl@gmail.com"] = process.argv.slice(2);
const RUN = `fi${Date.now().toString(36)}`.toUpperCase();
const results: { name: string; ok: boolean; skipped?: boolean }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const skip = (name: string, why: string) => {
  results.push({ name, ok: true, skipped: true });
  console.log(`SKIP  ${name} — ${why}`);
};
const n = (v: { toString(): string } | null | undefined) => (v === null || v === undefined ? NaN : Number(v.toString()));
const eq = (a: { toString(): string } | null | undefined, b: number) => Math.abs(n(a) - b) < 0.005;
const fails = async <T>(p: Promise<T>) => p.then(() => null).catch((e) => e as Error & { code?: string });

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const owners = await import("../src/server/services/owners");
  const users = await import("../src/server/services/users");
  const products = await import("../src/server/services/products");
  const warehouses = await import("../src/server/services/warehouses");
  const receiving = await import("../src/server/services/receiving");
  const orders = await import("../src/server/services/orders");
  const fulfillment = await import("../src/server/services/fulfillment");
  const charges = await import("../src/server/services/charges");
  const finance = await import("../src/server/services/finance");
  const { productFormSchema } = await import("../src/lib/validation/products");
  const { ownerFormSchema } = await import("../src/lib/validation/owners");
  const { chargeRuleFormSchema, settlementFormSchema, vendorPayableFormSchema } = await import("../src/lib/validation/finance");
  const { Prisma } = await import("../src/generated/prisma/client");

  const admin = await prisma.user.findFirstOrThrow({ where: { email: adminEmail, role: "ADMIN" } });
  const created = { ownerIds: [] as string[], warehouseIds: [] as string[], ruleIds: [] as string[], userIds: [] as string[], firebaseUids: [] as string[], orderIds: new Set<string>() };
  const ownerInput = (code: string, businessName: string, chargesEnabled: boolean) => ownerFormSchema.parse({ code, businessName, contactName: "Contact", email: "", phone: "", addressLine1: "", addressLine2: "", city: "Austin", state: "", postalCode: "", country: "US", notes: "", chargesEnabled });
  const sku = (s: string) => `${RUN}-${s}`;
  const shipTo = (nm: string) => ({ customerName: `${nm} ${RUN}`, customerEmail: `${nm.toLowerCase()}.${RUN.toLowerCase()}@example.com`, shipName: `${nm} ${RUN}`, shipAddress1: "1 Ledger Ln", shipCity: "Austin", shipCountry: "US" });
  const rule = (v: Record<string, unknown>) => chargeRuleFormSchema.parse({ name: "rule", chargeType: "PICKING", basis: "PER_UNIT", amount: "1.00", active: true, ownerType: "", ownerId: "", ...v });
  const settle = (kind: string, amount: string, key: string, extra: Record<string, unknown> = {}) => settlementFormSchema.parse({ kind, amount, idempotencyKey: `${RUN}-${key}`, ...extra });
  const payable = (receivingItemId: string, quantity: number, key: string, extra: Record<string, unknown> = {}) => vendorPayableFormSchema.parse({ receivingItemId, quantity, idempotencyKey: `${RUN}-${key}`, ...extra });
  const ALL = { ownerId: undefined } as const;
  const ledger = (where: Record<string, unknown>) => prisma.ledgerEntry.findMany({ where, orderBy: { createdAt: "asc" } });

  try {
    // ---------------------------------------------------------------- fixtures
    const V = await owners.createOwner("VENDOR", ownerInput(`${RUN}-V`, `FI Vendor ${RUN}`, true), admin.id);
    const V2 = await owners.createOwner("VENDOR", ownerInput(`${RUN}-V2`, `FI Vendor NoCharges ${RUN}`, false), admin.id);
    const C = await owners.createOwner("THREEPL_CLIENT", ownerInput(`${RUN}-C`, `FI Client ${RUN}`, true), admin.id);
    created.ownerIds.push(V.id, V2.id, C.id);
    check("Owner flag: chargesEnabled stored per owner (V on, V2 off, C on) through the existing owner form schema; default is off", V.chargesEnabled && !V2.chargesEnabled && C.chargesEnabled && (await prisma.owner.create({ data: { type: "VENDOR", code: `${RUN}-D`, businessName: "default" } })).chargesEnabled === false);
    const W = await warehouses.createWarehouse({ code: `${RUN}-W`, name: "FI Warehouse", addressLine1: null, addressLine2: null, city: "Dallas", state: null, postalCode: null, country: "US", notes: null }, admin.id);
    created.warehouseIds.push(W.id);
    const main = (await warehouses.getDefaultLocation(W.id))!;
    const pV = await products.createProduct(
      productFormSchema.parse({
        ownerId: V.id,
        name: `FI Goods ${RUN}`,
        status: "ACTIVE",
        variants: [
          { sku: sku("H"), price: "15.00", wholesalePrice: "10.00", weightGrams: "2000", lengthCm: "40", widthCm: "20", heightCm: "10", status: "ACTIVE" }, // heavy + bulky; retail 15 / wholesale 10
          { sku: sku("L"), price: "7.00", wholesalePrice: "3.50", weightGrams: "200", lengthCm: "10", widthCm: "5", heightCm: "2", status: "ACTIVE" }, // light + small
          { sku: sku("N"), price: "5.00", status: "ACTIVE" }, // no wholesale price, no physical data
        ],
      }),
      admin.id,
    );
    const pC = await products.createProduct(productFormSchema.parse({ ownerId: C.id, name: `FI Client Goods ${RUN}`, status: "ACTIVE", variants: [{ sku: sku("X"), price: "9.00", wholesalePrice: "10.00", weightGrams: "500", lengthCm: "30", widthCm: "10", heightCm: "10", status: "ACTIVE" }] }), admin.id);
    const pV2 = await products.createProduct(productFormSchema.parse({ ownerId: V2.id, name: `FI V2 Goods ${RUN}`, status: "ACTIVE", variants: [{ sku: sku("Y"), price: "20.00", wholesalePrice: "4.00", status: "ACTIVE" }] }), admin.id);
    const vid = Object.fromEntries([...pV.variants, ...pC.variants, ...pV2.variants].map((v) => [v.sku.slice(RUN.length + 1), v.id]));
    // Receiving: 100 × H for the vendor (the allocation case), then the rest
    const rcV = await receiving.createReceiving({ ownerId: V.id, warehouseId: W.id, reference: `${RUN}-PO-1`, notes: null, lines: [{ variantId: vid.H, locationId: main.id, quantity: 100 }, { variantId: vid.L, locationId: main.id, quantity: 50 }, { variantId: vid.N, locationId: main.id, quantity: 50 }] }, admin.id);
    await receiving.createReceiving({ ownerId: C.id, warehouseId: W.id, reference: `${RUN}-3PL-IN`, notes: null, lines: [{ variantId: vid.X, locationId: main.id, quantity: 1000 }] }, admin.id);
    await receiving.createReceiving({ ownerId: V2.id, warehouseId: W.id, reference: `${RUN}-PO-2`, notes: null, lines: [{ variantId: vid.Y, locationId: main.id, quantity: 50 }] }, admin.id);
    const rcItems = await prisma.receivingItem.findMany({ where: { receivingId: (rcV as { id: string }).id } });
    const lineH = rcItems.find((i) => i.variantId === vid.H)!;
    const lineN = rcItems.find((i) => i.variantId === vid.N)!;
    check("V1 / 3PL-R. Receiving creates NO ledger entries: vendor 100 × H → 0 payable; 3PL 1000 × X → 0 product-value payable", (await prisma.ledgerEntry.count({ where: { ownerId: { in: [V.id, V2.id, C.id] } } })) === 0 && lineH.quantity === 100);

    // ---------------------------------------------------------------- 1–3. rules
    const mk = async (v: Record<string, unknown>) => {
      const r = await charges.createChargeRule(rule(v), admin.id);
      created.ruleIds.push(r.id);
      return r;
    };
    const r1 = await mk({ name: `Pick ${RUN}`, chargeType: "PICKING", basis: "PER_UNIT", amount: "0.50" });
    const r2 = await mk({ name: `Pack ${RUN}`, chargeType: "PACKING", basis: "PER_SHIPMENT", amount: "2.00" });
    const r3 = await mk({ name: `Ship handling ${RUN}`, chargeType: "SHIPPING", basis: "PER_ORDER", amount: "5.00", ownerType: "VENDOR" });
    const r4 = await mk({ name: `Heavy unit ${RUN}`, chargeType: "FULFILLMENT", basis: "PER_UNIT", amount: "1.25", minWeightGrams: "1000", maxWeightGrams: "5000" });
    const r5 = await mk({ name: `Bulky unit ${RUN}`, chargeType: "SERVICE", basis: "PER_UNIT", amount: "0.75", minLongestCm: "30", maxLongestCm: "100" });
    const r6 = await mk({ name: `Heavy and bulky ${RUN}`, chargeType: "UTILITY", basis: "PER_UNIT", amount: "3.00", minWeightGrams: "1000", minLongestCm: "30" });
    const r7 = await mk({ name: `Inactive ${RUN}`, chargeType: "OTHER", basis: "PER_UNIT", amount: "9.99", active: false });
    const r8 = await mk({ name: `Client fulfilment ${RUN}`, chargeType: "FULFILLMENT", basis: "PER_UNIT", amount: "5.00", ownerId: C.id, ownerType: "VENDOR" });
    const stored = await prisma.chargeRule.findUniqueOrThrow({ where: { id: r8.id } });
    check("1. Rule creation: type, basis, decimal amount, ranges, owner applicability stored; owner-specific rule drops the owner-type filter; audit row written", eq(r1.amount, 0.5) && r4.minWeightGrams === 1000 && r4.maxWeightGrams === 5000 && eq(r5.minLongestCm, 30) && r3.ownerType === "VENDOR" && r3.ownerId === null && stored.ownerId === C.id && stored.ownerType === null && (await prisma.auditLog.count({ where: { entityType: "ChargeRule", action: "charge_rule.created", entityId: { in: created.ruleIds } } })) === 8);
    const bad = (v: Record<string, unknown>) => !chargeRuleFormSchema.safeParse({ name: "ok", chargeType: "PICKING", basis: "PER_UNIT", amount: "1.00", ...v }).success;
    check("2. Rule validation: zero / negative / malformed amounts, inverted weight or dimension ranges, missing name and unknown type are rejected", bad({ amount: "0" }) && bad({ amount: "-1" }) && bad({ amount: "1.234" }) && bad({ amount: "abc" }) && bad({ minWeightGrams: "500", maxWeightGrams: "100" }) && bad({ minLongestCm: "50", maxLongestCm: "10" }) && bad({ name: "" }) && bad({ chargeType: "TAX" }) && bad({ basis: "PER_KG" }) && !bad({ minWeightGrams: "", maxWeightGrams: "" }));
    const missingOwner = await fails(charges.createChargeRule(rule({ name: "Missing owner", ownerId: "nope-" + RUN }), admin.id));
    check("2b. Rule validation: a rule for a non-existent owner is refused", missingOwner?.code === "OWNER_NOT_FOUND");
    const applicable = await charges.applicableRules(prisma, { id: V.id, type: "VENDOR" });
    check("3. Active/inactive: inactive rule never applicable; owner-specific rule for C not applicable to V; vendors-only rule applicable to V", !applicable.some((r) => r.id === r7.id) && !applicable.some((r) => r.id === r8.id) && applicable.some((r) => r.id === r3.id) && applicable.length === 6);

    // ---------------------------------------------------------------- 4–6. matching (pure)
    const H = { weightGrams: 2000, longestCm: 40 };
    const L = { weightGrams: 200, longestCm: 10 };
    const N = { weightGrams: null, longestCm: null };
    check("4. Weight-based rule: 2000 g matches 1000–5000 g, 200 g does not, unknown weight never matches", charges.ruleMatches(r4, H) && !charges.ruleMatches(r4, L) && !charges.ruleMatches(r4, N));
    check("5. Dimension-based rule (longest side): 40 cm matches 30–100 cm, 10 cm does not, unknown dimensions never match; longest side derived from L×W×H", charges.ruleMatches(r5, H) && !charges.ruleMatches(r5, L) && !charges.ruleMatches(r5, N) && charges.longestSideCm({ weightGrams: null, lengthCm: 10, widthCm: 25, heightCm: 5 }) === 25 && charges.longestSideCm({ weightGrams: null, lengthCm: 10, widthCm: null, heightCm: 5 }) === null);
    check("6. Combined weight + dimension rule: both must hold (heavy+bulky yes; light+small no; heavy but small no)", charges.ruleMatches(r6, H) && !charges.ruleMatches(r6, L) && !charges.ruleMatches(r6, { weightGrams: 2000, longestCm: 10 }) && charges.ruleMatches(r1, N));

    // ---------------------------------------------------------------- 7 / V2 / 21 / 22. vendor order, two shipments: charges yes, payable NO
    const o1 = await orders.createOrder({ source: "MANUAL", ...shipTo("Ada"), warehouseId: W.id, reserve: true, lines: [{ variantId: vid.H, quantity: 2, unitPrice: "15.00" }, { variantId: vid.L, quantity: 3, unitPrice: "7.00" }, { variantId: vid.N, quantity: 1, unitPrice: "5.00" }] }, admin.id);
    created.orderIds.add(o1.orderId);
    const items1 = await prisma.orderItem.findMany({ where: { orderId: o1.orderId } });
    const item = (v: string) => items1.find((i) => i.variantId === v)!;
    const ship = async (orderId: string, lines: { orderItemId: string; quantity: number }[]) => {
      const f = await fulfillment.startPicking({ orderId, warehouseId: W.id, lines }, admin.id);
      return fulfillment.shipFulfillment(f.id, { carrier: "UPS", trackingNumber: `1Z${RUN}${Math.random().toString(36).slice(2, 6)}` }, admin.id);
    };
    const s1 = await ship(o1.orderId, [{ orderItemId: item(vid.H).id, quantity: 2 }, { orderItemId: item(vid.N).id, quantity: 1 }]);
    const c1 = await prisma.charge.findMany({ where: { shipmentId: s1.id }, orderBy: { ruleName: "asc" } });
    const by = (rows: typeof c1, id: string) => rows.filter((c) => c.ruleId === id);
    check("7a. First shipment (2 × H + 1 × N): per-unit pick for both items (H 2×0.50, N 1×0.50), per-shipment pack once (2.00), per-order handling once (5.00), heavy (2×1.25), bulky (2×0.75), heavy+bulky (2×3.00) for H only; inactive rule absent; N (no physical data) matches only the un-ranged rule", by(c1, r1.id).length === 2 && eq(by(c1, r1.id).find((c) => c.orderItemId === item(vid.H).id)?.amount, 1.0) && eq(by(c1, r1.id).find((c) => c.orderItemId === item(vid.N).id)?.amount, 0.5) && by(c1, r2.id).length === 1 && eq(by(c1, r2.id)[0].amount, 2.0) && by(c1, r3.id).length === 1 && eq(by(c1, r3.id)[0].amount, 5.0) && by(c1, r4.id).length === 1 && eq(by(c1, r4.id)[0].amount, 2.5) && by(c1, r5.id).length === 1 && eq(by(c1, r5.id)[0].amount, 1.5) && by(c1, r6.id).length === 1 && eq(by(c1, r6.id)[0].amount, 6.0) && by(c1, r7.id).length === 0 && c1.length === 7, `${c1.length} charges: ${c1.map((c) => `${c.ruleName.split(" ")[0]}=${c.amount}`).join(" ")}`);
    check("21. Operational event creates exactly the intended charges (7) with frozen rule name / unit amount, quantity, reason, order + shipment + owner references", c1.every((c) => c.ownerId === V.id && c.orderId === o1.orderId && c.shipmentId === s1.id && c.reason.includes(o1.orderNumber) && c.ruleName.length > 0 && eq(c.amount, n(c.unitAmount) * c.quantity)));
    const v1 = await ledger({ ownerId: V.id, shipmentId: s1.id });
    check("V2. Shipping vendor-owned units creates NO payable: every entry from the shipment is a CHARGE on the RECEIVABLE account; no PRODUCT_VALUE / VENDOR_PAYABLE / payable-side entry", v1.length === 7 && v1.every((e) => e.type === "CHARGE" && e.account === "RECEIVABLE" && e.effect === "INCREASE") && (await prisma.ledgerEntry.count({ where: { ownerId: V.id, account: "PAYABLE" } })) === 0);
    check("10. Owner charge entries: every charge has exactly one RECEIVABLE INCREASE ledger entry linked by chargeId with the same amount", v1.length === c1.length && c1.every((c) => v1.some((e) => e.chargeId === c.id && eq(e.amount, n(c.amount)))));
    await prisma.$transaction((tx) => finance.recordShipmentFinancials(tx, s1.id, admin.id));
    check("22. Same event cannot create duplicate charges or entries (re-running the shipment financials is a no-op)", (await prisma.charge.count({ where: { shipmentId: s1.id } })) === 7 && (await prisma.ledgerEntry.count({ where: { shipmentId: s1.id } })) === 7);
    const s2 = await ship(o1.orderId, [{ orderItemId: item(vid.L).id, quantity: 3 }]);
    const c2 = await prisma.charge.findMany({ where: { shipmentId: s2.id } });
    check("7b. Second shipment of the same order (3 × L): per-unit pick 1.50, per-shipment pack again 2.00, per-order handling NOT again, no ranged rule (light + small); still no payable", c2.length === 2 && eq(by(c2, r1.id)[0]?.amount, 1.5) && eq(by(c2, r2.id)[0]?.amount, 2.0) && by(c2, r3.id).length === 0 && (await prisma.charge.count({ where: { orderId: o1.orderId, ruleId: r3.id } })) === 1 && (await prisma.ledgerEntry.count({ where: { ownerId: V.id, account: "PAYABLE" } })) === 0);

    // ---------------------------------------------------------------- V3–V9. vendor manual payable allocation against received inventory
    const alloc0 = (await finance.receivingAllocations(V.id)).find((a) => a.receivingItemId === lineH.id)!;
    const p60 = await finance.createVendorPayable(V.id, payable(lineH.id, 60, "p60", { reference: `INV-${RUN}-1` }), admin.id);
    const p60Row = await prisma.ledgerEntry.findUniqueOrThrow({ where: { id: p60.id } });
    const alloc1 = (await finance.receivingAllocations(V.id)).find((a) => a.receivingItemId === lineH.id)!;
    check("V3. Admin allocates 60 of 100 received units into a payable: VENDOR_PAYABLE, PAYABLE INCREASE, 60 × historical wholesale 10.00 = 600.00, linked to the receiving line, reference + actor + audit", p60.created && alloc0.received === 100 && alloc0.allocated === 0 && alloc0.remaining === 100 && p60Row.type === "VENDOR_PAYABLE" && p60Row.account === "PAYABLE" && p60Row.effect === "INCREASE" && eq(p60Row.amount, 600) && p60Row.quantity === 60 && eq(p60Row.unitAmount, 10) && p60Row.receivingItemId === lineH.id && p60Row.reference === `INV-${RUN}-1` && p60Row.createdById === admin.id && (await prisma.auditLog.count({ where: { entityId: p60.id, action: "ledger.vendor_payable_created" } })) === 1);
    check("V4. Remaining quantity becomes 40 (received 100, allocated 60) and the UI data shows all three figures", alloc1.received === 100 && alloc1.allocated === 60 && alloc1.remaining === 40);
    const over = await fails(finance.createVendorPayable(V.id, payable(lineH.id, 41, "p41"), admin.id));
    check("V6. Cannot allocate 41 after 60: OVER_ALLOCATED, no entry written", over?.code === "OVER_ALLOCATED" && (await prisma.ledgerEntry.count({ where: { receivingItemId: lineH.id } })) === 1);
    const raced = await Promise.all([25, 25, 25].map((q, i) => finance.createVendorPayable(V.id, payable(lineH.id, q, `race${i}`), admin.id).then(() => "ok" as const).catch((e) => (e as { code?: string }).code ?? "err")));
    const afterRace = (await finance.receivingAllocations(V.id)).find((a) => a.receivingItemId === lineH.id)!;
    check("V7. Same received quantity cannot be allocated twice, even concurrently: three parallel 25-unit payables against 40 remaining → exactly one is refused (row lock), allocated total never exceeds 100", raced.filter((r) => r === "ok").length === 1 && raced.filter((r) => r === "OVER_ALLOCATED").length === 2 && afterRace.allocated === 85 && afterRace.remaining === 15, raced.join(","));
    const p15 = await finance.createVendorPayable(V.id, payable(lineH.id, 15, "p15", { unitAmount: "9.50", notes: "negotiated" }), admin.id);
    const p15Row = await prisma.ledgerEntry.findUniqueOrThrow({ where: { id: p15.id } });
    const full = (await finance.receivingAllocations(V.id)).find((a) => a.receivingItemId === lineH.id)!;
    check("V5. Another payable can allocate up to the remaining quantity (15) with an explicit historical unit cost (9.50 → 142.50); the line is then fully allocated and disappears from the 'remaining' list", p15.created && eq(p15Row.amount, 142.5) && eq(p15Row.unitAmount, 9.5) && full.remaining === 0 && !(await finance.receivingAllocations(V.id, { onlyRemaining: true })).some((a) => a.receivingItemId === lineH.id) && (await fails(finance.createVendorPayable(V.id, payable(lineH.id, 1, "p1"), admin.id)))?.code === "OVER_ALLOCATED");
    const dupP = await finance.createVendorPayable(V.id, payable(lineH.id, 60, "p60"), admin.id);
    const noCost = await fails(finance.createVendorPayable(V.id, payable(lineN.id, 1, "pN"), admin.id));
    const wrongOwner = await fails(finance.createVendorPayable(V2.id, payable(lineN.id, 1, "pWrong"), admin.id));
    const notVendor = await fails(finance.createVendorPayable(C.id, payable(lineN.id, 1, "pC"), admin.id));
    check("V8. Payable idempotency + guards: same key → existing entry; a SKU without wholesale price needs an explicit unit cost; another owner's line is refused; 3PL clients cannot receive manual payables", !dupP.created && dupP.id === p60.id && noCost?.code === "INVALID" && wrongOwner?.code === "NOT_FOUND" && notVendor?.code === "INVALID");
    await prisma.productVariant.update({ where: { id: vid.H }, data: { wholesalePrice: "12.00" } });
    check("V9. Payable preserves the historical unit cost: changing the wholesale price to 12.00 leaves 600.00 / 250.00 / 142.50 untouched", eq((await prisma.ledgerEntry.findUniqueOrThrow({ where: { id: p60.id } })).amount, 600) && eq((await prisma.ledgerEntry.aggregate({ where: { receivingItemId: lineH.id }, _sum: { amount: true } }))._sum.amount, 992.5));
    await prisma.productVariant.update({ where: { id: vid.H }, data: { wholesalePrice: "10.00" } });

    // ---------------------------------------------------------------- V10–V11. vendor gross margin (report) vs payable
    const gm = await finance.vendorGrossMargin(V.id);
    const bV = await finance.ownerBalance(V.id);
    check("V10. Gross margin: shipped 2 × H (15 retail / 10 wholesale) + 3 × L (7 / 3.50) + 1 × N (5 / no cost) → sales 56.00, cost 30.50, gross margin 25.50, 6 units (5 with cost)", eq(gm.sales, 56) && eq(gm.cost, 30.5) && eq(gm.grossMargin, 25.5) && gm.units === 6 && gm.unitsWithCost === 5, `${gm.sales} − ${gm.cost} = ${gm.grossMargin}`);
    check("V11. Payable and gross margin are separate: vendor payable open = 992.50 (manual allocations only), receivable = 22.00 (charges), gross margin 25.50 appears nowhere in the ledger", eq(bV.payable.open, 992.5) && eq(bV.receivable.open, 22.0) && (await prisma.ledgerEntry.count({ where: { ownerId: V.id, amount: new Prisma.Decimal("25.50") } })) === 0 && Object.keys(bV.payable.byType).join() === "VENDOR_PAYABLE" && Object.keys(bV.receivable.byType).join() === "CHARGE");

    // ---------------------------------------------------------------- 3PL-S1…S7. 3PL: product value payable at shipment + separate charges
    const oC = await orders.createOrder({ source: "MANUAL", ...shipTo("Cid"), warehouseId: W.id, reserve: true, lines: [{ variantId: vid.X, quantity: 1, unitPrice: "9.00" }] }, admin.id);
    created.orderIds.add(oC.orderId);
    const sC = await ship(oC.orderId, (await prisma.orderItem.findMany({ where: { orderId: oC.orderId } })).map((i) => ({ orderItemId: i.id, quantity: 1 })));
    const pv = await ledger({ ownerId: C.id, shipmentId: sC.id, type: "PRODUCT_VALUE" });
    const cC = await prisma.charge.findMany({ where: { shipmentId: sC.id } });
    let bC = await finance.ownerBalance(C.id);
    check("3PL-S1. Shipping 1 owner unit creates exactly one PRODUCT_VALUE payable: 1 × 10.00 = 10.00, PAYABLE INCREASE, references owner, order, shipment, quantity and unit value", pv.length === 1 && eq(pv[0].amount, 10) && pv[0].account === "PAYABLE" && pv[0].effect === "INCREASE" && pv[0].orderId === oC.orderId && pv[0].shipmentId === sC.id && pv[0].quantity === 1 && eq(pv[0].unitAmount, 10) && pv[0].dedupeKey.startsWith(`product-value:shipment:${sC.id}:item:`));
    check("3PL-S3. Operational charges still created for the 3PL (charges enabled): pick 0.50 + client fulfilment 5.00 + bulky 0.75 + pack 2.00; vendors-only handling NOT applied; each on the RECEIVABLE account", cC.length === 4 && eq(by(cC, r8.id)[0]?.amount, 5.0) && by(cC, r3.id).length === 0 && (await prisma.ledgerEntry.count({ where: { ownerId: C.id, type: "CHARGE", account: "RECEIVABLE" } })) === 4, cC.map((c) => `${c.ruleName.split(" ")[0]}=${c.amount}`).join(" "));
    check("3PL-S4. Payable and receivable remain separate: payable 10.00 (product value) and receivable 8.25 (charges) — NOT netted to 1.75", eq(bC.payable.open, 10) && eq(bC.receivable.open, 8.25) && !("net" in bC));
    await prisma.$transaction((tx) => finance.recordShipmentFinancials(tx, sC.id, admin.id));
    check("3PL-S2. Re-running the same shipment does not duplicate the product-value payable or the charges", (await prisma.ledgerEntry.count({ where: { ownerId: C.id, type: "PRODUCT_VALUE" } })) === 1 && (await prisma.charge.count({ where: { shipmentId: sC.id } })) === 4);
    const payC = await finance.recordSettlement(C.id, settle("PAYMENT_TO_OWNER", "4.00", "payC", { reference: `PAY-${RUN}-C` }), admin.id);
    bC = await finance.ownerBalance(C.id);
    const payRow = await prisma.ledgerEntry.findUniqueOrThrow({ where: { id: payC.id } });
    check("3PL-S5. Payment to the 3PL (4.00) reduces the PAYABLE only: payable 6.00, receivable still 8.25; entry is PAYMENT / PAYABLE / DECREASE with reference, actor and audit", payC.created && eq(bC.payable.open, 6) && eq(bC.receivable.open, 8.25) && payRow.account === "PAYABLE" && payRow.effect === "DECREASE" && payRow.reference === `PAY-${RUN}-C` && payRow.createdById === admin.id && (await prisma.auditLog.count({ where: { entityId: payC.id, action: "ledger.payment_recorded" } })) === 1);
    const recvC = await finance.recordSettlement(C.id, settle("PAYMENT_FROM_OWNER", "3.25", "recvC"), admin.id);
    bC = await finance.ownerBalance(C.id);
    check("3PL-S6. Payment from the 3PL (3.25) reduces the RECEIVABLE only: receivable 5.00, payable still 6.00 — no automatic netting", recvC.created && eq(bC.receivable.open, 5) && eq(bC.payable.open, 6));
    const adjP = await finance.recordSettlement(C.id, settle("ADJUSTMENT_PAYABLE_DECREASE", "1.00", "adjP", { notes: "damaged unit write-down" }), admin.id);
    const adjR = await finance.recordSettlement(C.id, settle("ADJUSTMENT_RECEIVABLE", "0.50", "adjR"), admin.id);
    bC = await finance.ownerBalance(C.id);
    check("3PL-S7. Adjustments touch one side each: payable decrease 1.00 → 5.00; receivable increase 0.50 → 5.50; both traceable as ADJUSTMENT entries on their account", adjP.created && adjR.created && eq(bC.payable.open, 5) && eq(bC.receivable.open, 5.5) && eq(bC.payable.byType.ADJUSTMENT?.decreased, 1) && eq(bC.receivable.byType.ADJUSTMENT?.increased, 0.5));
    const allC = await ledger({ ownerId: C.id });
    const manualPay = allC.filter((e) => e.account === "PAYABLE").reduce((t, e) => t + (e.effect === "INCREASE" ? n(e.amount) : -n(e.amount)), 0);
    const manualRec = allC.filter((e) => e.account === "RECEIVABLE").reduce((t, e) => t + (e.effect === "INCREASE" ? n(e.amount) : -n(e.amount)), 0);
    check("16. Ledger consistency: both balances derive from the entries (manual Σ per account = service), one CHARGE entry per charge, all amounts positive, no stored balance", eq(bC.payable.open, manualPay) && eq(bC.receivable.open, manualRec) && allC.filter((e) => e.type === "CHARGE").length === (await prisma.charge.count({ where: { ownerId: C.id } })) && allC.every((e) => n(e.amount) > 0), `payable ${manualPay.toFixed(2)} receivable ${manualRec.toFixed(2)}`);

    // ---------------------------------------------------------------- 20. idempotency
    const dup = await finance.recordSettlement(C.id, settle("PAYMENT_TO_OWNER", "4.00", "payC"), admin.id);
    const zero = await fails(prisma.$transaction((tx) => finance.postLedgerEntry(tx, { ownerId: V.id, type: "ADJUSTMENT", account: "PAYABLE", effect: "INCREASE", amount: new Prisma.Decimal(0), description: "zero", dedupeKey: `${RUN}-zero`, createdById: admin.id })));
    check("20. Duplicate / idempotent protection: same settlement key → existing entry (created:false), one row; zero / negative amounts refused", !dup.created && dup.id === payC.id && (await prisma.ledgerEntry.count({ where: { dedupeKey: `settlement:${RUN}-payC` } })) === 1 && zero?.code === "INVALID");

    // ---------------------------------------------------------------- 8. historical immutability
    await charges.updateChargeRule(r1.id, rule({ name: `Pick v2 ${RUN}`, chargeType: "PICKING", basis: "PER_UNIT", amount: "0.99" }), admin.id);
    await charges.setChargeRuleActive(r2.id, false, admin.id);
    const stillOld = await prisma.charge.findMany({ where: { ruleId: r1.id, shipmentId: { in: [s1.id, s2.id] } } });
    const oldLedger = await prisma.ledgerEntry.findMany({ where: { shipmentId: { in: [s1.id, s2.id] }, type: "CHARGE" } });
    const o2 = await orders.createOrder({ source: "MANUAL", ...shipTo("Bob"), warehouseId: W.id, reserve: true, lines: [{ variantId: vid.L, quantity: 1 }] }, admin.id);
    created.orderIds.add(o2.orderId);
    const s3 = await ship(o2.orderId, (await prisma.orderItem.findMany({ where: { orderId: o2.orderId } })).map((i) => ({ orderItemId: i.id, quantity: 1 })));
    const c3 = await prisma.charge.findMany({ where: { shipmentId: s3.id } });
    check("8. Historical immutability: editing the pick rule (0.50 → 0.99, renamed) and deactivating pack leave earlier charges and ledger entries untouched; a new shipment uses 0.99 and no pack charge", stillOld.every((c) => eq(c.unitAmount, 0.5) && c.ruleName === `Pick ${RUN}`) && oldLedger.length === 9 && eq(by(c3, r1.id)[0]?.unitAmount, 0.99) && by(c3, r1.id)[0]?.ruleName === `Pick v2 ${RUN}` && by(c3, r2.id).length === 0 && by(c3, r3.id).length === 1);
    check("8b. A rule that has been applied cannot be deleted (IN_USE); charges keep their frozen copy", (await fails(charges.deleteChargeRule(r1.id, admin.id)))?.code === "IN_USE");

    // ---------------------------------------------------------------- 23. several owners in one shipment; charges-disabled vendor
    const o3 = await orders.createOrder({ source: "MANUAL", ...shipTo("Dee"), warehouseId: W.id, reserve: true, lines: [{ variantId: vid.H, quantity: 1 }, { variantId: vid.X, quantity: 2 }] }, admin.id);
    created.orderIds.add(o3.orderId);
    const s4 = await ship(o3.orderId, (await prisma.orderItem.findMany({ where: { orderId: o3.orderId } })).map((i) => ({ orderItemId: i.id, quantity: i.quantity })));
    const c4V = await prisma.charge.findMany({ where: { shipmentId: s4.id, ownerId: V.id } });
    const c4C = await prisma.charge.findMany({ where: { shipmentId: s4.id, ownerId: C.id } });
    const pv4 = await ledger({ shipmentId: s4.id, type: "PRODUCT_VALUE" });
    check("23. Multiple owners in one shipment stay isolated: vendor gets pick + order handling (vendors only) + heavy/bulky/combined and NO product value; 3PL client gets pick (2 × 0.99), bulky, its own fulfilment rule (2 × 5.00) and a 20.00 product-value payable; nothing crosses owners", c4V.length === 5 && by(c4V, r3.id).length === 1 && by(c4V, r8.id).length === 0 && c4C.length === 3 && eq(by(c4C, r8.id)[0]?.amount, 10) && by(c4C, r3.id).length === 0 && pv4.length === 1 && pv4[0].ownerId === C.id && eq(pv4[0].amount, 20), `V ${c4V.map((c) => c.ruleName.split(" ")[0]).join("/")} · C ${c4C.map((c) => c.ruleName.split(" ")[0]).join("/")}`);
    const o4 = await orders.createOrder({ source: "MANUAL", ...shipTo("Eve"), warehouseId: W.id, reserve: true, lines: [{ variantId: vid.Y, quantity: 2 }] }, admin.id);
    created.orderIds.add(o4.orderId);
    const s5 = await ship(o4.orderId, (await prisma.orderItem.findMany({ where: { orderId: o4.orderId } })).map((i) => ({ orderItemId: i.id, quantity: 2 })));
    check("23b. Vendor with charges disabled: shipping creates nothing at all on the ledger (no charges, no payable); both sides stay zero", (await prisma.charge.count({ where: { shipmentId: s5.id } })) === 0 && (await prisma.ledgerEntry.count({ where: { ownerId: V2.id } })) === 0 && eq((await finance.ownerBalance(V2.id)).payable.open, 0) && eq((await finance.ownerBalance(V2.id)).receivable.open, 0));

    // ---------------------------------------------------------------- 17 / 18. isolation and admin access
    const vScope = { ownerId: V.id };
    const pinned = await finance.listLedgerEntries(vScope, { ownerId: C.id });
    const pinnedBalance = await finance.scopedOwnerBalance(vScope, C.id);
    const pinnedMargin = await finance.scopedVendorGrossMargin(vScope, C.id);
    const cLedger = await finance.listLedgerEntries({ ownerId: C.id }, {});
    check("17. Owner isolation: a portal scope pinned to V ignores a requested owner id (V's entries, V's balance, V's gross margin); C's ledger contains only C's entries", pinned.items.every((e) => e.ownerId === V.id) && pinned.total === (await prisma.ledgerEntry.count({ where: { ownerId: V.id } })) && pinnedBalance.ownerId === V.id && eq(pinnedMargin.grossMargin, n(gm.grossMargin) + 8.5) && cLedger.items.every((e) => e.ownerId === C.id) && (await finance.listCharges({ ownerId: C.id }, { ownerId: V.id })).items.every((c) => c.ownerId === C.id));
    const adminV = await finance.listLedgerEntries(ALL, { ownerId: V.id, account: "PAYABLE" });
    const overview = await finance.allOwnerBalances();
    const rowC = overview.rows.find((r) => r.id === C.id)!;
    check("18. Admin access: unrestricted scope reads any owner's ledger (filter by account works); the overview lists every owner with separate payable / receivable; totals are gross sums, never netted", adminV.items.every((e) => e.ownerId === V.id && e.account === "PAYABLE") && adminV.total === 3 && eq(rowC.payable, 25) && eq(rowC.receivable, 5.5 + 2 * 0.99 + 2 * 0.75 + 10) && overview.rows.some((r) => r.id === V.id && eq(r.payable, 992.5)) && n(overview.totals.payable) >= 992.5 + 25 && n(overview.totals.receivable) >= 5.5 && (await fails(finance.listLedgerEntries(ALL, {}))) !== null);

    // ---------------------------------------------------------------- 19. historical compatibility
    const legacy = await orders.createOrder({ source: "MANUAL", ...shipTo("Fay"), warehouseId: W.id, reserve: false, lines: [{ variantId: vid.N, quantity: 1 }] }, admin.id);
    created.orderIds.add(legacy.orderId);
    const emptyBalance = await finance.ownerBalance(`nope-${RUN}`);
    const preFeature = await prisma.order.count({ where: { status: { not: "CANCELLED" }, items: { some: { shippedQty: { gt: 0 } } }, ledgerEntries: { none: {} } } });
    check("19. Historical orders remain compatible: orders without ledger entries load normally, an owner with no entries has zero on both sides, pre-feature shipped orders have no entries (no fabricated history)", !!(await orders.getOrder(legacy.orderId)) && emptyBalance.entries === 0 && eq(emptyBalance.payable.open, 0) && eq(emptyBalance.receivable.open, 0) && preFeature >= 0 && (await prisma.ledgerEntry.count({ where: { orderId: legacy.orderId } })) === 0, `${preFeature} pre-feature shipped orders in this database have no entries`);

    // ---------------------------------------------------------------- HTTP
    const mint = async (tag: string, role: "ADMIN" | "WAREHOUSE" | "VENDOR" | "THREEPL_CLIENT", ownerId: string | null, audience: "staff" | "portal") => {
      const { firebaseAdminAuth } = await import("../src/lib/firebase/admin");
      const u = await users.createUserAccount({ name: `FI ${tag}`, email: `${RUN.toLowerCase()}-${tag}@example.test`, password: "E2eTestPass123", role, ownerId, phone: null, notes: null }, admin.id);
      created.userIds.push(u.id);
      created.firebaseUids.push(u.firebaseUid);
      const custom = await firebaseAdminAuth().createCustomToken(u.firebaseUid);
      const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${process.env.NEXT_PUBLIC_FIREBASE_API_KEY}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: custom, returnSecureToken: true }) });
      const { idToken } = await r.json();
      const res = await fetch(`${base}/api/auth/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken, audience }) });
      return (res.headers.get("set-cookie") ?? "").split(";")[0];
    };
    let ck = { admin: "", wh: "", vendor: "", client: "" };
    try {
      ck = { admin: await mint("admin", "ADMIN", null, "staff"), wh: await mint("wh", "WAREHOUSE", null, "staff"), vendor: await mint("vendor", "VENDOR", V.id, "portal"), client: await mint("client", "THREEPL_CLIENT", C.id, "portal") };
    } catch (err) {
      console.log(`      (session unavailable: ${(err as Error).message.slice(0, 100)})`);
    }
    const httpNames = ["HTTP: admin Finance overview (separate payable / receivable, no netted column), vendor ledger page (balance card, vendor payable form with received / allocated / remaining, gross margin card, settlement form, ledger + charges) and Settings → Charges render", "HTTP: 3PL admin ledger page shows product value payable and charges receivable separately with no vendor payable form; vendor portal Finance shows its own payables + gross margin; 3PL portal shows both sides; WAREHOUSE and portal users cannot open /admin/finance", "HTTP: admin vendor profile shows the two-sided balance card; vendor portal dashboard shows the compact card"];
    if (!ck.admin || !ck.vendor || !ck.client || !ck.wh) for (const nm of httpNames) skip(nm, "no session");
    else {
      const get = async (cookie: string, path: string) => {
        const res = await fetch(`${base}${path}`, { headers: { Cookie: cookie }, redirect: "manual" });
        return { status: res.status, location: res.headers.get("location"), html: (await res.text()).replace(/<!--[\s\S]*?-->/g, "") };
      };
      const fin = await get(ck.admin, "/admin/finance");
      const led = await get(ck.admin, `/admin/finance/${V.id}`);
      const set = await get(ck.admin, "/admin/settings/charges");
      check(httpNames[0], fin.status === 200 && fin.html.includes('data-slot="owner-balances"') && !fin.html.includes("Outstanding balance") && fin.html.includes(`FI Vendor ${RUN}`) && led.status === 200 && led.html.includes('data-slot="balance-card"') && led.html.includes('data-slot="vendor-payable-form"') && led.html.includes('data-slot="receiving-allocations"') && led.html.includes('data-remaining="0"') && led.html.includes('data-slot="gross-margin-card"') && led.html.includes('data-slot="settlement-form"') && led.html.includes('data-slot="ledger-table"') && led.html.includes(`INV-${RUN}-1`) && set.status === 200 && set.html.includes('data-slot="charge-rules"'), `${fin.status}/${led.status}/${set.status}`);
      const ledC = await get(ck.admin, `/admin/finance/${C.id}`);
      const vp = await get(ck.vendor, "/portal/vendor/finance");
      const cp = await get(ck.client, "/portal/3pl/finance");
      const whF = await get(ck.wh, "/admin/finance");
      const vF = await get(ck.vendor, "/admin/finance");
      check(httpNames[1], ledC.status === 200 && ledC.html.includes("Product value") && ledC.html.includes('data-slot="balance-payable"') && ledC.html.includes('data-slot="balance-receivable"') && !ledC.html.includes('data-slot="vendor-payable-form"') && !ledC.html.includes('data-slot="gross-margin-card"') && vp.status === 200 && vp.html.includes('data-slot="gross-margin-card"') && vp.html.includes(`INV-${RUN}-1`) && !vp.html.includes(`PAY-${RUN}-C`) && cp.status === 200 && cp.html.includes(`PAY-${RUN}-C`) && !cp.html.includes(`INV-${RUN}-1`) && !cp.html.includes('data-slot="gross-margin-card"') && whF.status !== 200 && vF.status !== 200, `3pl ${ledC.status} vendor ${vp.status} client ${cp.status} wh ${whF.status}${whF.location ? `→${whF.location}` : ""} vendor@admin ${vF.status}`);
      const prof = await get(ck.admin, `/admin/vendors/${V.id}`);
      const dash = await get(ck.vendor, "/portal/vendor");
      check(httpNames[2], prof.status === 200 && prof.html.includes('data-slot="balance-payable"') && prof.html.includes('data-slot="balance-receivable"') && dash.status === 200 && dash.html.includes('data-slot="balance-card"'));
    }
  } finally {
    const { firebaseAdminAuth } = await import("../src/lib/firebase/admin");
    for (const uid of created.firebaseUids) await firebaseAdminAuth().deleteUser(uid).catch(() => undefined);
    const productIds = (await prisma.product.findMany({ where: { ownerId: { in: created.ownerIds } }, select: { id: true } })).map((p) => p.id);
    const all = await prisma.order.findMany({ where: { OR: [{ items: { some: { ownerId: { in: created.ownerIds } } } }, { warehouseId: { in: created.warehouseIds } }] }, select: { id: true } });
    all.forEach((x) => created.orderIds.add(x.id));
    const orderIds = [...created.orderIds];
    await prisma.ledgerEntry.deleteMany({ where: { OR: [{ ownerId: { in: created.ownerIds } }, { dedupeKey: { startsWith: RUN } }] } });
    await prisma.charge.deleteMany({ where: { ownerId: { in: created.ownerIds } } });
    await prisma.chargeRule.deleteMany({ where: { id: { in: created.ruleIds } } });
    await prisma.inventoryTransaction.deleteMany({ where: { OR: [{ orderId: { in: orderIds } }, { variant: { productId: { in: productIds } } }, { warehouseId: { in: created.warehouseIds } }] } });
    await prisma.shipmentItem.deleteMany({ where: { shipment: { orderId: { in: orderIds } } } });
    await prisma.shipment.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.fulfillmentItem.deleteMany({ where: { fulfillment: { orderId: { in: orderIds } } } });
    await prisma.fulfillment.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.orderEvent.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await prisma.customer.deleteMany({ where: { email: { endsWith: `${RUN.toLowerCase()}@example.com` } } });
    await prisma.inventoryLevel.deleteMany({ where: { OR: [{ variant: { productId: { in: productIds } } }, { warehouseId: { in: created.warehouseIds } }] } });
    await prisma.inventoryBalance.deleteMany({ where: { OR: [{ variant: { productId: { in: productIds } } }, { warehouseId: { in: created.warehouseIds } }] } });
    await prisma.receivingItem.deleteMany({ where: { OR: [{ variant: { productId: { in: productIds } } }, { receiving: { warehouseId: { in: created.warehouseIds } } }] } });
    await prisma.receivingRecord.deleteMany({ where: { OR: [{ ownerId: { in: created.ownerIds } }, { warehouseId: { in: created.warehouseIds } }] } });
    await prisma.productVariant.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.location.deleteMany({ where: { warehouseId: { in: created.warehouseIds } } });
    await prisma.warehouse.deleteMany({ where: { id: { in: created.warehouseIds } } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: [...created.ownerIds, ...productIds, ...created.warehouseIds, ...created.userIds, ...orderIds, ...created.ruleIds] } }, { userId: { in: created.userIds } }, { entityType: "LedgerEntry", newValues: { path: ["ownerId"], string_contains: created.ownerIds[0] ?? RUN } }, { entityType: "LedgerEntry", newValues: { path: ["ownerId"], string_contains: created.ownerIds[2] ?? RUN } }] } });
    await prisma.user.deleteMany({ where: { id: { in: created.userIds } } });
    await prisma.owner.deleteMany({ where: { OR: [{ id: { in: created.ownerIds } }, { code: `${RUN}-D` }] } });
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
