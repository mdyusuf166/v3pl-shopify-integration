/**
 * Customer-facing order status (D-055). The three internal dimensions (order status,
 * fulfilment stage, shipment states) stay in the database and in warehouse screens; the
 * UI leads with one Shopify-like status so admins and partners read orders the same way.
 */

export type PresentedStatus = "UNFULFILLED" | "PARTIALLY_FULFILLED" | "FULFILLED" | "DELIVERED" | "RETURNED" | "CANCELLED";

export const PRESENTED_STATUSES: readonly PresentedStatus[] = ["UNFULFILLED", "PARTIALLY_FULFILLED", "FULFILLED", "DELIVERED", "RETURNED", "CANCELLED"];

export const PRESENTED_STATUS_LABEL: Record<PresentedStatus, string> = {
  UNFULFILLED: "Unfulfilled",
  PARTIALLY_FULFILLED: "Partially fulfilled",
  FULFILLED: "Fulfilled",
  DELIVERED: "Delivered",
  RETURNED: "Returned",
  CANCELLED: "Cancelled",
};

type OrderLike = {
  status: string;
  fulfillmentStatus: string;
  items?: { shippedQty: number; returnedQty?: number }[];
};

export function presentOrderStatus(order: OrderLike): PresentedStatus {
  if (order.status === "CANCELLED") return "CANCELLED";
  const items = order.items ?? [];
  const shipped = items.reduce((s, i) => s + i.shippedQty, 0);
  const returned = items.reduce((s, i) => s + (i.returnedQty ?? 0), 0);
  if (shipped > 0 && returned >= shipped) return "RETURNED";
  switch (order.fulfillmentStatus) {
    case "FULFILLED":
      return "DELIVERED";
    case "SHIPPED":
      return "FULFILLED";
    case "PARTIALLY_SHIPPED":
      return "PARTIALLY_FULFILLED";
    default:
      return "UNFULFILLED";
  }
}

/** Warehouse stage worth showing next to the primary status (staff screens only). */
export function warehouseStageLabel(fulfillmentStatus: string): string | null {
  switch (fulfillmentStatus) {
    case "RESERVED":
      return "Reserved";
    case "PICKING":
      return "Picking";
    case "PACKED":
      return "Packed";
    default:
      return null;
  }
}
