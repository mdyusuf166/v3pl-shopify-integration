import { prisma } from "@/lib/prisma";
import { syncCatalog } from "./catalog";
import { publishSweep } from "./inventory-publish";
import { runDueJobs } from "./jobs";
import { reconcileOrders } from "./orders-in";
import { cleanupAbandonedInstalls, refreshAllConnectedStores } from "./oauth";
import { describeError, logSync } from "./sync-log";
import { retryDueWebhookEvents } from "./webhooks";

/**
 * Free-tier scheduling (D-031, shopify-integration.md §13).
 * - drainPending: layer 3 “piggyback” — bounded retry work after a webhook or an Admin page load.
 * - runDailyMaintenance: layer 4 — the single daily Vercel cron.
 * Later steps add order reconciliation, the publish sweep and catalog sync to the daily run.
 */

export async function drainPending(storeId: string | null, budgetMs = 15_000): Promise<{ events: number; jobs: number }> {
  const deadline = Date.now() + budgetMs;
  const events = await retryDueWebhookEvents({ storeId: storeId ?? undefined, limit: 10, deadline });
  const jobs = Date.now() < deadline ? await runDueJobs({ storeId: storeId ?? undefined, limit: 10, deadline }) : 0;
  return { events, jobs };
}

const scheduled = new Set<string>();

/**
 * Run the store's pending outbound jobs right after the current request has responded
 * (Next.js `after()`), so a warehouse shipment reaches Shopify within seconds without any
 * scheduler. Outside a request scope (scripts, cron) this is a no-op; the drain/daily run cover it.
 */
export function scheduleAfterResponse(storeId: string): void {
  if (scheduled.has(storeId)) return;
  scheduled.add(storeId);
  void (async () => {
    try {
      const { after } = await import("next/server");
      after(async () => {
        scheduled.delete(storeId);
        try {
          await drainPending(storeId, 20_000);
        } catch (err) {
          console.error("[shopify after] drain failed:", describeError(err));
        }
      });
    } catch {
      scheduled.delete(storeId); // no request scope (script / cron) — the drain or daily run will pick it up
    }
  })();
}

export type DailySummary = {
  startedAt: string;
  finishedAt: string;
  tokens: { refreshed: number; failed: { storeId: string; error: string }[] };
  abandonedInstallsRemoved: number;
  webhookEventsRetried: number;
  jobsRun: number;
  healthWarnings: { storeId: string; message: string }[];
  catalogSyncs: { storeId: string; ok: boolean; detail: string }[];
  orderReconciliations: { storeId: string; ok: boolean; detail: string }[];
  publishSweeps: { storeId: string; ok: boolean; detail: string }[];
  timedOut: boolean;
};

const WEBHOOK_SILENCE_MS = 48 * 3_600_000;

export async function runDailyMaintenance(budgetMs = 240_000): Promise<DailySummary> {
  const startedAt = new Date();
  const deadline = startedAt.getTime() + budgetMs;

  const tokens = await refreshAllConnectedStores();
  const abandonedInstallsRemoved = await cleanupAbandonedInstalls();
  const webhookEventsRetried = await retryDueWebhookEvents({ limit: 200, deadline });
  const jobsRun = Date.now() < deadline ? await runDueJobs({ limit: 200, deadline }) : 0;

  const healthWarnings: { storeId: string; message: string }[] = [];
  const catalogSyncs: DailySummary["catalogSyncs"] = [];
  const stores = await prisma.shopifyStore.findMany({ where: { status: "CONNECTED" }, select: { id: true, name: true, installedAt: true, lastWebhookAt: true, ordersImportEnabled: true } });
  // Step 2: daily catalog sync per connected store (self-heals missed products/update webhooks).
  for (const s of stores) {
    const remaining = deadline - Date.now();
    if (remaining < 15_000) break;
    try {
      const r = await syncCatalog(s.id, { mode: "auto", budgetMs: Math.min(remaining - 5_000, 90_000) });
      catalogSyncs.push({ storeId: s.id, ok: r.full, detail: `${r.seen} variants, ${r.summary.MATCHED} matched, ${r.summary.UNMATCHED} unmatched, ${r.summary.CONFLICT} conflicts${r.full ? "" : " (partial)"}` });
    } catch (err) {
      catalogSyncs.push({ storeId: s.id, ok: false, detail: describeError(err) });
    }
  }
  // Step 3: order reconciliation (orders updated since the store checkpoint) — safety net for missed webhooks.
  const orderReconciliations: DailySummary["orderReconciliations"] = [];
  for (const s of stores) {
    const remaining = deadline - Date.now();
    if (remaining < 15_000) break;
    try {
      const r = await reconcileOrders(s.id, { budgetMs: Math.min(remaining - 5_000, 60_000) });
      orderReconciliations.push({ storeId: s.id, ok: r.complete, detail: `${r.scanned} checked, ${r.created} imported, ${r.updated} updated, ${r.cancelled} cancelled, ${r.unresolved} attention${r.complete ? "" : " (partial)"}` });
    } catch (err) {
      orderReconciliations.push({ storeId: s.id, ok: false, detail: describeError(err) });
    }
  }
  // Step 4: inventory publish drift sweep for publish-enabled stores.
  const publishSweeps: DailySummary["publishSweeps"] = [];
  for (const s of stores) {
    const remaining = deadline - Date.now();
    if (remaining < 15_000) break;
    try {
      const r = await publishSweep(s.id, { deadline: Date.now() + Math.min(remaining - 5_000, 60_000) });
      if (r.checked > 0 || !r.complete) publishSweeps.push({ storeId: s.id, ok: r.complete && r.conflicts === 0 && r.errors === 0, detail: `${r.checked} checked, ${r.published} republished, ${r.conflicts} conflicts, ${r.errors} errors${r.complete ? "" : " (partial)"}` });
    } catch (err) {
      publishSweeps.push({ storeId: s.id, ok: false, detail: describeError(err) });
    }
  }
  for (const s of stores) {
    const last = s.lastWebhookAt ?? s.installedAt;
    if (s.ordersImportEnabled && last && Date.now() - last.getTime() > WEBHOOK_SILENCE_MS) {
      const message = `No webhooks received from ${s.name} for more than 48 hours — check the app's webhook subscriptions in the Dev Dashboard.`;
      healthWarnings.push({ storeId: s.id, message });
      await logSync({ storeId: s.id, direction: "INBOUND", entityType: "STORE", operation: "health", status: "NEEDS_ATTENTION", message });
    }
  }

  return {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    tokens: { refreshed: tokens.refreshed.length, failed: tokens.failed },
    abandonedInstallsRemoved,
    webhookEventsRetried,
    jobsRun,
    healthWarnings,
    catalogSyncs,
    orderReconciliations,
    publishSweeps,
    timedOut: Date.now() > deadline,
  };
}
