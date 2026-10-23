import type { InventoryBucket, InventoryTransactionType, Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { runInventoryChangeHandlers, type InventoryChange } from "@/server/services/inventory-hooks";

/**
 * INVENTORY ENGINE — the only module allowed to write InventoryBalance,
 * InventoryLevel and InventoryTransaction (D-006).
 *
 * Model (D-043):
 *   InventoryBalance (variant × warehouse)            onHand, reserved   ← concurrency anchor
 *   InventoryLevel   (variant × warehouse × location) onHand             ← physical placement
 *   InventoryTransaction                                                  ← append-only ledger
 *   available = onHand − reserved (never stored, never negative — D-007)
 *
 * Every mutation:
 *   1. runs inside one DB transaction (caller's `tx` or a new one),
 *   2. locks the balance row with SELECT … FOR UPDATE so concurrent movements on the
 *      same SKU/warehouse serialise,
 *   3. writes the ledger row(s) and the cached figures together,
 *   4. runs registered integration hooks (inventory-hooks.ts) with the new figures.
 */

export type InventoryErrorCode =
  | "INSUFFICIENT_STOCK"
  | "INSUFFICIENT_RESERVED"
  | "VARIANT_NOT_FOUND"
  | "VARIANT_INACTIVE"
  | "WAREHOUSE_INVALID"
  | "LOCATION_INVALID"
  | "INVALID_QUANTITY"
  | "SAME_LOCATION";

export class InventoryError extends Error {
  constructor(
    public readonly code: InventoryErrorCode,
    message: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(message);
  }
}

type Db = Prisma.TransactionClient;

const TX_OPTIONS = { timeout: 30_000, maxWait: 10_000 } as const;

async function withTx<T>(tx: Db | undefined, fn: (tx: Db) => Promise<T>): Promise<T> {
  return tx ? fn(tx) : prisma.$transaction(fn, TX_OPTIONS);
}

/** External references carried on ledger rows. */
export type MovementRefs = {
  receivingId?: string | null;
  transferId?: string | null;
  orderId?: string | null;
  orderItemId?: string | null;
  shipmentId?: string | null;
  externalEventId?: string | null;
};

type Movement = {
  variantId: string;
  warehouseId: string;
  /** Required for ON_HAND rows; must be null for RESERVED rows. */
  locationId?: string | null;
  type: InventoryTransactionType;
  bucket: InventoryBucket;
  /** Signed quantity applied to the bucket. */
  quantity: number;
  reason?: string | null;
  notes?: string | null;
  refs?: MovementRefs;
};

type LockedBalance = { id: string; onHand: number; reserved: number };

// ---------------------------------------------------------------------------
// Internal primitives
// ---------------------------------------------------------------------------

async function loadVariant(tx: Db, variantId: string) {
  const variant = await tx.productVariant.findUnique({
    where: { id: variantId },
    select: { id: true, sku: true, status: true, product: { select: { id: true, ownerId: true, status: true } } },
  });
  if (!variant) throw new InventoryError("VARIANT_NOT_FOUND", "SKU not found.", { variantId });
  return variant;
}

async function assertWarehouse(tx: Db, warehouseId: string) {
  const wh = await tx.warehouse.findUnique({ where: { id: warehouseId }, select: { id: true, status: true, code: true } });
  if (!wh) throw new InventoryError("WAREHOUSE_INVALID", "Warehouse not found.", { warehouseId });
  if (wh.status !== "ACTIVE") throw new InventoryError("WAREHOUSE_INVALID", `Warehouse ${wh.code} is inactive.`, { warehouseId });
  return wh;
}

async function assertLocation(tx: Db, warehouseId: string, locationId: string) {
  const loc = await tx.location.findUnique({ where: { id: locationId }, select: { id: true, warehouseId: true, isActive: true, label: true } });
  if (!loc || loc.warehouseId !== warehouseId) {
    throw new InventoryError("LOCATION_INVALID", "Location does not belong to this warehouse.", { locationId, warehouseId });
  }
  if (!loc.isActive) throw new InventoryError("LOCATION_INVALID", `Location ${loc.label} is inactive.`, { locationId });
  return loc;
}

/** Ensure the balance row exists, then lock it for the rest of the transaction. */
async function lockBalance(tx: Db, variantId: string, warehouseId: string): Promise<LockedBalance> {
  await tx.inventoryBalance.upsert({
    where: { variantId_warehouseId: { variantId, warehouseId } },
    create: { variantId, warehouseId, onHand: 0, reserved: 0 },
    update: {},
    select: { id: true },
  });
  const rows = await tx.$queryRaw<LockedBalance[]>`
    SELECT "id", "onHand", "reserved" FROM "InventoryBalance"
    WHERE "variantId" = ${variantId} AND "warehouseId" = ${warehouseId}
    FOR UPDATE`;
  return rows[0];
}

async function getOrCreateLevel(tx: Db, variantId: string, warehouseId: string, locationId: string) {
  return tx.inventoryLevel.upsert({
    where: { variantId_warehouseId_locationId: { variantId, warehouseId, locationId } },
    create: { variantId, warehouseId, locationId, onHand: 0 },
    update: {},
    select: { id: true, onHand: true },
  });
}

/**
 * Apply a list of movements atomically. Validates every invariant, writes ledger
 * rows + cached figures, returns the resulting warehouse-level figures per SKU.
 */
async function applyMovements(tx: Db, userId: string, movements: Movement[]): Promise<InventoryChange[]> {
  const changes = new Map<string, InventoryChange>();

  for (const m of movements) {
    if (!Number.isInteger(m.quantity) || m.quantity === 0) {
      throw new InventoryError("INVALID_QUANTITY", "Quantity must be a non-zero whole number.");
    }
    const variant = await loadVariant(tx, m.variantId);
    const isInbound = m.quantity > 0;
    if (isInbound && m.bucket === "ON_HAND" && (variant.status !== "ACTIVE" || variant.product.status !== "ACTIVE")) {
      throw new InventoryError("VARIANT_INACTIVE", `SKU ${variant.sku} is archived; reactivate it before receiving stock.`, { sku: variant.sku });
    }
    await assertWarehouse(tx, m.warehouseId);
    const balance = await lockBalance(tx, m.variantId, m.warehouseId);

    let beforeQty: number;
    let afterQty: number;
    let newOnHand = balance.onHand;
    let newReserved = balance.reserved;

    if (m.bucket === "ON_HAND") {
      if (!m.locationId) throw new InventoryError("LOCATION_INVALID", "A location is required for stock movements.");
      const location = await assertLocation(tx, m.warehouseId, m.locationId);
      const level = await getOrCreateLevel(tx, m.variantId, m.warehouseId, m.locationId);
      beforeQty = level.onHand;
      afterQty = level.onHand + m.quantity;
      if (afterQty < 0) {
        throw new InventoryError(
          "INSUFFICIENT_STOCK",
          `Only ${level.onHand} of ${variant.sku} at ${location.label}; cannot remove ${-m.quantity}.`,
          { sku: variant.sku, location: location.label, onHand: level.onHand, requested: -m.quantity },
        );
      }
      newOnHand = balance.onHand + m.quantity;
      // Removing stock must never eat into reserved units (unless the same call also releases them — see ship()).
      if (newOnHand < newReserved) {
        throw new InventoryError(
          "INSUFFICIENT_STOCK",
          `${variant.sku}: ${balance.onHand - balance.reserved} available (${balance.reserved} reserved); cannot remove ${-m.quantity}.`,
          { sku: variant.sku, onHand: balance.onHand, reserved: balance.reserved, requested: -m.quantity },
        );
      }
      await tx.inventoryLevel.update({ where: { id: level.id }, data: { onHand: afterQty } });
    } else {
      if (m.locationId) throw new InventoryError("LOCATION_INVALID", "Reservation rows do not carry a location.");
      beforeQty = balance.reserved;
      afterQty = balance.reserved + m.quantity;
      if (afterQty < 0) {
        throw new InventoryError("INSUFFICIENT_RESERVED", `${variant.sku}: only ${balance.reserved} reserved; cannot release ${-m.quantity}.`, {
          sku: variant.sku,
          reserved: balance.reserved,
          requested: -m.quantity,
        });
      }
      if (afterQty > balance.onHand) {
        throw new InventoryError(
          "INSUFFICIENT_STOCK",
          `${variant.sku}: only ${balance.onHand - balance.reserved} available; cannot reserve ${m.quantity}.`,
          { sku: variant.sku, onHand: balance.onHand, reserved: balance.reserved, requested: m.quantity },
        );
      }
      newReserved = afterQty;
    }

    await tx.inventoryBalance.update({ where: { id: balance.id }, data: { onHand: newOnHand, reserved: newReserved } });

    await tx.inventoryTransaction.create({
      data: {
        variantId: m.variantId,
        ownerId: variant.product.ownerId,
        warehouseId: m.warehouseId,
        locationId: m.bucket === "ON_HAND" ? m.locationId : null,
        type: m.type,
        bucket: m.bucket,
        quantity: m.quantity,
        beforeQty,
        afterQty,
        reason: m.reason ?? null,
        notes: m.notes ?? null,
        userId,
        receivingId: m.refs?.receivingId ?? null,
        transferId: m.refs?.transferId ?? null,
        orderId: m.refs?.orderId ?? null,
        orderItemId: m.refs?.orderItemId ?? null,
        shipmentId: m.refs?.shipmentId ?? null,
        externalEventId: m.refs?.externalEventId ?? null,
      },
    });

    changes.set(`${m.variantId}:${m.warehouseId}`, {
      variantId: m.variantId,
      warehouseId: m.warehouseId,
      ownerId: variant.product.ownerId,
      onHand: newOnHand,
      reserved: newReserved,
      available: newOnHand - newReserved,
    });
  }

  const result = [...changes.values()];
  await runInventoryChangeHandlers(tx, result);
  return result;
}

// ---------------------------------------------------------------------------
// Public operations
// ---------------------------------------------------------------------------

export type ReceiveLine = { variantId: string; locationId: string; quantity: number };

/** Book received goods into stock (spec §16). Called by the receiving service. */
export async function receiveStock(
  input: { userId: string; warehouseId: string; receivingId: string; reference?: string | null; lines: ReceiveLine[] },
  tx?: Db,
) {
  return withTx(tx, (t) =>
    applyMovements(
      t,
      input.userId,
      input.lines.map((l) => ({
        variantId: l.variantId,
        warehouseId: input.warehouseId,
        locationId: l.locationId,
        type: "RECEIVE" as const,
        bucket: "ON_HAND" as const,
        quantity: Math.abs(l.quantity),
        reason: input.reference ? `Receiving ${input.reference}` : "Receiving",
        refs: { receivingId: input.receivingId },
      })),
    ),
  );
}

export type AdjustKind = "ADJUSTMENT_IN" | "ADJUSTMENT_OUT" | "DAMAGE" | "MISSING";

/** Audited manual correction (spec §19–20). Reason is mandatory; before/after are recorded. */
export async function adjustStock(
  input: { userId: string; variantId: string; warehouseId: string; locationId: string; kind: AdjustKind; quantity: number; reason: string; notes?: string | null; refs?: MovementRefs },
  tx?: Db,
) {
  const qty = Math.abs(input.quantity);
  const type: InventoryTransactionType = input.kind === "DAMAGE" ? "DAMAGE" : input.kind === "MISSING" ? "MISSING" : "ADJUSTMENT";
  const signed = input.kind === "ADJUSTMENT_IN" ? qty : -qty;
  return withTx(tx, (t) =>
    applyMovements(t, input.userId, [
      { variantId: input.variantId, warehouseId: input.warehouseId, locationId: input.locationId, type, bucket: "ON_HAND", quantity: signed, reason: input.reason, notes: input.notes, refs: input.refs },
    ]),
  );
}

/** Move stock between two locations of the same warehouse. Warehouse totals are unchanged. */
export async function moveStock(
  input: { userId: string; variantId: string; warehouseId: string; fromLocationId: string; toLocationId: string; quantity: number; notes?: string | null },
  tx?: Db,
) {
  if (input.fromLocationId === input.toLocationId) throw new InventoryError("SAME_LOCATION", "Source and destination are the same location.");
  const qty = Math.abs(input.quantity);
  return withTx(tx, (t) =>
    applyMovements(t, input.userId, [
      { variantId: input.variantId, warehouseId: input.warehouseId, locationId: input.fromLocationId, type: "MOVE", bucket: "ON_HAND", quantity: -qty, reason: "Location move", notes: input.notes },
      { variantId: input.variantId, warehouseId: input.warehouseId, locationId: input.toLocationId, type: "MOVE", bucket: "ON_HAND", quantity: qty, reason: "Location move", notes: input.notes },
    ]),
  );
}

/** Reserve stock for an order line (spec §17). Fails with INSUFFICIENT_STOCK if available < qty. */
export async function reserveStock(
  input: { userId: string; variantId: string; warehouseId: string; quantity: number; reason?: string | null; refs?: MovementRefs },
  tx?: Db,
) {
  return withTx(tx, (t) =>
    applyMovements(t, input.userId, [
      { variantId: input.variantId, warehouseId: input.warehouseId, type: "RESERVE", bucket: "RESERVED", quantity: Math.abs(input.quantity), reason: input.reason ?? "Order reservation", refs: input.refs },
    ]),
  );
}

/** Release a reservation (cancellation, quantity reduction). */
export async function releaseStock(
  input: { userId: string; variantId: string; warehouseId: string; quantity: number; reason?: string | null; refs?: MovementRefs },
  tx?: Db,
) {
  return withTx(tx, (t) =>
    applyMovements(t, input.userId, [
      { variantId: input.variantId, warehouseId: input.warehouseId, type: "RELEASE", bucket: "RESERVED", quantity: -Math.abs(input.quantity), reason: input.reason ?? "Reservation released", refs: input.refs },
    ]),
  );
}

/**
 * Ship stock out (spec §32/§41). `reservedQuantity` of the total was backed by a
 * reservation and is consumed; the remainder ships from unreserved available stock
 * (needed for fulfilments created directly in Shopify, D-032).
 */
export async function shipStock(
  input: { userId: string; variantId: string; warehouseId: string; locationId: string; quantity: number; reservedQuantity: number; refs?: MovementRefs; notes?: string | null },
  tx?: Db,
) {
  const qty = Math.abs(input.quantity);
  const reservedPart = Math.min(Math.max(0, input.reservedQuantity), qty);
  return withTx(tx, async (t) => {
    const movements: Movement[] = [];
    // Release the reservation first so the on-hand removal below does not trip the reserved ≤ onHand guard.
    if (reservedPart > 0) {
      movements.push({ variantId: input.variantId, warehouseId: input.warehouseId, type: "SHIP", bucket: "RESERVED", quantity: -reservedPart, reason: "Shipped", refs: input.refs, notes: input.notes });
    }
    movements.push({ variantId: input.variantId, warehouseId: input.warehouseId, locationId: input.locationId, type: "SHIP", bucket: "ON_HAND", quantity: -qty, reason: "Shipped", refs: input.refs, notes: input.notes });
    return applyMovements(t, input.userId, movements);
  });
}

/** Sellable return back into stock (spec §15). Damaged returns are recorded with adjustStock(DAMAGE) after inspection. */
export async function returnStock(
  input: { userId: string; variantId: string; warehouseId: string; locationId: string; quantity: number; reason?: string | null; notes?: string | null; refs?: MovementRefs },
  tx?: Db,
) {
  return withTx(tx, (t) =>
    applyMovements(t, input.userId, [
      { variantId: input.variantId, warehouseId: input.warehouseId, locationId: input.locationId, type: "RETURN", bucket: "ON_HAND", quantity: Math.abs(input.quantity), reason: input.reason ?? "Customer return", notes: input.notes, refs: input.refs },
    ]),
  );
}

/** Transfer leg 1: stock leaves the source warehouse (in transit). Requires available ≥ qty. */
export async function transferOut(
  input: { userId: string; transferId: string; warehouseId: string; lines: { variantId: string; locationId: string; quantity: number }[]; reason?: string | null },
  tx?: Db,
) {
  return withTx(tx, (t) =>
    applyMovements(
      t,
      input.userId,
      input.lines.map((l) => ({
        variantId: l.variantId,
        warehouseId: input.warehouseId,
        locationId: l.locationId,
        type: "TRANSFER_OUT" as const,
        bucket: "ON_HAND" as const,
        quantity: -Math.abs(l.quantity),
        reason: input.reason ?? "Transfer out",
        refs: { transferId: input.transferId },
      })),
    ),
  );
}

/** Transfer leg 2: stock arrives at the destination (or returns to the source on cancellation). */
export async function transferIn(
  input: { userId: string; transferId: string; warehouseId: string; lines: { variantId: string; locationId: string; quantity: number }[]; reason?: string | null },
  tx?: Db,
) {
  return withTx(tx, (t) =>
    applyMovements(
      t,
      input.userId,
      input.lines.map((l) => ({
        variantId: l.variantId,
        warehouseId: input.warehouseId,
        locationId: l.locationId,
        type: "TRANSFER_IN" as const,
        bucket: "ON_HAND" as const,
        quantity: Math.abs(l.quantity),
        reason: input.reason ?? "Transfer in",
        refs: { transferId: input.transferId },
      })),
    ),
  );
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Contract for the Shopify publisher (shopify-integration.md §6): available per variant across the given warehouses. */
export async function availableForVariants(variantIds: string[], warehouseIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>(variantIds.map((id) => [id, 0]));
  if (variantIds.length === 0 || warehouseIds.length === 0) return out;
  const rows = await prisma.inventoryBalance.groupBy({
    by: ["variantId"],
    where: { variantId: { in: variantIds }, warehouseId: { in: warehouseIds } },
    _sum: { onHand: true, reserved: true },
  });
  for (const r of rows) out.set(r.variantId, (r._sum.onHand ?? 0) - (r._sum.reserved ?? 0));
  return out;
}

/** Stock of one SKU: per warehouse (onHand/reserved/available) with per-location breakdown. */
export async function stockForVariant(variantId: string) {
  const [balances, levels] = await Promise.all([
    prisma.inventoryBalance.findMany({ where: { variantId }, include: { warehouse: { select: { id: true, code: true, name: true } } }, orderBy: { warehouse: { code: "asc" } } }),
    prisma.inventoryLevel.findMany({ where: { variantId, onHand: { not: 0 } }, include: { location: { select: { id: true, label: true } } } }),
  ]);
  return balances.map((b) => ({
    warehouse: b.warehouse,
    onHand: b.onHand,
    reserved: b.reserved,
    available: b.onHand - b.reserved,
    locations: levels.filter((l) => l.warehouseId === b.warehouseId).map((l) => ({ id: l.location.id, label: l.location.label, onHand: l.onHand })),
  }));
}

export const INVENTORY_PAGE_SIZE = 50;

export type StockListParams = { q?: string; ownerId?: string; warehouseId?: string; lowStock?: boolean; page?: number };

/** Inventory overview: one row per SKU × warehouse with stock. */
export async function listStock(params: StockListParams) {
  const page = Math.max(1, params.page ?? 1);
  const where: Prisma.InventoryBalanceWhereInput = {
    ...(params.warehouseId ? { warehouseId: params.warehouseId } : {}),
    variant: {
      ...(params.ownerId ? { product: { ownerId: params.ownerId } } : {}),
      ...(params.q
        ? {
            OR: [
              { sku: { contains: params.q, mode: "insensitive" } },
              { name: { contains: params.q, mode: "insensitive" } },
              { product: { name: { contains: params.q, mode: "insensitive" } } },
            ],
          }
        : {}),
    },
    ...(params.lowStock ? { onHand: { lte: 5 } } : {}),
  };
  const [total, items] = await prisma.$transaction([
    prisma.inventoryBalance.count({ where }),
    prisma.inventoryBalance.findMany({
      where,
      orderBy: [{ variant: { sku: "asc" } }, { warehouse: { code: "asc" } }],
      skip: (page - 1) * INVENTORY_PAGE_SIZE,
      take: INVENTORY_PAGE_SIZE,
      select: {
        id: true,
        onHand: true,
        reserved: true,
        updatedAt: true,
        warehouse: { select: { id: true, code: true, name: true } },
        variant: { select: { id: true, sku: true, name: true, product: { select: { id: true, name: true, owner: { select: { id: true, code: true, businessName: true, type: true } } } } } },
      },
    }),
  ]);
  return { items, total, page, pageSize: INVENTORY_PAGE_SIZE, pageCount: Math.max(1, Math.ceil(total / INVENTORY_PAGE_SIZE)) };
}

/** Balances for a set of variants (product detail page): variantId → per-warehouse figures. */
export async function stockForVariants(variantIds: string[]) {
  if (variantIds.length === 0) return new Map<string, { warehouseId: string; code: string; onHand: number; reserved: number; available: number }[]>();
  const rows = await prisma.inventoryBalance.findMany({
    where: { variantId: { in: variantIds } },
    select: { variantId: true, onHand: true, reserved: true, warehouse: { select: { id: true, code: true } } },
    orderBy: { warehouse: { code: "asc" } },
  });
  const out = new Map<string, { warehouseId: string; code: string; onHand: number; reserved: number; available: number }[]>();
  for (const r of rows) {
    const list = out.get(r.variantId) ?? [];
    list.push({ warehouseId: r.warehouse.id, code: r.warehouse.code, onHand: r.onHand, reserved: r.reserved, available: r.onHand - r.reserved });
    out.set(r.variantId, list);
  }
  return out;
}

/** Warehouse card figures: distinct SKUs stocked, units on hand / reserved. */
export async function warehouseStockSummary(warehouseId: string) {
  const [agg, skus] = await Promise.all([
    prisma.inventoryBalance.aggregate({ where: { warehouseId }, _sum: { onHand: true, reserved: true } }),
    prisma.inventoryBalance.count({ where: { warehouseId, onHand: { gt: 0 } } }),
  ]);
  const onHand = agg._sum.onHand ?? 0;
  const reserved = agg._sum.reserved ?? 0;
  return { skus, onHand, reserved, available: onHand - reserved };
}

export type MovementListParams = { q?: string; ownerId?: string; warehouseId?: string; variantId?: string; productId?: string; type?: InventoryTransactionType; page?: number; pageSize?: number };

/** Ledger browser (admin: all; portals: filtered by ownerId from the session). */
export async function listMovements(params: MovementListParams) {
  const page = Math.max(1, params.page ?? 1);
  const pageSize = params.pageSize ?? INVENTORY_PAGE_SIZE;
  const where: Prisma.InventoryTransactionWhereInput = {
    ...(params.ownerId ? { ownerId: params.ownerId } : {}),
    ...(params.warehouseId ? { warehouseId: params.warehouseId } : {}),
    ...(params.variantId ? { variantId: params.variantId } : {}),
    ...(params.productId ? { variant: { productId: params.productId } } : {}),
    ...(params.type ? { type: params.type } : {}),
    ...(params.q ? { variant: { OR: [{ sku: { contains: params.q, mode: "insensitive" } }, { product: { name: { contains: params.q, mode: "insensitive" } } }] } } : {}),
  };
  const [total, items] = await prisma.$transaction([
    prisma.inventoryTransaction.count({ where }),
    prisma.inventoryTransaction.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        type: true,
        bucket: true,
        quantity: true,
        beforeQty: true,
        afterQty: true,
        reason: true,
        notes: true,
        createdAt: true,
        receivingId: true,
        transferId: true,
        orderId: true,
        externalEventId: true,
        variant: { select: { id: true, sku: true, name: true, product: { select: { id: true, name: true } } } },
        owner: { select: { id: true, code: true, businessName: true } },
        warehouse: { select: { id: true, code: true } },
        location: { select: { id: true, label: true } },
        user: { select: { id: true, name: true } },
      },
    }),
  ]);
  return { items, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

/** Totals for dashboards (optionally scoped to one owner). */
export async function stockTotals(ownerId?: string) {
  const agg = await prisma.inventoryBalance.aggregate({
    where: ownerId ? { variant: { product: { ownerId } } } : undefined,
    _sum: { onHand: true, reserved: true },
  });
  const onHand = agg._sum.onHand ?? 0;
  const reserved = agg._sum.reserved ?? 0;
  const lowStock = await prisma.inventoryBalance.count({ where: { ...(ownerId ? { variant: { product: { ownerId } } } : {}), onHand: { lte: 5 } } });
  return { onHand, reserved, available: onHand - reserved, lowStock };
}

/** Consistency check used by tests/ops: balance.onHand must equal Σ level.onHand and the ledger must sum to the balances. */
export async function verifyLedgerConsistency(variantId: string, warehouseId: string) {
  const [balance, levelSum, ledger] = await Promise.all([
    prisma.inventoryBalance.findUnique({ where: { variantId_warehouseId: { variantId, warehouseId } } }),
    prisma.inventoryLevel.aggregate({ where: { variantId, warehouseId }, _sum: { onHand: true } }),
    prisma.inventoryTransaction.groupBy({ by: ["bucket"], where: { variantId, warehouseId }, _sum: { quantity: true } }),
  ]);
  const ledgerOnHand = ledger.find((r) => r.bucket === "ON_HAND")?._sum.quantity ?? 0;
  const ledgerReserved = ledger.find((r) => r.bucket === "RESERVED")?._sum.quantity ?? 0;
  return {
    onHand: balance?.onHand ?? 0,
    reserved: balance?.reserved ?? 0,
    levelSum: levelSum._sum.onHand ?? 0,
    ledgerOnHand,
    ledgerReserved,
    consistent: (balance?.onHand ?? 0) === (levelSum._sum.onHand ?? 0) && (balance?.onHand ?? 0) === ledgerOnHand && (balance?.reserved ?? 0) === ledgerReserved,
  };
}
