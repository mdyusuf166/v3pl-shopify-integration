import type { Prisma } from "@/generated/prisma/client";

/**
 * Extension point for integrations (Shopify session, D-027 / shopify-integration.md §6).
 *
 * Handlers run INSIDE the inventory transaction, after the ledger rows and cached
 * balances have been written, and receive the transaction client so they can write
 * their own rows atomically (e.g. an outbound publish job). They must not perform
 * network calls. A throwing handler is logged and swallowed so an integration
 * problem can never roll back a warehouse action.
 */
export type InventoryChange = {
  variantId: string;
  warehouseId: string;
  ownerId: string;
  /** New warehouse-level figures after the change. */
  onHand: number;
  reserved: number;
  available: number;
};

export type InventoryChangeHandler = (tx: Prisma.TransactionClient, changes: InventoryChange[]) => Promise<void>;

const handlers: InventoryChangeHandler[] = [];

export function registerInventoryChangeHandler(handler: InventoryChangeHandler): () => void {
  handlers.push(handler);
  return () => {
    const i = handlers.indexOf(handler);
    if (i >= 0) handlers.splice(i, 1);
  };
}

/** Number of handlers registered in THIS module instance (diagnostics / tests). */
export function inventoryHandlerCount(): number {
  return handlers.length;
}

/**
 * Make sure THIS module instance has the integration handlers. `handlers` is module state and the
 * Next/Turbopack production bundle holds separate instances of this module for instrumentation, route
 * handlers and server actions — registration done at boot by instrumentation.ts is invisible to the
 * instance a server action executes, which then applies stock changes with an empty registry and
 * publishes nothing (same failure as the job-runner registry, see shopify/jobs.ts). Dynamic import at
 * call time is cycle-safe (register → this module) and idempotent (register.ts guards itself). A failing
 * import is logged and retried next time; it never blocks the warehouse action.
 */
let ensured: Promise<void> | null = null;
export function ensureInventoryHandlersRegistered(): Promise<void> {
  if (!ensured) {
    ensured = import("@/server/services/shopify/register")
      .then(() => undefined)
      .catch((err) => {
        ensured = null;
        console.error("[inventory hook] integration registration failed (ignored):", err instanceof Error ? err.message : err);
      });
  }
  return ensured;
}

export async function runInventoryChangeHandlers(tx: Prisma.TransactionClient, changes: InventoryChange[]): Promise<void> {
  if (changes.length === 0) return;
  await ensureInventoryHandlersRegistered();
  // Each handler runs inside a savepoint: a failing SQL statement would otherwise abort the
  // whole PostgreSQL transaction even though the JavaScript error is caught here.
  for (const [i, handler] of handlers.entries()) {
    const sp = `hook_${i}`;
    await tx.$executeRawUnsafe(`SAVEPOINT ${sp}`);
    try {
      await handler(tx, changes);
      await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${sp}`);
    } catch (err) {
      await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${sp}`).catch(() => undefined);
      console.error("[inventory hook] handler failed (ignored):", err instanceof Error ? err.message : err);
    }
  }
}
