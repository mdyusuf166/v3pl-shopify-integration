import type { FulfillmentRecordStatus, FulfillmentStatus, OrderStatus, ShipmentStatus } from "@/generated/prisma/client";

/**
 * Pure status derivation (D-008): the three dimensions are computed from line
 * quantities and child records, never edited by hand.
 */

export type LineQty = { quantity: number; reservedQty: number; shippedQty: number; cancelledQty: number };

export function remainingQty(i: LineQty): number {
  return i.quantity - i.shippedQty - i.cancelledQty;
}

export function deriveFulfillmentStatus(
  items: LineQty[],
  fulfillments: { status: FulfillmentRecordStatus }[],
  shipments: { status: ShipmentStatus }[],
): FulfillmentStatus {
  const active = items.filter((i) => i.quantity - i.cancelledQty > 0);
  if (active.length === 0) return "UNFULFILLED";
  const shipped = active.reduce((s, i) => s + i.shippedQty, 0);
  const remaining = active.reduce((s, i) => s + remainingQty(i), 0);
  const reserved = active.reduce((s, i) => s + i.reservedQty, 0);
  if (shipped === 0) {
    if (fulfillments.some((f) => f.status === "PACKED")) return "PACKED";
    if (fulfillments.some((f) => f.status === "PICKING")) return "PICKING";
    return reserved > 0 ? "RESERVED" : "UNFULFILLED";
  }
  if (remaining > 0) return "PARTIALLY_SHIPPED";
  const allDelivered = shipments.length > 0 && shipments.every((s) => s.status === "DELIVERED");
  return allDelivered ? "FULFILLED" : "SHIPPED";
}

export function deriveOrderStatus(current: OrderStatus, items: LineQty[]): OrderStatus {
  if (current === "CANCELLED" || current === "DRAFT") return current;
  const active = items.filter((i) => i.quantity - i.cancelledQty > 0);
  const shipped = items.reduce((s, i) => s + i.shippedQty, 0);
  if (active.length === 0) return shipped > 0 ? "COMPLETED" : "CANCELLED";
  const remaining = active.reduce((s, i) => s + remainingQty(i), 0);
  if (remaining === 0 && shipped > 0) return "COMPLETED";
  const reserved = active.reduce((s, i) => s + i.reservedQty, 0);
  if (current === "NEW" && reserved > 0 && reserved === remaining) return "CONFIRMED";
  if (current === "COMPLETED") return "CONFIRMED"; // re-opened (e.g. quantity added) — stays confirmed
  return current;
}

/** Shopify-style labels used in CSV export (Shopify vocabulary, V3PL truth in V3PL columns). */
export function shopifyFulfillmentLabel(status: FulfillmentStatus): "fulfilled" | "partial" | "unfulfilled" {
  if (status === "SHIPPED" || status === "FULFILLED") return "fulfilled";
  if (status === "PARTIALLY_SHIPPED") return "partial";
  return "unfulfilled";
}

export function shopifyFinancialLabel(status: string): string {
  switch (status) {
    case "PAID":
      return "paid";
    case "PARTIALLY_PAID":
      return "partially_paid";
    default:
      return "pending";
  }
}

export function financialStatusFromShopifyLabel(label: string | undefined | null): "PAID" | "PARTIALLY_PAID" | "OUTSTANDING" | "NOT_INVOICED" | null {
  if (!label) return null;
  switch (label.trim().toLowerCase()) {
    case "paid":
      return "PAID";
    case "partially_paid":
    case "partially paid":
      return "PARTIALLY_PAID";
    case "pending":
    case "authorized":
    case "unpaid":
    case "partially_refunded":
    case "refunded":
    case "voided":
    case "expired":
      return "OUTSTANDING";
    default:
      return null;
  }
}
