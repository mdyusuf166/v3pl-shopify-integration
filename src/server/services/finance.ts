import { Prisma, type LedgerAccount, type LedgerEffect, type LedgerEntryType, type OwnerType } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import type { CustomerScope as OwnerScope } from "@/lib/customer-scope";
import type { SettlementFormValues, SettlementKind, VendorPayableFormValues } from "@/lib/validation/finance";
import { recordAudit } from "@/server/services/audit";
import { applicableRules, describeBasis, longestSideCm, ruleMatches } from "@/server/services/charges";

/**
 * Owner settlement ledger (NR-9, D-063 / D-064) — operational, not accounting.
 *
 * Two independent accounts per owner, never netted automatically:
 *  - PAYABLE    = what V3PL owes the owner   (open = Σ INCREASE − Σ DECREASE on the payable account)
 *  - RECEIVABLE = what the owner owes V3PL   (open = Σ INCREASE − Σ DECREASE on the receivable account)
 *
 * Vendors (we buy their goods and sell them): receiving and shipping create NO liability. Admin creates a
 * VENDOR_PAYABLE manually against a specific received line (quantity × historical unit cost); a received unit can
 * never be allocated twice. Wholesale price is the product cost used for gross-margin REPORTING only.
 *
 * 3PL clients (they own their goods): shipping their units automatically posts PRODUCT_VALUE payable to them
 * (quantity × the variant's wholesale / product value), while operational charges post to the receivable account.
 * Both sides stay separate and are settled separately.
 *
 * Every write is idempotent through `dedupeKey`; entries are never updated or deleted; history is never
 * recalculated from current rules. Orders shipped before the feature have no entries.
 */

export class FinanceServiceError extends Error {
  constructor(
    public readonly code: "NOT_FOUND" | "FORBIDDEN" | "INVALID" | "OVER_ALLOCATED",
    message: string,
  ) {
    super(message);
  }
}

type Db = Prisma.TransactionClient | typeof prisma;
const D = (v: Prisma.Decimal | string | number) => new Prisma.Decimal(v);
const ZERO = new Prisma.Decimal(0);

// ---------------------------------------------------------------------------
// Scope (owner isolation): the caller derives it from the session, never from the browser
// ---------------------------------------------------------------------------

export type { OwnerScope };

/** Resolve which owner a request may read. Portal users are pinned to their own owner regardless of the argument. */
export function scopedOwnerId(scope: OwnerScope, requested: string | null | undefined): string | null {
  if (scope.ownerId !== undefined) return scope.ownerId; // portal user: only their own owner
  return requested ?? null; // staff: whatever was asked for (null = all owners)
}

// ---------------------------------------------------------------------------
// Ledger primitives
// ---------------------------------------------------------------------------

type EntryInput = {
  ownerId: string;
  type: LedgerEntryType;
  account: LedgerAccount;
  effect: LedgerEffect;
  amount: Prisma.Decimal;
  currency?: string | null;
  quantity?: number | null;
  unitAmount?: Prisma.Decimal | null;
  receivingItemId?: string | null;
  orderId?: string | null;
  shipmentId?: string | null;
  chargeId?: string | null;
  reference?: string | null;
  description: string;
  dedupeKey: string;
  occurredAt?: Date | null;
  createdById: string | null;
};

