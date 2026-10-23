import { Prisma, type Customer, type CustomerSource } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { customerFormSchema, normalizePhone, type CustomerFormValues } from "@/lib/validation/customers";
import { recordAudit } from "@/server/services/audit";

/**
 * Customer directory (D-060) — operational records, no logins, no CRM.
 *
 * Scope: `ownerId` NULL = V3PL company customer (admin manual orders); otherwise the vendor / 3PL
 * client the customer belongs to. Callers pass a *scope* derived from the session, never from the
 * request: staff → `{ ownerId: undefined }` (everything, optionally filtered), portal users →
 * `{ ownerId: user.ownerId }`. Every read and write is filtered by that scope.
 *
 * Orders keep their own customer/ship-to snapshot; the directory link (`Order.customerId`) is
 * informational and editing a customer never rewrites past orders.
 */

export type { CustomerScope } from "@/lib/customer-scope";
import type { CustomerScope } from "@/lib/customer-scope";

export type CustomerErrorCode = "NOT_FOUND" | "OWNER_INVALID" | "FORBIDDEN";

export class CustomerServiceError extends Error {
  constructor(
    public readonly code: CustomerErrorCode,
    message: string,
    public readonly field?: string,
  ) {
    super(message);
  }
}

export const CUSTOMER_PAGE_SIZE = 25;

const scopeWhere = (scope: CustomerScope): Prisma.CustomerWhereInput => (scope.ownerId ? { ownerId: scope.ownerId } : {});

export type CustomerListParams = { q?: string; ownerId?: string; page?: number; pageSize?: number };

/** Search by name, e-mail or phone (digits compared without punctuation). */
export function customerSearchWhere(q: string | undefined): Prisma.CustomerWhereInput {
  const term = (q ?? "").trim();
  if (!term) return {};
  const digits = term.replace(/\D+/g, "");
  return {
    OR: [
      { name: { contains: term, mode: "insensitive" } },
      { email: { contains: term.toLowerCase() } },
      { phone: { contains: term } },
      ...(digits.length >= 3 ? [{ phoneNormalized: { contains: digits } }] : []),
      { shipCompany: { contains: term, mode: "insensitive" } },
    ],
  };
}

