import { prisma } from "@/lib/prisma";
import { upsertShopifyCustomer, type ShopifyCustomerUpsertResult, type ShopifyCustomerValues } from "@/server/services/customers";
import { storeGraphql } from "./api";
import { gidToId, toGid } from "./client";
import { CUSTOMERS_QUERY, ORDER_CUSTOMER_QUERY, type CustomerNode, type CustomersPage, type OrderCustomerPayload } from "./queries";
import { describeError, logSync } from "./sync-log";

/**
 * Shopify customers → V3PL customer directory (D-065). One-way enrichment: the directory stays the operational
 * record, Shopify never deletes or blanks anything here. Identity = (store, numeric Shopify customer id), the
 * unique pair reserved by D-060; the merge rules live in core (`upsertShopifyCustomer`).
 *
 * Admin action, not a job: like the catalog sync it pages through `customers` inside a time budget. The first
 * run reads everything; later runs only read customers Shopify updated since the last complete run (with an
 * overlap), so re-running is cheap and idempotent. A record that fails is logged and skipped; the page goes on.
 */

export const CUSTOMER_SYNC_SCOPE = "read_customers";
const PAGE_SIZE = 100;
/** Incremental runs re-read this much history before the last checkpoint to cover clock skew / in-flight edits. */
const OVERLAP_MS = 10 * 60 * 1000;

export class CustomerSyncError extends Error {
  constructor(
    public readonly code: "NOT_FOUND" | "NOT_CONNECTED" | "MISSING_SCOPE",
    message: string,
  ) {
    super(message);
  }
}