/** Insert one immutable entry; the same dedupeKey again returns the existing row untouched. */
export async function postLedgerEntry(db: Db, input: EntryInput): Promise<{ id: string; created: boolean }> {
  if (input.amount.lte(0)) throw new FinanceServiceError("INVALID", "Ledger amounts must be positive; use account + effect to express what changes.");
  const existing = await db.ledgerEntry.findUnique({ where: { dedupeKey: input.dedupeKey }, select: { id: true } });
  if (existing) return { id: existing.id, created: false };
  try {
    const row = await db.ledgerEntry.create({
      data: {
        ownerId: input.ownerId,
        type: input.type,
        account: input.account,
        effect: input.effect,
        amount: input.amount,
        currency: input.currency ?? "USD",
        quantity: input.quantity ?? null,
        unitAmount: input.unitAmount ?? null,
        receivingItemId: input.receivingItemId ?? null,
        orderId: input.orderId ?? null,
        shipmentId: input.shipmentId ?? null,
        chargeId: input.chargeId ?? null,
        reference: input.reference ?? null,
        description: input.description,
        dedupeKey: input.dedupeKey,
        occurredAt: input.occurredAt ?? new Date(),
        createdById: input.createdById,
      },
      select: { id: true },
    });
    return { id: row.id, created: true };
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") {
      const raced = await db.ledgerEntry.findUnique({ where: { dedupeKey: input.dedupeKey }, select: { id: true } });
      if (raced) return { id: raced.id, created: false };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Shipment → 3PL product value + charges (called inside the shipping transaction)
// ---------------------------------------------------------------------------

export type ShipmentFinancials = { productValueEntries: number; charges: number; skipped: string[] };

/**
 * Record what a shipment means financially, exactly once per shipment / rule / item:
 *  - THREEPL_CLIENT items → PRODUCT_VALUE payable to the owner, qty × variant.wholesalePrice (their goods left);
 *  - VENDOR items → nothing on the ledger (vendor liabilities are manual, D-064); gross margin is derived in reports;
 *  - owners with charges enabled → one Charge (+ receivable entry) per matching rule: PER_UNIT per order item,
 *    PER_SHIPMENT once per owner per shipment, PER_ORDER once per owner per order (at its first shipment).
 * Rule ranges use the variant's own weightGrams / longest side; unknown data never matches a ranged rule.
 * Re-running for the same shipment is a no-op (dedupe keys), so retries and mirrored events are safe.
 */
export async function recordShipmentFinancials(tx: Prisma.TransactionClient, shipmentId: string, actorId: string | null): Promise<ShipmentFinancials> {
  const shipment = await tx.shipment.findUnique({
    where: { id: shipmentId },
    include: {
      order: { select: { id: true, orderNumber: true, currency: true } },
      items: { include: { orderItem: { select: { id: true, sku: true, ownerId: true, variant: { select: { wholesalePrice: true, weightGrams: true, lengthCm: true, widthCm: true, heightCm: true } } } } } },
    },
  });
  if (!shipment) throw new FinanceServiceError("NOT_FOUND", "Shipment not found.");
  const result: ShipmentFinancials = { productValueEntries: 0, charges: 0, skipped: [] };
  const currency = shipment.order.currency ?? "USD";
  const ownerIds = [...new Set(shipment.items.map((i) => i.orderItem.ownerId))];
  const owners = await tx.owner.findMany({ where: { id: { in: ownerIds } }, select: { id: true, type: true, chargesEnabled: true, businessName: true } });

  for (const owner of owners) {
    const lines = shipment.items.filter((i) => i.orderItem.ownerId === owner.id && i.quantity > 0);

    // 1. Product value owed to a 3PL client for their own shipped goods (vendors: nothing automatic)
    if (owner.type === "THREEPL_CLIENT") {
      for (const line of lines) {
        const value = line.orderItem.variant.wholesalePrice;
        if (value === null) {
          result.skipped.push(`${line.orderItem.sku}: no product value (wholesale price) — no payable entry`);
          continue;
        }
        const r = await postLedgerEntry(tx, {
          ownerId: owner.id,
          type: "PRODUCT_VALUE",
          account: "PAYABLE",
          effect: "INCREASE",
          amount: D(value).mul(line.quantity),
          currency,
          quantity: line.quantity,
          unitAmount: value,
          orderId: shipment.order.id,
          shipmentId: shipment.id,
          description: `Product value of ${line.quantity} × ${line.orderItem.sku} shipped on order ${shipment.order.orderNumber} (${line.quantity} × ${D(value).toFixed(2)})`,
          dedupeKey: `product-value:shipment:${shipment.id}:item:${line.orderItem.id}`,
          createdById: actorId,
        });
        if (r.created) result.productValueEntries++;
      }
    }

    // 2. Operational charges (receivable side)
    if (!owner.chargesEnabled) continue;
    const rules = await applicableRules(tx, owner);
    if (rules.length === 0) continue;
    const unitFigures = (l: (typeof lines)[number]) => ({ weightGrams: l.orderItem.variant.weightGrams, longestCm: longestSideCm(l.orderItem.variant) });
    const totalUnits = lines.reduce((n, l) => n + l.quantity, 0);
    const weights = lines.map((l) => (l.orderItem.variant.weightGrams === null ? null : l.orderItem.variant.weightGrams * l.quantity));
    const longest = lines.map((l) => longestSideCm(l.orderItem.variant));
    const aggregate = { weightGrams: weights.some((w) => w === null) ? null : weights.reduce((a, b) => a! + b!, 0), longestCm: longest.some((x) => x === null) ? null : Math.max(...(longest as number[])) };

    for (const rule of rules) {
      const targets: { key: string; quantity: number; orderItemId: string | null; reason: string }[] = [];
      if (rule.basis === "PER_UNIT") {
        for (const l of lines) {
          if (!ruleMatches(rule, unitFigures(l))) continue;
          targets.push({ key: `charge:shipment:${shipment.id}:rule:${rule.id}:item:${l.orderItem.id}`, quantity: l.quantity, orderItemId: l.orderItem.id, reason: `${rule.name}: ${l.quantity} × ${l.orderItem.sku} shipped on order ${shipment.order.orderNumber}` });
        }
      } else if (totalUnits > 0 && ruleMatches(rule, aggregate)) {
        const perOrder = rule.basis === "PER_ORDER";
        targets.push({ key: perOrder ? `charge:order:${shipment.order.id}:rule:${rule.id}:owner:${owner.id}` : `charge:shipment:${shipment.id}:rule:${rule.id}:owner:${owner.id}`, quantity: 1, orderItemId: null, reason: `${rule.name} (${describeBasis(rule.basis)}) for order ${shipment.order.orderNumber}` });
      }
      for (const t of targets) {
        const existing = await tx.charge.findUnique({ where: { dedupeKey: t.key }, select: { id: true } });
        if (existing) continue; // e.g. PER_ORDER already charged on an earlier shipment
        const amount = D(rule.amount).mul(t.quantity);
        const charge = await tx.charge.create({
          data: { ownerId: owner.id, ruleId: rule.id, chargeType: rule.chargeType, basis: rule.basis, ruleName: rule.name, quantity: t.quantity, unitAmount: rule.amount, amount, currency: rule.currency, reason: t.reason, orderId: shipment.order.id, shipmentId: shipment.id, orderItemId: t.orderItemId, dedupeKey: t.key, createdById: actorId },
          select: { id: true },
        });
        await postLedgerEntry(tx, { ownerId: owner.id, type: "CHARGE", account: "RECEIVABLE", effect: "INCREASE", amount, currency: rule.currency, quantity: t.quantity, orderId: shipment.order.id, shipmentId: shipment.id, chargeId: charge.id, description: t.reason, dedupeKey: `ledger:${t.key}`, createdById: actorId });
        result.charges++;
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Vendor payables: manual allocation against received inventory (D-064)
// ---------------------------------------------------------------------------

export type ReceivingAllocationRow = {
  receivingItemId: string;
  receivingId: string;
  reference: string | null;
  receivedAt: Date;
  warehouse: string;
  variantId: string;
  sku: string;
  title: string;
  received: number;
  allocated: number;
  remaining: number;
  wholesalePrice: Prisma.Decimal | null;
};

/** Received lines of an owner with how much of each has already been allocated to payables. */
export async function receivingAllocations(ownerId: string, opts: { onlyRemaining?: boolean } = {}): Promise<ReceivingAllocationRow[]> {
  const [items, allocated] = await Promise.all([
    prisma.receivingItem.findMany({ where: { receiving: { ownerId } }, orderBy: [{ receiving: { receivedAt: "desc" } }], take: 500, include: { receiving: { select: { id: true, reference: true, receivedAt: true, warehouse: { select: { code: true } } } }, variant: { select: { id: true, sku: true, name: true, wholesalePrice: true, product: { select: { name: true } } } } } }),
    prisma.ledgerEntry.groupBy({ by: ["receivingItemId"], where: { type: "VENDOR_PAYABLE", receivingItem: { receiving: { ownerId } } }, _sum: { quantity: true } }),
  ]);
  const used = new Map(allocated.map((a) => [a.receivingItemId, a._sum.quantity ?? 0]));
  const rows = items.map((i) => {
    const a = used.get(i.id) ?? 0;
    return { receivingItemId: i.id, receivingId: i.receiving.id, reference: i.receiving.reference, receivedAt: i.receiving.receivedAt, warehouse: i.receiving.warehouse.code, variantId: i.variant.id, sku: i.variant.sku, title: i.variant.name ? `${i.variant.product.name} · ${i.variant.name}` : i.variant.product.name, received: i.quantity, allocated: a, remaining: Math.max(0, i.quantity - a), wholesalePrice: i.variant.wholesalePrice };
  });
  return opts.onlyRemaining ? rows.filter((r) => r.remaining > 0) : rows;
}

/**
 * Create a vendor payable for `quantity` units of one received line at a frozen unit cost (default: the variant's
 * wholesale price). Transactional: the received line is row-locked, allocations are summed inside the lock, and
 * quantity > remaining is refused — so the same received unit can never be allocated twice, even concurrently.
 * Same idempotencyKey again → the existing entry.
 */
export async function createVendorPayable(ownerId: string, values: VendorPayableFormValues, actorId: string): Promise<{ id: string; created: boolean }> {
  const owner = await prisma.owner.findUnique({ where: { id: ownerId }, select: { id: true, type: true, businessName: true } });
  if (!owner) throw new FinanceServiceError("NOT_FOUND", "Owner not found.");
  if (owner.type !== "VENDOR") throw new FinanceServiceError("INVALID", "Manual payables against received inventory are for vendors; 3PL clients are credited automatically when their goods ship.");
  const dedupeKey = `vendor-payable:${values.idempotencyKey}`;
  const already = await prisma.ledgerEntry.findUnique({ where: { dedupeKey }, select: { id: true } });
  if (already) return { id: already.id, created: false };
  return prisma.$transaction(async (tx) => {
    // Serialise allocations per received line.
    await tx.$queryRaw`SELECT "id" FROM "ReceivingItem" WHERE "id" = ${values.receivingItemId} FOR UPDATE`;
    const line = await tx.receivingItem.findUnique({ where: { id: values.receivingItemId }, include: { receiving: { select: { ownerId: true, reference: true, receivedAt: true } }, variant: { select: { sku: true, wholesalePrice: true } } } });
    if (!line || line.receiving.ownerId !== ownerId) throw new FinanceServiceError("NOT_FOUND", "Received line not found for this vendor.");
    const used = (await tx.ledgerEntry.aggregate({ where: { type: "VENDOR_PAYABLE", receivingItemId: line.id }, _sum: { quantity: true } }))._sum.quantity ?? 0;
    const remaining = line.quantity - used;
    if (values.quantity > remaining) throw new FinanceServiceError("OVER_ALLOCATED", `Only ${remaining} of ${line.quantity} received unit(s) of ${line.variant.sku} remain unallocated (${used} already in payables).`);
    const unit = values.unitAmount !== null ? D(values.unitAmount) : line.variant.wholesalePrice;
    if (unit === null) throw new FinanceServiceError("INVALID", `${line.variant.sku} has no wholesale price — enter the unit cost for this payable.`);
    const amount = D(unit).mul(values.quantity);
    const r = await postLedgerEntry(tx, {
      ownerId,
      type: "VENDOR_PAYABLE",
      account: "PAYABLE",
      effect: "INCREASE",
      amount,
      quantity: values.quantity,
      unitAmount: D(unit),
      receivingItemId: line.id,
      reference: values.reference,
      description: `Payable for ${values.quantity} × ${line.variant.sku} received ${line.receiving.receivedAt.toISOString().slice(0, 10)}${line.receiving.reference ? ` (${line.receiving.reference})` : ""} at ${D(unit).toFixed(2)}${values.notes ? `: ${values.notes}` : ""}`,
      dedupeKey,
      createdById: actorId,
    });
    if (r.created) await recordAudit({ userId: actorId, action: "ledger.vendor_payable_created", entityType: "LedgerEntry", entityId: r.id, newValues: { ownerId, receivingItemId: line.id, quantity: values.quantity, unitAmount: D(unit).toFixed(2), amount: amount.toFixed(2), reference: values.reference } }, tx);
    return r;
  });
}

// ---------------------------------------------------------------------------
// Manual settlements (payments / authorised adjustments) — each touches ONE account
// ---------------------------------------------------------------------------

const SETTLEMENT_MAP: Record<SettlementKind, { type: LedgerEntryType; account: LedgerAccount; effect: LedgerEffect; description: string }> = {
  PAYMENT_TO_OWNER: { type: "PAYMENT", account: "PAYABLE", effect: "DECREASE", description: "Payment made to owner" },
  PAYMENT_FROM_OWNER: { type: "PAYMENT", account: "RECEIVABLE", effect: "DECREASE", description: "Payment received from owner" },
  ADJUSTMENT_PAYABLE: { type: "ADJUSTMENT", account: "PAYABLE", effect: "INCREASE", description: "Adjustment — payable increased" },
  ADJUSTMENT_PAYABLE_DECREASE: { type: "ADJUSTMENT", account: "PAYABLE", effect: "DECREASE", description: "Adjustment — payable decreased" },
  ADJUSTMENT_RECEIVABLE: { type: "ADJUSTMENT", account: "RECEIVABLE", effect: "INCREASE", description: "Adjustment — receivable increased" },
  ADJUSTMENT_RECEIVABLE_DECREASE: { type: "ADJUSTMENT", account: "RECEIVABLE", effect: "DECREASE", description: "Adjustment — receivable decreased" },
};

/** Record a payment / adjustment on one account. Same idempotencyKey again → the existing entry. Admin only (enforced by the action). */
export async function recordSettlement(ownerId: string, values: SettlementFormValues, actorId: string): Promise<{ id: string; created: boolean }> {
  const owner = await prisma.owner.findUnique({ where: { id: ownerId }, select: { id: true, businessName: true } });
  if (!owner) throw new FinanceServiceError("NOT_FOUND", "Owner not found.");
  const m = SETTLEMENT_MAP[values.kind];
  return prisma.$transaction(async (tx) => {
    const r = await postLedgerEntry(tx, {
      ownerId,
      type: m.type,
      account: m.account,
      effect: m.effect,
      amount: D(values.amount),
      reference: values.reference,
      description: values.notes ? `${m.description}: ${values.notes}` : m.description,
      dedupeKey: `settlement:${values.idempotencyKey}`,
      occurredAt: values.occurredAt,
      createdById: actorId,
    });
    if (r.created) await recordAudit({ userId: actorId, action: m.type === "PAYMENT" ? "ledger.payment_recorded" : "ledger.adjustment_recorded", entityType: "LedgerEntry", entityId: r.id, newValues: { ownerId, kind: values.kind, amount: values.amount, reference: values.reference } }, tx);
    return r;
  });
}

// ---------------------------------------------------------------------------
// Balances (two independent accounts), gross margin, listings (scoped)
// ---------------------------------------------------------------------------

type AccountTotals = { increased: Prisma.Decimal; decreased: Prisma.Decimal; open: Prisma.Decimal; byType: Partial<Record<LedgerEntryType, { increased: Prisma.Decimal; decreased: Prisma.Decimal }>> };

export type OwnerBalance = {
  ownerId: string;
  /** What V3PL owes the owner: product value (3PL) / manual vendor payables + adjustments − payments made to the owner. */
  payable: AccountTotals;
  /** What the owner owes V3PL: operational charges + adjustments − payments received from the owner. */
  receivable: AccountTotals;
  entries: number;
  lastEntryAt: Date | null;
};

const emptyAccount = (): AccountTotals => ({ increased: ZERO, decreased: ZERO, open: ZERO, byType: {} });

/** Both accounts derived from the entries (never a stored column, never netted against each other). */
export async function ownerBalance(ownerId: string): Promise<OwnerBalance> {
  const groups = await prisma.ledgerEntry.groupBy({ by: ["account", "effect", "type"], where: { ownerId }, _sum: { amount: true }, _count: { _all: true }, _max: { occurredAt: true } });
  const b: OwnerBalance = { ownerId, payable: emptyAccount(), receivable: emptyAccount(), entries: 0, lastEntryAt: null };
  for (const g of groups) {
    const acc = g.account === "PAYABLE" ? b.payable : b.receivable;
    const sum = g._sum.amount ?? ZERO;
    const t = (acc.byType[g.type] ??= { increased: ZERO, decreased: ZERO });
    if (g.effect === "INCREASE") {
      acc.increased = acc.increased.add(sum);
      t.increased = t.increased.add(sum);
    } else {
      acc.decreased = acc.decreased.add(sum);
      t.decreased = t.decreased.add(sum);
    }
    b.entries += g._count._all;
    if (g._max.occurredAt && (!b.lastEntryAt || g._max.occurredAt > b.lastEntryAt)) b.lastEntryAt = g._max.occurredAt;
  }
  b.payable.open = b.payable.increased.sub(b.payable.decreased);
  b.receivable.open = b.receivable.increased.sub(b.receivable.decreased);
  return b;
}

/** Admin overview: one row per owner with both open accounts (all owners, including those without entries). Totals are gross, never netted. */
export async function allOwnerBalances(filter: { type?: OwnerType } = {}) {
  const [owners, groups] = await Promise.all([
    prisma.owner.findMany({ where: filter.type ? { type: filter.type } : {}, select: { id: true, code: true, businessName: true, type: true, status: true, chargesEnabled: true }, orderBy: [{ type: "asc" }, { businessName: "asc" }] }),
    prisma.ledgerEntry.groupBy({ by: ["ownerId", "account", "effect"], _sum: { amount: true }, _max: { occurredAt: true } }),
  ]);
  const open = (ownerId: string, account: LedgerAccount) => {
    const inc = groups.find((g) => g.ownerId === ownerId && g.account === account && g.effect === "INCREASE")?._sum.amount ?? ZERO;
    const dec = groups.find((g) => g.ownerId === ownerId && g.account === account && g.effect === "DECREASE")?._sum.amount ?? ZERO;
    return inc.sub(dec);
  };
  const rows = owners.map((o) => {
    const last = groups.filter((g) => g.ownerId === o.id).map((g) => g._max.occurredAt).filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
    return { ...o, payable: open(o.id, "PAYABLE"), receivable: open(o.id, "RECEIVABLE"), lastEntryAt: last };
  });
  const totals = rows.reduce((t, r) => ({ payable: t.payable.add(r.payable), receivable: t.receivable.add(r.receivable) }), { payable: ZERO, receivable: ZERO });
  return { rows, totals };
}

export type GrossMargin = { units: number; unitsWithCost: number; sales: Prisma.Decimal; cost: Prisma.Decimal; grossMargin: Prisma.Decimal };

/**
 * Vendor gross-margin REPORT (not a ledger entry, never a payable): for shipped vendor-owned units,
 * sales = Σ shipped × order unit price (retail; falls back to the variant's retail price), cost = Σ shipped ×
 * wholesale price (units without a wholesale price are counted in `units` but not in cost), gross margin = sales − cost.
 */
export async function vendorGrossMargin(ownerId: string, range: { from?: Date; to?: Date } = {}): Promise<GrossMargin> {
  const items = await prisma.orderItem.findMany({
    where: { ownerId, shippedQty: { gt: 0 }, order: { status: { not: "CANCELLED" }, ...(range.from || range.to ? { placedAt: { gte: range.from, lte: range.to } } : {}) } },
    select: { shippedQty: true, unitPrice: true, variant: { select: { price: true, wholesalePrice: true } } },
  });
  const g: GrossMargin = { units: 0, unitsWithCost: 0, sales: ZERO, cost: ZERO, grossMargin: ZERO };
  for (const i of items) {
    const retail = i.unitPrice ?? i.variant.price;
    g.units += i.shippedQty;
    if (retail !== null) g.sales = g.sales.add(D(retail).mul(i.shippedQty));
    if (i.variant.wholesalePrice !== null) {
      g.cost = g.cost.add(D(i.variant.wholesalePrice).mul(i.shippedQty));
      g.unitsWithCost += i.shippedQty;
    }
  }
  g.grossMargin = g.sales.sub(g.cost);
  return g;
}

export const LEDGER_PAGE_SIZE = 50;

export async function listLedgerEntries(scope: OwnerScope, params: { ownerId?: string | null; type?: LedgerEntryType | null; account?: LedgerAccount | null; page?: number }) {
  const ownerId = scopedOwnerId(scope, params.ownerId);
  if (!ownerId) throw new FinanceServiceError("INVALID", "An owner is required.");
  const page = Math.max(1, params.page ?? 1);
  const where = { ownerId, ...(params.type ? { type: params.type } : {}), ...(params.account ? { account: params.account } : {}) };
  const [items, total] = await Promise.all([
    prisma.ledgerEntry.findMany({ where, orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }], skip: (page - 1) * LEDGER_PAGE_SIZE, take: LEDGER_PAGE_SIZE, include: { order: { select: { id: true, orderNumber: true } }, charge: { select: { id: true, chargeType: true, basis: true, ruleName: true } }, receivingItem: { select: { id: true, receivingId: true, variant: { select: { sku: true } } } } } }),
    prisma.ledgerEntry.count({ where }),
  ]);
  return { items, total, page, pageSize: LEDGER_PAGE_SIZE, pageCount: Math.max(1, Math.ceil(total / LEDGER_PAGE_SIZE)) };
}

export async function listCharges(scope: OwnerScope, params: { ownerId?: string | null; orderId?: string | null; page?: number }) {
  const ownerId = scopedOwnerId(scope, params.ownerId);
  const page = Math.max(1, params.page ?? 1);
  const where = { ...(ownerId ? { ownerId } : {}), ...(params.orderId ? { orderId: params.orderId } : {}) };
  const [items, total] = await Promise.all([
    prisma.charge.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * LEDGER_PAGE_SIZE, take: LEDGER_PAGE_SIZE, include: { order: { select: { id: true, orderNumber: true } }, owner: { select: { id: true, businessName: true, code: true } }, rule: { select: { id: true, name: true, active: true } } } }),
    prisma.charge.count({ where }),
  ]);
  return { items, total, page, pageSize: LEDGER_PAGE_SIZE, pageCount: Math.max(1, Math.ceil(total / LEDGER_PAGE_SIZE)) };
}

/** Balance for a portal / admin screen; portal users always get their own owner. */
export async function scopedOwnerBalance(scope: OwnerScope, requestedOwnerId: string | null | undefined): Promise<OwnerBalance> {
  const ownerId = scopedOwnerId(scope, requestedOwnerId);
  if (!ownerId) throw new FinanceServiceError("INVALID", "An owner is required.");
  return ownerBalance(ownerId);
}

/** Gross margin for a portal / admin screen; same scope rule. */
export async function scopedVendorGrossMargin(scope: OwnerScope, requestedOwnerId: string | null | undefined): Promise<GrossMargin> {
  const ownerId = scopedOwnerId(scope, requestedOwnerId);
  if (!ownerId) throw new FinanceServiceError("INVALID", "An owner is required.");
  return vendorGrossMargin(ownerId);
}
