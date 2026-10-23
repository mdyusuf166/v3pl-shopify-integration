import { runFulfillmentCreateJob, runTrackingUpdateJob } from "./fulfillment-out";
import { runInventoryPublishJob } from "./inventory-publish";
import { registerJobRunner } from "./jobs";
import { runOrderCreateJob } from "./order-out";

/**
 * Outbound job runners. Registration is per MODULE INSTANCE, never guarded by a global: the
 * production bundle contains several instances of jobs.ts (instrumentation, route handlers, server
 * actions, cron), each with its own registry, and a `globalThis` once-flag made only the first
 * instance register — every request-handling instance then saw an empty registry and no job was
 * ever claimed (0 attempts). jobs.ts imports this module lazily before selecting/claiming work, so
 * whichever instance drains has its runners. Re-running is idempotent (map assignment).
 */
let registered = false;

export function registerShopifyRunners(): void {
  if (registered) return;
  registered = true;
  registerJobRunner("FULFILLMENT_CREATE", runFulfillmentCreateJob);
  registerJobRunner("TRACKING_UPDATE", runTrackingUpdateJob);
  registerJobRunner("INVENTORY_PUBLISH", runInventoryPublishJob);
  registerJobRunner("ORDER_CREATE", runOrderCreateJob); // manual V3PL order → Shopify order (D-061/D-062)
}

registerShopifyRunners();