export async function listCustomers(scope: CustomerScope, params: CustomerListParams) {
  const page = Math.max(1, params.page ?? 1);
  const pageSize = params.pageSize ?? CUSTOMER_PAGE_SIZE;
  const where: Prisma.CustomerWhereInput = {
    AND: [scopeWhere(scope), params.ownerId && !scope.ownerId ? (params.ownerId === "company" ? { ownerId: null } : { ownerId: params.ownerId }) : {}, customerSearchWhere(params.q)],
  };
  const [total, items] = await prisma.$transaction([
    prisma.customer.count({ where }),
    prisma.customer.findMany({
      where,
      orderBy: [{ name: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: { id: true, name: true, email: true, phone: true, shipCity: true, shipCountry: true, source: true, updatedAt: true, owner: { select: { id: true, code: true, businessName: true } }, _count: { select: { orders: true } } },
    }),
  ]);
  return { items, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

/** Picker search: compact rows for the order form. */
export async function searchCustomers(scope: CustomerScope, q: string, limit = 10) {
  if (!q.trim()) return [];
  return prisma.customer.findMany({
    where: { AND: [scopeWhere(scope), customerSearchWhere(q)] },
    orderBy: [{ name: "asc" }],
    take: limit,
    select: { id: true, name: true, email: true, phone: true, shipName: true, shipCompany: true, shipAddress1: true, shipAddress2: true, shipCity: true, shipProvince: true, shipZip: true, shipCountry: true, shipPhone: true, owner: { select: { code: true, businessName: true } } },
  });
}

/** Full customer with its recent orders (orders are scoped to the caller's lines where relevant by the page). */
export async function getCustomer(scope: CustomerScope, id: string) {
  return prisma.customer.findFirst({
    where: { id, ...scopeWhere(scope) },
    include: {
      owner: { select: { id: true, code: true, businessName: true, type: true } },
      orders: {
        orderBy: { placedAt: "desc" },
        take: 25,
        select: { id: true, orderNumber: true, status: true, fulfillmentStatus: true, placedAt: true, source: true, items: { select: { shippedQty: true, returnedQty: true, ownerId: true } } },
      },
    },
  });
}

function customerData(values: CustomerFormValues) {
  return {
    name: values.name,
    email: values.email ?? null,
    phone: values.phone ?? null,
    phoneNormalized: normalizePhone(values.phone),
    shipName: values.shipName ?? null,
    shipCompany: values.shipCompany ?? null,
    shipAddress1: values.shipAddress1 ?? null,
    shipAddress2: values.shipAddress2 ?? null,
    shipCity: values.shipCity ?? null,
    shipProvince: values.shipProvince ?? null,
    shipZip: values.shipZip ?? null,
    shipCountry: values.shipCountry ?? null,
    shipPhone: values.shipPhone ?? null,
    billName: values.billName ?? null,
    billCompany: values.billCompany ?? null,
    billAddress1: values.billAddress1 ?? null,
    billAddress2: values.billAddress2 ?? null,
    billCity: values.billCity ?? null,
    billProvince: values.billProvince ?? null,
    billZip: values.billZip ?? null,
    billCountry: values.billCountry ?? null,
    notes: values.notes ?? null,
  };
}

/**
 * Resolve the owner a new customer belongs to. Portal scope forces the session owner; staff may pick an
 * active owner or leave it empty (company customer).
 */
async function resolveOwnerId(scope: CustomerScope, requested: string | null | undefined): Promise<string | null> {
  if (scope.ownerId) return scope.ownerId;
  if (!requested) return null;
  const owner = await prisma.owner.findUnique({ where: { id: requested }, select: { id: true, status: true } });
  if (!owner) throw new CustomerServiceError("OWNER_INVALID", "The selected vendor / 3PL client does not exist.", "ownerId");
  if (owner.status !== "ACTIVE") throw new CustomerServiceError("OWNER_INVALID", "Cannot add customers to an inactive vendor / 3PL client.", "ownerId");
  return owner.id;
}

export async function createCustomer(scope: CustomerScope, values: CustomerFormValues, actorId: string | null, source: CustomerSource = "MANUAL") {
  const ownerId = await resolveOwnerId(scope, values.ownerId);
  return prisma.$transaction(async (tx) => {
    const customer = await tx.customer.create({ data: { ...customerData(values), ownerId, source } });
    await recordAudit({ userId: actorId, action: "customer.created", entityType: "Customer", entityId: customer.id, newValues: { ownerId, name: values.name, email: values.email ?? null, source } }, tx);
    return customer;
  });
}

/** Editing a customer never touches its orders' snapshots (they are history). */
export async function updateCustomer(scope: CustomerScope, id: string, values: CustomerFormValues, actorId: string | null) {
  const current = await prisma.customer.findFirst({ where: { id, ...scopeWhere(scope) } });
  if (!current) throw new CustomerServiceError("NOT_FOUND", "Customer not found.");
  // Owner can only be changed by staff, and only while the customer has no orders (orders carry owner lines).
  let ownerId = current.ownerId;
  if (!scope.ownerId && values.ownerId !== undefined && (values.ownerId ?? null) !== current.ownerId) {
    const orders = await prisma.order.count({ where: { customerId: id } });
    if (orders > 0) throw new CustomerServiceError("OWNER_INVALID", "This customer already has orders; its owner cannot be changed.", "ownerId");
    ownerId = await resolveOwnerId(scope, values.ownerId);
  }
  return prisma.$transaction(async (tx) => {
    const customer = await tx.customer.update({ where: { id }, data: { ...customerData(values), ownerId } });
    await recordAudit({ userId: actorId, action: "customer.updated", entityType: "Customer", entityId: id, oldValues: { name: current.name, email: current.email, phone: current.phone, ownerId: current.ownerId }, newValues: { name: values.name, email: values.email ?? null, phone: values.phone ?? null, ownerId } }, tx);
    return customer;
  });
}

// --- Duplicates -------------------------------------------------------------

export type DuplicateMatch = { id: string; name: string; email: string | null; phone: string | null; matchedBy: ("email" | "phone" | "name")[] };

/**
 * Likely duplicates inside ONE owner scope (company customers and each owner are separate pools):
 * same e-mail, same phone digits, or same name (case-insensitive). E-mail and phone are not unique
 * platform-wide on purpose — the same person can be a customer of two vendors.
 */
export async function findDuplicateCustomers(ownerId: string | null, probe: { email?: string | null; phone?: string | null; name?: string | null }, excludeId?: string): Promise<DuplicateMatch[]> {
  const email = probe.email?.trim().toLowerCase() || null;
  const phoneNormalized = normalizePhone(probe.phone);
  const name = probe.name?.trim() || null;
  const or: Prisma.CustomerWhereInput[] = [];
  if (email) or.push({ email });
  if (phoneNormalized) or.push({ phoneNormalized });
  if (name) or.push({ name: { equals: name, mode: "insensitive" } });
  if (or.length === 0) return [];
  const rows = await prisma.customer.findMany({ where: { ownerId, OR: or, ...(excludeId ? { id: { not: excludeId } } : {}) }, take: 10, select: { id: true, name: true, email: true, phone: true, phoneNormalized: true } });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    phone: r.phone,
    matchedBy: [...(email && r.email === email ? (["email"] as const) : []), ...(phoneNormalized && r.phoneNormalized === phoneNormalized ? (["phone"] as const) : []), ...(name && r.name.toLowerCase() === name.toLowerCase() ? (["name"] as const) : [])],
  }));
}

// --- Orders -----------------------------------------------------------------

export type OrderShipTo = {
  customerName?: string | null;
  customerEmail?: string | null;
  customerPhone?: string | null;
  shipName?: string | null;
  shipCompany?: string | null;
  shipAddress1?: string | null;
  shipAddress2?: string | null;
  shipCity?: string | null;
  shipProvince?: string | null;
  shipZip?: string | null;
  shipCountry?: string | null;
  shipPhone?: string | null;
};

/** Snapshot copied INTO an order when a customer is picked (the order keeps its own copy afterwards). */
export function customerSnapshot(c: Pick<Customer, "name" | "email" | "phone" | "shipName" | "shipCompany" | "shipAddress1" | "shipAddress2" | "shipCity" | "shipProvince" | "shipZip" | "shipCountry" | "shipPhone">): OrderShipTo {
  return {
    customerName: c.name,
    customerEmail: c.email,
    customerPhone: c.phone,
    shipName: c.shipName ?? c.name,
    shipCompany: c.shipCompany,
    shipAddress1: c.shipAddress1,
    shipAddress2: c.shipAddress2,
    shipCity: c.shipCity,
    shipProvince: c.shipProvince,
    shipZip: c.shipZip,
    shipCountry: c.shipCountry,
    shipPhone: c.shipPhone,
  };
}

export type OrderCustomerResolution = { customerId: string | null; created: boolean; reused: boolean; customerName: string | null };

/**
 * Decide which directory record (if any) a new order links to:
 * - `customerId` given → must exist inside the caller's scope (portal: own owner; staff: any) or the order is refused;
 * - else `saveCustomer` → an exact e-mail or phone match in the same owner pool is *reused* (no silent duplicate),
 *   otherwise a new customer is created from the order's ship-to data (source ORDER / THREEPL_PORTAL);
 * - else no link. The order snapshot is always what the form submitted; it is never overwritten from the directory here.
 */
export async function resolveOrderCustomer(scope: CustomerScope, input: { customerId?: string | null; saveCustomer?: boolean; shipTo: OrderShipTo; ownerIdForNew: string | null; source: CustomerSource }, actorId: string | null): Promise<OrderCustomerResolution> {
  if (input.customerId) {
    const c = await prisma.customer.findFirst({ where: { id: input.customerId, ...scopeWhere(scope) }, select: { id: true, name: true } });
    if (!c) throw new CustomerServiceError("FORBIDDEN", "That customer is not available to you.", "customerId");
    return { customerId: c.id, created: false, reused: false, customerName: c.name };
  }
  if (!input.saveCustomer) return { customerId: null, created: false, reused: false, customerName: null };
  const name = input.shipTo.customerName?.trim() || input.shipTo.shipName?.trim() || null;
  if (!name) throw new CustomerServiceError("NOT_FOUND", "Enter a customer or recipient name to save the customer.", "customerName");
  const dupes = (await findDuplicateCustomers(input.ownerIdForNew, { email: input.shipTo.customerEmail, phone: input.shipTo.customerPhone ?? input.shipTo.shipPhone })).filter((d) => d.matchedBy.includes("email") || d.matchedBy.includes("phone"));
  if (dupes.length > 0) return { customerId: dupes[0].id, created: false, reused: true, customerName: dupes[0].name };
  // Normalise through the same schema as the customer form (lower-cased e-mail, trimmed fields).
  const values = customerFormSchema.parse({
    ownerId: input.ownerIdForNew,
    name,
    email: input.shipTo.customerEmail ?? "",
    phone: input.shipTo.customerPhone ?? input.shipTo.shipPhone ?? "",
    shipName: input.shipTo.shipName ?? "",
    shipCompany: input.shipTo.shipCompany ?? "",
    shipAddress1: input.shipTo.shipAddress1 ?? "",
    shipAddress2: input.shipTo.shipAddress2 ?? "",
    shipCity: input.shipTo.shipCity ?? "",
    shipProvince: input.shipTo.shipProvince ?? "",
    shipZip: input.shipTo.shipZip ?? "",
    shipCountry: input.shipTo.shipCountry ?? "",
    shipPhone: input.shipTo.shipPhone ?? "",
  });
  const created = await createCustomer({ ownerId: input.ownerIdForNew ?? undefined }, values, actorId, input.source);
  return { customerId: created.id, created: true, reused: false, customerName: created.name };
}

export async function customerCounters(scope: CustomerScope) {
  return prisma.customer.count({ where: scopeWhere(scope) });
}

// --- Shopify sync (D-065) -----------------------------------------------------

/** Fields the Shopify customer sync may set (data minimisation: identity, contact, default address only). */
export type ShopifyCustomerValues = {
  name: string;
  email?: string | null;
  phone?: string | null;
  ship?: Partial<Pick<Customer, "shipName" | "shipCompany" | "shipAddress1" | "shipAddress2" | "shipCity" | "shipProvince" | "shipZip" | "shipCountry" | "shipPhone">> | null;
};
export type ShopifyCustomerRef = { storeId: string; shopifyCustomerId: string };
export type ShopifyCustomerUpsertResult = { id: string; action: "created" | "updated" | "linked" | "unchanged" };

const clean = (v: string | null | undefined): string | null => {
  const t = (v ?? "").trim();
  return t ? t : null;
};

/**
 * Upsert contract for the Shopify customer sync (Shopify session calls this; it never writes `Customer` itself).
 * Identity is the (store, Shopify customer id) pair, never the e-mail:
 * - mapped → update; Shopify values only overwrite when non-empty, so V3PL-only data (notes, billing address,
 *   owner, source, a phone Shopify does not know) is never blanked;
 * - not mapped → an unmapped V3PL **company** customer (ownerId NULL) with the same e-mail is *linked* once
 *   instead of duplicated (the Shopify store belongs to the company; portal owners' pools are never touched);
 * - otherwise a company customer is created with source SHOPIFY.
 * Idempotent: the same input twice yields `unchanged`; a concurrent create loses the unique race and updates.
 */
export async function upsertShopifyCustomer(ref: ShopifyCustomerRef, values: ShopifyCustomerValues, actorId: string | null): Promise<ShopifyCustomerUpsertResult> {
  const incoming = {
    name: clean(values.name),
    email: clean(values.email)?.toLowerCase() ?? null,
    phone: clean(values.phone),
    shipName: clean(values.ship?.shipName),
    shipCompany: clean(values.ship?.shipCompany),
    shipAddress1: clean(values.ship?.shipAddress1),
    shipAddress2: clean(values.ship?.shipAddress2),
    shipCity: clean(values.ship?.shipCity),
    shipProvince: clean(values.ship?.shipProvince),
    shipZip: clean(values.ship?.shipZip),
    shipCountry: clean(values.ship?.shipCountry),
    shipPhone: clean(values.ship?.shipPhone),
  };
  const pair = { shopifyStoreId: ref.storeId, shopifyCustomerId: ref.shopifyCustomerId };

  const merge = (current: Customer): Prisma.CustomerUpdateInput => {
    const data: Prisma.CustomerUpdateInput = {};
    for (const key of Object.keys(incoming) as (keyof typeof incoming)[]) {
      const next = incoming[key];
      if (next !== null && next !== current[key]) (data as Record<string, unknown>)[key] = next;
    }
    if (data.phone !== undefined) data.phoneNormalized = normalizePhone(incoming.phone);
    return data;
  };
  const apply = async (current: Customer, link: boolean): Promise<ShopifyCustomerUpsertResult> => {
    const data = merge(current);
    if (link) Object.assign(data, pair);
    if (Object.keys(data).length === 0) return { id: current.id, action: "unchanged" };
    await prisma.$transaction(async (tx) => {
      await tx.customer.update({ where: { id: current.id }, data });
      await recordAudit({ userId: actorId, action: link ? "customer.shopify_linked" : "customer.updated", entityType: "Customer", entityId: current.id, oldValues: { name: current.name, email: current.email, phone: current.phone }, newValues: { ...Object.fromEntries(Object.entries(data).filter(([k]) => k !== "phoneNormalized")), source: "SHOPIFY" } }, tx);
    });
    return { id: current.id, action: link ? "linked" : "updated" };
  };

  const mapped = await prisma.customer.findUnique({ where: { shopifyStoreId_shopifyCustomerId: pair } });
  if (mapped) return apply(mapped, false);

  if (incoming.email) {
    const adoptable = await prisma.customer.findFirst({ where: { ownerId: null, shopifyCustomerId: null, email: incoming.email }, orderBy: { createdAt: "asc" } });
    if (adoptable) return apply(adoptable, true);
  }

  const name = incoming.name ?? incoming.email ?? `Shopify customer ${ref.shopifyCustomerId}`;
  try {
    return await prisma.$transaction(async (tx) => {
      const customer = await tx.customer.create({ data: { ...incoming, name, phoneNormalized: normalizePhone(incoming.phone), ownerId: null, source: "SHOPIFY", ...pair } });
      await recordAudit({ userId: actorId, action: "customer.created", entityType: "Customer", entityId: customer.id, newValues: { ownerId: null, name, email: incoming.email, source: "SHOPIFY", ...pair } }, tx);
      return { id: customer.id, action: "created" as const };
    });
  } catch (err) {
    // Unique (store, Shopify id) race with a concurrent sync / webhook: the other writer won — update instead.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const winner = await prisma.customer.findUnique({ where: { shopifyStoreId_shopifyCustomerId: pair } });
      if (winner) return apply(winner, false);
    }
    throw err;
  }
}