export function hasReadCustomers(grantedScopes: string | null | undefined): boolean {
  const set = new Set((grantedScopes ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  return set.has(CUSTOMER_SYNC_SCOPE) || set.has("write_customers");
}

/** Pure mapping from the 2026-07 Customer node to the directory fields we keep (nothing else is read). */
export function customerValuesFromNode(node: CustomerNode): ShopifyCustomerValues {
  const a = node.defaultAddress;
  const fromParts = [node.firstName, node.lastName].filter((s) => s && s.trim()).join(" ").trim();
  const addressName = a ? (a.name?.trim() || [a.firstName, a.lastName].filter((s) => s && s.trim()).join(" ").trim()) : "";
  const email = node.defaultEmailAddress?.emailAddress ?? null;
  const name = node.displayName?.trim() || fromParts || addressName || email || `Shopify customer ${gidToId(node.id)}`;
  return {
    name,
    email,
    phone: node.defaultPhoneNumber?.phoneNumber ?? a?.phone ?? null,
    ship: a
      ? {
          shipName: addressName || null,
          shipCompany: a.company ?? null,
          shipAddress1: a.address1 ?? null,
          shipAddress2: a.address2 ?? null,
          shipCity: a.city ?? null,
          shipProvince: a.provinceCode ?? a.province ?? null,
          shipZip: a.zip ?? null,
          shipCountry: a.countryCodeV2 ?? a.country ?? null,
          shipPhone: a.phone ?? null,
        }
      : null,
  };
}

export type CustomerSyncResult = {
  seen: number;
  created: number;
  updated: number;
  linked: number;
  unchanged: number;
  failed: number;
  pages: number;
  /** false = the time budget ran out before the last page; nothing is lost, run again to continue. */
  full: boolean;
  /** ISO cut-off used for this run (undefined = first / full run). */
  since?: string;
  durationMs: number;
  message: string;
};

export function customerSyncQuery(lastCompleteAt: Date | null | undefined, full: boolean): string | null {
  if (full || !lastCompleteAt) return null;
  return `updated_at:>='${new Date(lastCompleteAt.getTime() - OVERLAP_MS).toISOString()}'`;
}

export async function syncCustomers(storeId: string, opts: { budgetMs?: number; actorId?: string | null; full?: boolean } = {}): Promise<CustomerSyncResult> {
  const startedAt = new Date();
  const deadline = startedAt.getTime() + (opts.budgetMs ?? 120_000);
  const store = await prisma.shopifyStore.findUnique({ where: { id: storeId }, select: { id: true, name: true, status: true, grantedScopes: true, lastCustomerSyncAt: true } });
  if (!store) throw new CustomerSyncError("NOT_FOUND", "Store not found.");
  if (store.status !== "CONNECTED") throw new CustomerSyncError("NOT_CONNECTED", `Store is ${store.status.toLowerCase().replace("_", " ")} — connect it before syncing customers.`);
  if (!hasReadCustomers(store.grantedScopes)) throw new CustomerSyncError("MISSING_SCOPE", "This store has not granted the read_customers permission. Release the app version that includes it, then use Reconnect on the store.");

  const query = customerSyncQuery(store.lastCustomerSyncAt, !!opts.full);
  const r: CustomerSyncResult = { seen: 0, created: 0, updated: 0, linked: 0, unchanged: 0, failed: 0, pages: 0, full: true, since: query ? new Date(store.lastCustomerSyncAt!.getTime() - OVERLAP_MS).toISOString() : undefined, durationMs: 0, message: "" };
  const log = (status: "SUCCESS" | "FAILED" | "NEEDS_ATTENTION", operation: string, message: string, extra: { externalId?: string | null; internalId?: string | null; errorDetail?: string | null } = {}) =>
    logSync({ storeId, direction: "INBOUND", entityType: "CUSTOMER", operation, status, message, externalId: extra.externalId ?? null, internalId: extra.internalId ?? null, errorDetail: extra.errorDetail ?? null });

  let after: string | null = null;
  try {
    for (;;) {
      if (Date.now() > deadline) {
        r.full = false;
        break;
      }
      const page: CustomersPage = await storeGraphql<CustomersPage>(storeId, CUSTOMERS_QUERY, { first: PAGE_SIZE, after, query });
      r.pages++;
      for (const node of page.customers.nodes) {
        r.seen++;
        const rawId = typeof node?.id === "string" ? node.id : null;
        try {
          if (!rawId || !/\/Customer\/\d+$/.test(rawId)) throw new Error(`Unexpected customer id ${JSON.stringify(rawId)}`);
          const out: ShopifyCustomerUpsertResult = await upsertShopifyCustomer({ storeId, shopifyCustomerId: gidToId(rawId) }, customerValuesFromNode(node), opts.actorId ?? null);
          r[out.action]++;
        } catch (err) {
          // One bad record never stops the page: count it, log it with its Shopify id, continue.
          r.failed++;
          await log("NEEDS_ATTENTION", "customer_sync", `Shopify customer ${rawId ? gidToId(rawId) : "(unknown id)"} could not be saved to the directory — ${describeError(err)}. Fix the data in Shopify or V3PL, then sync again.`, { externalId: rawId ? gidToId(rawId) : "unknown", errorDetail: describeError(err) });
        }
      }
      if (!page.customers.pageInfo.hasNextPage) break;
      after = page.customers.pageInfo.endCursor;
    }
  } catch (err) {
    r.durationMs = Date.now() - startedAt.getTime();
    await log("FAILED", "customer_sync", `Customer sync stopped after ${r.seen} customer${r.seen === 1 ? "" : "s"} (${r.pages} page${r.pages === 1 ? "" : "s"}): ${describeError(err)}`, { errorDetail: describeError(err) });
    throw err;
  }

  r.durationMs = Date.now() - startedAt.getTime();
  r.message = describeCustomerSync(r);
  if (r.full) await prisma.shopifyStore.update({ where: { id: storeId }, data: { lastCustomerSyncAt: startedAt } });
  await log(r.failed > 0 || !r.full ? "NEEDS_ATTENTION" : "SUCCESS", "customer_sync", r.message);
  return r;
}

export function describeCustomerSync(r: CustomerSyncResult): string {
  const n = (k: number, w: string) => `${k} ${w}`;
  return `${r.seen} Shopify customer${r.seen === 1 ? "" : "s"} read (${r.pages} page${r.pages === 1 ? "" : "s"}${r.since ? `, updated since ${r.since.slice(0, 16).replace("T", " ")} UTC` : ", full"}): ${n(r.created, "created")}, ${n(r.updated, "updated")}, ${n(r.linked, "linked to existing")}, ${n(r.unchanged, "unchanged")}, ${n(r.failed, "failed")}${r.full ? "" : " — partial (time budget), run again to continue"}`;
}

/** Latest customer sync summary for the store page (time comes from the store row, counts from the log). */
export async function lastCustomerSyncSummary(storeId: string): Promise<string | null> {
  const row = await prisma.shopifySyncLog.findFirst({ where: { storeId, entityType: "CUSTOMER", operation: "customer_sync", externalId: null }, orderBy: { createdAt: "desc" }, select: { message: true } });
  return row?.message ?? null;
}

/**
 * Order relation: the directory record for the customer on a Shopify order, created/updated through the same
 * upsert so an order's customer is represented before the order is imported. Returns null (and logs) instead
 * of throwing — a customer problem must never block an order import. Only used when the store granted the scope.
 */
export async function resolveShopifyOrderCustomer(store: { id: string; grantedScopes: string | null }, orderNumericId: string, actorId: string | null): Promise<string | null> {
  if (!hasReadCustomers(store.grantedScopes)) return null;
  try {
    const data = await storeGraphql<OrderCustomerPayload>(store.id, ORDER_CUSTOMER_QUERY, { id: toGid("Order", orderNumericId) });
    const node = data.order?.customer;
    if (!node) return null;
    const out = await upsertShopifyCustomer({ storeId: store.id, shopifyCustomerId: gidToId(node.id) }, customerValuesFromNode(node), actorId);
    return out.id;
  } catch (err) {
    await logSync({ storeId: store.id, direction: "INBOUND", entityType: "CUSTOMER", operation: "order_customer", status: "NEEDS_ATTENTION", message: `Order ${orderNumericId}: its Shopify customer could not be saved to the directory — the order was imported without a directory link. ${describeError(err)}`, externalId: orderNumericId, errorDetail: describeError(err) });
    return null;
  }
}
