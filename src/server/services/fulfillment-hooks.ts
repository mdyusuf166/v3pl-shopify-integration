import type { Prisma } from "@/generated/prisma/client";

/**
 * Integration hook for shipments (shopify-integration.md §6, core-requests.md R-2): runs
 * inside the shipping / tracking-update transaction after the Shipment (and, for SHIPPED,
 * the ledger rows) exist. The Shopify session registers a handler that enqueues its
 * FULFILLMENT_CREATE / TRACKING_UPDATE jobs for SHOPIFY orders.
 * Handlers must not perform network calls; failures are logged and ignored so an
 * integration problem can never roll back a warehouse action.
 */
export type ShipmentEventKind = "SHIPPED" | "TRACKING_UPDATED";

export type ShipmentTracking = {
  carrier: string | null;
  service: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
};

export type ShipmentEvent = {
  /** SHIPPED = a shipment was created; TRACKING_UPDATED = carrier/tracking changed after shipping. */
  kind: ShipmentEventKind;
  shipmentId: string;
  fulfillmentId: string;
  orderId: string;
  orderSource: string;
  shopifyStoreId: string | null;
  /**
   * True when the change originated outside V3PL (fulfilment created in Shopify, or a
   * tracking update applied from an external event) — integrations must not push it back.
   */
  external: boolean;
  /** Present for TRACKING_UPDATED: the tracking values after the update and before it. */
  tracking?: ShipmentTracking;
  previousTracking?: ShipmentTracking;
  /** External event id that caused the change, when any (replay-guarded by the core). */
  externalEventId?: string | null;
};

export type ShipmentHandler = (tx: Prisma.TransactionClient, event: ShipmentEvent) => Promise<void>;

const handlers: ShipmentHandler[] = [];

export function registerShipmentHandler(handler: ShipmentHandler): () => void {
  handlers.push(handler);
  return () => {
    const i = handlers.indexOf(handler);
    if (i >= 0) handlers.splice(i, 1);
  };
}

/** Number of handlers registered in THIS module instance (diagnostics / tests). */
export function shipmentHandlerCount(): number {
  return handlers.length;
}

/**
 * Make sure THIS module instance has the integration handlers. `handlers` is module state and the
 * Next/Turbopack production bundle holds separate instances of this module for instrumentation, route
 * handlers and server actions — registration done at boot by instrumentation.ts is invisible to the
 * instance a server action executes, which then ships with an empty registry and enqueues nothing
 * (same failure as the job-runner registry, see shopify/jobs.ts `ensureRunnersRegistered`). Dynamic
 * import at call time is cycle-safe (register → this module) and idempotent (register.ts guards itself).
 * A failing import is logged and retried next time; it never blocks the warehouse action.
 */
let ensured: Promise<void> | null = null;
export function ensureShipmentHandlersRegistered(): Promise<void> {
  if (!ensured) {
    ensured = import("@/server/services/shopify/register")
      .then(() => undefined)
      .catch((err) => {
        ensured = null;
        console.error("[shipment hook] integration registration failed (ignored):", err instanceof Error ? err.message : err);
      });
  }
  return ensured;
}

export async function runShipmentHandlers(tx: Prisma.TransactionClient, event: ShipmentEvent): Promise<void> {
  await ensureShipmentHandlersRegistered();
  // Each handler runs inside a savepoint: a failing SQL statement would otherwise abort the
  // whole PostgreSQL transaction even though the JavaScript error is caught here.
  for (const [i, handler] of handlers.entries()) {
    const sp = `hook_${i}`;
    await tx.$executeRawUnsafe(`SAVEPOINT ${sp}`);
    try {
      await handler(tx, event);
      await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${sp}`);
    } catch (err) {
      await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${sp}`).catch(() => undefined);
      console.error("[shipment hook] handler failed (ignored):", err instanceof Error ? err.message : err);
    }
  }
}
