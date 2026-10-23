/**
 * Runner registry inside the BUILT server (root cause of "ORDER_CREATE stays PENDING, 0 attempts" in
 * production, 2026-09-15): the job registry is module-instance state and the production bundle holds
 * several instances of jobs.ts; registration must happen in the instance that drains.
 *
 * Proves, through the real production server on `base`:
 *  - a PENDING ORDER_CREATE job is discovered and claimed by the webhook piggyback drain (`after()`),
 *    its attempt count changes and it reaches the runner (target missing → NEEDS_ATTENTION with the runner's message);
 *  - the same for FULFILLMENT_CREATE (unchanged behaviour);
 *  - the cron route drains too (when CRON_SECRET is set locally);
 *  - in-process: a fresh jobs.ts instance without any prior registration self-registers on first use.
 *
 * Usage: npm run build && npx next start -p 3100 ; npm run e2e:shopify-runner -- http://localhost:3100
 */
import { createHmac } from "node:crypto";
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });
loadEnv();

const [base = "http://localhost:3100"] = process.argv.slice(2);
const RUN = `RR${Date.now().toString(36)}`.toUpperCase();
const results: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  // Deliberately NOT importing register.ts / runners.ts: this process must self-register on first use.
  const jobs = await import("../src/server/services/shopify/jobs");
  const { shopifyEnv } = await import("../src/server/services/shopify/env");
  const env = shopifyEnv();

  check("in-process: a fresh jobs.ts instance starts with an empty registry (nothing registered it)", jobs.runnableJobTypes().length === 0);
  await jobs.ensureRunnersRegistered();
  const types = jobs.runnableJobTypes().sort();
  check("in-process: first drain use self-registers all four runners in THIS instance", types.join(",") === "FULFILLMENT_CREATE,INVENTORY_PUBLISH,ORDER_CREATE,TRACKING_UPDATE", types.join(","));

  const stores: string[] = [];
  const mkStore = async (tag: string) => {
    const shop = `probe-${RUN.toLowerCase()}-${tag}.myshopify.com`;
    const store = await prisma.shopifyStore.create({ data: { name: `Registry probe ${RUN} ${tag}`, shopDomain: shop, apiVersion: env.SHOPIFY_API_VERSION, status: "CONNECTED", grantedScopes: "write_orders" } });
    stores.push(store.id);
    const jo = await prisma.shopifyOutboundJob.create({ data: { storeId: store.id, type: "ORDER_CREATE", targetType: "Order", targetId: `missing-${RUN}-${tag}`, dedupeKey: `order:missing-${RUN}-${tag}`, status: "PENDING" } });
    const jf = await prisma.shopifyOutboundJob.create({ data: { storeId: store.id, type: "FULFILLMENT_CREATE", targetType: "Shipment", targetId: `missing-${RUN}-${tag}`, dedupeKey: `fulfillment:missing-${RUN}-${tag}`, status: "PENDING" } });
    return { store, shop, jo, jf };
  };
  const waitSettled = async (ids: string[], timeoutMs = 30_000) => {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const rows = await prisma.shopifyOutboundJob.findMany({ where: { id: { in: ids } }, select: { id: true, type: true, status: true, attempts: true, lastError: true } });
      if (rows.every((r) => r.status !== "PENDING" && r.status !== "RUNNING") || Date.now() > until) return rows;
      await sleep(1000);
    }
  };

  try {
    // ---------------------------------------------------------------- webhook piggyback drain (after()) in the built server
    const a = await mkStore("wh");
    const body = JSON.stringify({ id: 1, admin_graphql_api_id: "gid://shopify/Order/1" });
    const res = await fetch(`${base}/api/webhooks/shopify`, { method: "POST", headers: { "Content-Type": "application/json", "X-Shopify-Topic": "orders/create", "X-Shopify-Shop-Domain": a.shop, "X-Shopify-Webhook-Id": `wh-${RUN}`, "X-Shopify-Event-Id": `ev-${RUN}`, "X-Shopify-API-Version": env.SHOPIFY_API_VERSION, "X-Shopify-Triggered-At": new Date().toISOString(), "X-Shopify-Hmac-Sha256": createHmac("sha256", env.SHOPIFY_API_SECRET).update(body).digest("base64") }, body });
    check("server: signed webhook accepted (200) — its after() runs processWebhookEvent + drainPending(store)", res.status === 200);
    const rows = await waitSettled([a.jo.id, a.jf.id]);
    const ro = rows.find((r) => r.type === "ORDER_CREATE")!;
    const rf = rows.find((r) => r.type === "FULFILLMENT_CREATE")!;
    check("server: PENDING ORDER_CREATE job is discovered, claimed (attempts 0 → 1) and reaches the runner (missing order → NEEDS_ATTENTION)", ro.status === "NEEDS_ATTENTION" && ro.attempts === 1 && /V3PL order no longer exists/.test(ro.lastError ?? ""), `${ro.status} attempts ${ro.attempts} ${ro.lastError ?? ""}`);
    check("server: FULFILLMENT_CREATE behaves exactly as before (claimed once, runner message)", rf.status === "NEEDS_ATTENTION" && rf.attempts === 1 && /Shipment no longer exists/.test(rf.lastError ?? ""), `${rf.status} attempts ${rf.attempts} ${rf.lastError ?? ""}`);
    check("server: sync log written by the runner instance that drained (entity ORDER for ORDER_CREATE)", (await prisma.shopifySyncLog.count({ where: { storeId: a.store.id, entityType: "ORDER", operation: "order_create", status: "NEEDS_ATTENTION" } })) === 1);

    // ---------------------------------------------------------------- cron route (own bundle instance)
    if (process.env.CRON_SECRET) {
      const c = await mkStore("cron");
      const cr = await fetch(`${base}/api/cron/shopify-daily`, { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
      const summary = (await cr.json()) as { jobsRun?: number };
      const crows = await waitSettled([c.jo.id, c.jf.id], 5_000);
      check("server: cron route drains ORDER_CREATE + FULFILLMENT_CREATE in its own bundle instance", cr.status === 200 && (summary.jobsRun ?? 0) >= 2 && crows.every((r) => r.status === "NEEDS_ATTENTION" && r.attempts === 1), `status ${cr.status} jobsRun ${summary.jobsRun} → ${crows.map((r) => `${r.type}:${r.status}/${r.attempts}`).join(" ")}`);
    } else {
      console.log("SKIP  cron route probe — CRON_SECRET not set locally");
    }

    // ---------------------------------------------------------------- in-process claim semantics (unchanged)
    const d = await mkStore("ip");
    const before = await prisma.shopifyOutboundJob.findUniqueOrThrow({ where: { id: d.jo.id } });
    const status = await jobs.runJob(d.jo.id);
    const after = await prisma.shopifyOutboundJob.findUniqueOrThrow({ where: { id: d.jo.id } });
    check("in-process: runJob claims PENDING → RUNNING → terminal, attempts incremented exactly once, not claimable again", before.attempts === 0 && status === "NEEDS_ATTENTION" && after.attempts === 1 && after.lockedAt === null && (await jobs.runJob(d.jo.id)) === null);
    check("in-process: runDueJobs selects ORDER_CREATE for a CONNECTED store (type filter includes it)", (await jobs.runDueJobs({ storeId: d.store.id })) === 1 && (await prisma.shopifyOutboundJob.findUniqueOrThrow({ where: { id: d.jf.id } })).status === "NEEDS_ATTENTION");
  } finally {
    await prisma.shopifyWebhookEvent.deleteMany({ where: { webhookId: `wh-${RUN}` } });
    await prisma.shopifyStore.deleteMany({ where: { id: { in: stores } } });
    await prisma.$disconnect();
    console.log(`Cleanup done (${stores.length} probe stores removed).`);
  }
  const failed = results.filter((x) => !x.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
