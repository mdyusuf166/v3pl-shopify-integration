/**
 * Read-only Shopify diagnostics for a connected store: store row (no secrets printed),
 * webhook subscriptions Shopify has for this app on the shop, recent recorded deliveries
 * (including ones filed under an unknown shop domain), and the resolved callback URL.
 *
 * Usage:
 *   npm run shopify:diagnose -- <shop domain> [path to .env file with DATABASE_URL]
 * The env file argument lets you point at a different database (e.g. production) while the
 * Shopify credentials still come from the worktree .env.local. Nothing is written.
 */
import { readFileSync } from "node:fs";
import { config as loadEnv } from "dotenv";

const [shopArg, dbEnvPath] = process.argv.slice(2);
if (dbEnvPath) {
  for (const line of readFileSync(dbEnvPath, "utf8").split("\n")) {
    const m = line.match(/^(DATABASE_URL|DIRECT_URL)=(.*)$/);
    if (m) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
}
loadEnv({ path: ".env.local" });
loadEnv();

const SUBSCRIPTIONS_QUERY = /* GraphQL */ `
  query V3plWebhookSubscriptions {
    webhookSubscriptions(first: 100) {
      nodes {
        id
        topic
        format
        createdAt
        updatedAt
        endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } }
      }
    }
  }
`;

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { appUrl } = await import("../src/lib/env");
  const { shopifyEnv } = await import("../src/server/services/shopify/env");
  const { normalizeShopDomain } = await import("../src/server/services/shopify/crypto");
  const { getAccessToken } = await import("../src/server/services/shopify/oauth");
  const { graphqlRequest, ShopifyApiError } = await import("../src/server/services/shopify/client");

  const env = shopifyEnv();
  const host = (process.env.DATABASE_URL ?? "").match(/@([^/]+)/)?.[1];
  console.log(`database host: ${host}`);
  console.log(`callback URL this environment would register: ${appUrl()}/api/webhooks/shopify`);
  console.log(`API version: ${env.SHOPIFY_API_VERSION} | client id ends with …${env.SHOPIFY_API_KEY.slice(-4)}`);

  const shopDomain = normalizeShopDomain(shopArg ?? "");
  if (!shopDomain) {
    console.error("Usage: shopify:diagnose <shop domain> [env file]");
    process.exit(2);
  }
  const store = await prisma.shopifyStore.findUnique({
    where: { shopDomain },
    select: { id: true, name: true, status: true, apiVersion: true, grantedScopes: true, installedAt: true, lastWebhookAt: true, lastError: true, accessTokenExpiresAt: true, refreshTokenExpiresAt: true, encAccessToken: true },
  });
  if (!store) {
    console.error(`No ShopifyStore row for ${shopDomain} in this database.`);
    process.exit(1);
  }
  console.log("\n== store row ==");
  console.log({ ...store, encAccessToken: store.encAccessToken ? `present (${store.encAccessToken.length} chars, encrypted)` : null });

  console.log("\n== recorded webhook deliveries (all stores, latest 10) ==");
  const events = await prisma.shopifyWebhookEvent.findMany({ orderBy: { receivedAt: "desc" }, take: 10, select: { receivedAt: true, shopDomain: true, storeId: true, topic: true, status: true, error: true, webhookId: true } });
  console.log(events.length ? events : "(none)");
  console.log(`total deliveries recorded: ${await prisma.shopifyWebhookEvent.count()}; for this store: ${await prisma.shopifyWebhookEvent.count({ where: { storeId: store.id } })}; unknown-shop: ${await prisma.shopifyWebhookEvent.count({ where: { storeId: null } })}`);

  console.log("\n== Shopify: webhook subscriptions visible to this app on the shop ==");
  try {
    const target = await getAccessToken(store.id);
    const { data } = await graphqlRequest<{ webhookSubscriptions: { nodes: { id: string; topic: string; format: string; createdAt: string; endpoint: { __typename: string; callbackUrl?: string } }[] } }>(target, SUBSCRIPTIONS_QUERY);
    const nodes = data.webhookSubscriptions.nodes;
    if (nodes.length === 0) {
      console.log("(none) — the API returned zero subscriptions for this app on this shop.");
      console.log("Note: subscriptions declared in the app configuration (Dev Dashboard version) are managed by Shopify and are NOT listed by this query; only API-created (shop-specific) ones appear.");
    } else {
      for (const n of nodes) console.log(`${n.topic.padEnd(32)} → ${n.endpoint.callbackUrl ?? n.endpoint.__typename}  (${n.format}, created ${n.createdAt})`);
    }
  } catch (err) {
    console.log("Could not query Shopify:", err instanceof ShopifyApiError ? `${err.code} ${err.message}` : err instanceof Error ? err.message : err);
  }
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
