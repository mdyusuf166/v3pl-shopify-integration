import { appUrl } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/server/services/audit";
import { decryptSecret, encryptSecret, normalizeShopDomain, randomToken, safeEqual, verifyOAuthQueryHmac } from "./crypto";
import { shopifyEnv } from "./env";
import { shopifyFetch } from "./client";
import { describeError, logSync } from "./sync-log";

/**
 * Store authorization: OAuth authorization code grant started from V3PL, expiring offline
 * access tokens with refresh (D-021/D-022, shopify-integration.md §4).
 *
 * Tokens are stored AES-256-GCM encrypted and only ever decrypted server-side, immediately
 * before an API call. Nothing in this module returns a token to UI code.
 */

export type OAuthErrorCode =
  | "NOT_CONFIGURED"
  | "INVALID_SHOP"
  | "NOT_FOUND"
  | "INVALID_HMAC"
  | "INVALID_STATE"
  | "MISSING_CODE"
  | "TOKEN_EXCHANGE"
  | "REFRESH_FAILED"
  | "NOT_CONNECTED";

export class ShopifyOAuthError extends Error {
  constructor(
    public readonly code: OAuthErrorCode,
    message: string,
    public readonly detail?: string,
  ) {
    super(message);
  }
}

export const OAUTH_STATE_TTL_MS = 10 * 60_000;
/** Refresh the access token when it expires within this window. */
export const ACCESS_TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;

export function oauthCallbackUrl(): string {
  return `${appUrl()}/api/shopify/oauth/callback`;
}

type StoreCreds = { clientIdOverride: string | null; encClientSecretOverride: string | null };

/** App credentials for a store: the per-store override (custom-distribution fallback) or the app env. */
export function effectiveCredentials(store: StoreCreds): { clientId: string; clientSecret: string } {
  const env = shopifyEnv();
  if (store.clientIdOverride && store.encClientSecretOverride) {
    return { clientId: store.clientIdOverride, clientSecret: decryptSecret(store.encClientSecretOverride, env.SHOPIFY_TOKEN_ENCRYPTION_KEY) };
  }
  return { clientId: env.SHOPIFY_API_KEY, clientSecret: env.SHOPIFY_API_SECRET };
}

// ---------------------------------------------------------------------------
// Install / reconnect
// ---------------------------------------------------------------------------

export type BeginInstallResult = { storeId: string; shopDomain: string; authorizeUrl: string; reconnect: boolean };

/**
 * Step 1 of the grant: create (or reuse) the store row, remember a CSRF nonce and build the
 * Shopify authorize URL the Admin's browser is sent to.
 */
export async function beginInstall(input: { shopDomain: string; name?: string | null }, actorId: string): Promise<BeginInstallResult> {
  const env = shopifyEnv();
  const shopDomain = normalizeShopDomain(input.shopDomain);
  if (!shopDomain) throw new ShopifyOAuthError("INVALID_SHOP", "Enter the store's myshopify.com domain, e.g. casabella.myshopify.com.");

  const state = randomToken(24);
  const oauthStateExpiresAt = new Date(Date.now() + OAUTH_STATE_TTL_MS);
  const handle = shopDomain.replace(/\.myshopify\.com$/, "");
  const name = input.name?.trim() || handle;

  const existing = await prisma.shopifyStore.findUnique({ where: { shopDomain }, select: { id: true, name: true, clientIdOverride: true, encClientSecretOverride: true } });
  const store = existing
    ? await prisma.shopifyStore.update({
        where: { id: existing.id },
        data: { oauthState: state, oauthStateExpiresAt, ...(input.name?.trim() ? { name: input.name.trim() } : {}) },
        select: { id: true, clientIdOverride: true, encClientSecretOverride: true },
      })
    : await prisma.shopifyStore.create({
        data: { name, shopDomain, apiVersion: env.SHOPIFY_API_VERSION, status: "PENDING_INSTALL", oauthState: state, oauthStateExpiresAt },
        select: { id: true, clientIdOverride: true, encClientSecretOverride: true },
      });

  const creds = effectiveCredentials(store);
  const url = new URL(`https://${shopDomain}/admin/oauth/authorize`);
  url.searchParams.set("client_id", creds.clientId);
  url.searchParams.set("scope", env.SHOPIFY_SCOPES);
  url.searchParams.set("redirect_uri", oauthCallbackUrl());
  url.searchParams.set("state", state);

  await recordAudit({
    userId: actorId,
    action: existing ? "shopify_store.reconnect_started" : "shopify_store.install_started",
    entityType: "ShopifyStore",
    entityId: store.id,
    newValues: { shopDomain },
  });
  return { storeId: store.id, shopDomain, authorizeUrl: url.toString(), reconnect: !!existing };
}

type TokenResponse = {
  access_token: string;
  scope: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
};

async function tokenRequest(shopDomain: string, body: Record<string, string>, failCode: OAuthErrorCode): Promise<TokenResponse> {
  let res: Response;
  try {
    res = await shopifyFetch()(`https://${shopDomain}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new ShopifyOAuthError(failCode, `Could not reach ${shopDomain} to obtain an access token.`, describeError(err));
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new ShopifyOAuthError(failCode, `Shopify refused the token request (HTTP ${res.status}).`, text.slice(0, 500));
  let json: TokenResponse;
  try {
    json = JSON.parse(text) as TokenResponse;
  } catch {
    throw new ShopifyOAuthError(failCode, "Shopify returned an unreadable token response.", text.slice(0, 200));
  }
  if (!json.access_token) throw new ShopifyOAuthError(failCode, "Shopify returned no access token.", text.slice(0, 200));
  return json;
}

function encryptedTokenFields(t: TokenResponse, keyB64: string, previous?: { encRefreshToken: string | null; refreshTokenExpiresAt: Date | null }) {
  const now = Date.now();
  return {
    encAccessToken: encryptSecret(t.access_token, keyB64),
    accessTokenExpiresAt: t.expires_in ? new Date(now + t.expires_in * 1000) : null,
    // Shopify may omit the refresh token on a refresh response; keep the one we have.
    encRefreshToken: t.refresh_token ? encryptSecret(t.refresh_token, keyB64) : (previous?.encRefreshToken ?? null),
    refreshTokenExpiresAt: t.refresh_token_expires_in ? new Date(now + t.refresh_token_expires_in * 1000) : t.refresh_token ? null : (previous?.refreshTokenExpiresAt ?? null),
    grantedScopes: t.scope ?? null,
  };
}

/**
 * Step 2 of the grant (the callback): verify HMAC, state and shop, exchange the code for an
 * expiring offline token, store it encrypted and mark the store CONNECTED.
 * Shop metadata (name, locations) is loaded afterwards by api.refreshShopMetadata().
 */
export async function completeInstall(params: URLSearchParams, actorId: string): Promise<{ storeId: string; shopDomain: string; reconnect: boolean }> {
  const env = shopifyEnv();
  const shopParam = (params.get("shop") ?? "").trim().toLowerCase();
  const shopDomain = normalizeShopDomain(shopParam);
  if (!shopDomain || shopDomain !== shopParam) throw new ShopifyOAuthError("INVALID_SHOP", "The callback did not name a valid Shopify store.");

  const store = await prisma.shopifyStore.findUnique({ where: { shopDomain } });
  if (!store) throw new ShopifyOAuthError("NOT_FOUND", "This store was not added from V3PL. Use “Add Shopify Store” first.");

  const creds = effectiveCredentials(store);
  if (!verifyOAuthQueryHmac(params, creds.clientSecret)) throw new ShopifyOAuthError("INVALID_HMAC", "The authorization response could not be verified.");

  const state = params.get("state") ?? "";
  const stateOk = !!store.oauthState && !!state && safeEqual(store.oauthState, state) && !!store.oauthStateExpiresAt && store.oauthStateExpiresAt.getTime() > Date.now();
  if (!stateOk) throw new ShopifyOAuthError("INVALID_STATE", "The connection request expired or did not match. Please start again from “Add Shopify Store”.");

  const code = params.get("code");
  if (!code) throw new ShopifyOAuthError("MISSING_CODE", "Shopify did not return an authorization code.");

  const token = await tokenRequest(shopDomain, { client_id: creds.clientId, client_secret: creds.clientSecret, code, expiring: "1" }, "TOKEN_EXCHANGE");
  const reconnect = !!store.installedAt;
  await prisma.shopifyStore.update({
    where: { id: store.id },
    data: {
      ...encryptedTokenFields(token, env.SHOPIFY_TOKEN_ENCRYPTION_KEY),
      status: "CONNECTED",
      installedAt: new Date(),
      // Orders created before the first connection are not imported automatically (approved 2026-09-07).
      ordersImportSince: store.ordersImportSince ?? new Date(),
      uninstalledAt: null,
      oauthState: null,
      oauthStateExpiresAt: null,
      lastError: null,
      lastErrorAt: null,
      apiVersion: env.SHOPIFY_API_VERSION,
    },
  });
  await logSync({
    storeId: store.id,
    direction: "INBOUND",
    entityType: "STORE",
    operation: reconnect ? "reconnect" : "install",
    status: "SUCCESS",
    message: reconnect ? `Store reconnected (${shopDomain})` : `Store connected (${shopDomain})`,
    newValue: token.scope ?? null,
  });
  await recordAudit({
    userId: actorId,
    action: reconnect ? "shopify_store.reconnected" : "shopify_store.connected",
    entityType: "ShopifyStore",
    entityId: store.id,
    newValues: { shopDomain, scopes: token.scope ?? null, expiring: !!token.expires_in },
  });
  return { storeId: store.id, shopDomain, reconnect };
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/** Marks a CONNECTED store as needing a manual reconnect and records why (Admin-visible). */
export async function markNeedsReauth(storeId: string, reason: string): Promise<void> {
  const r = await prisma.shopifyStore.updateMany({
    where: { id: storeId, status: "CONNECTED" },
    data: { status: "NEEDS_REAUTH", lastError: reason.slice(0, 1000), lastErrorAt: new Date() },
  });
  if (r.count > 0) {
    await logSync({ storeId, direction: "OUTBOUND", entityType: "STORE", operation: "auth", status: "FAILED", message: "Store needs to be reconnected", errorDetail: reason });
  }
}

/** Exchange the refresh token for a new access token. On failure the store becomes NEEDS_REAUTH. */
export async function refreshAccessToken(storeId: string) {
  const env = shopifyEnv();
  const store = await prisma.shopifyStore.findUnique({ where: { id: storeId } });
  if (!store) throw new ShopifyOAuthError("NOT_FOUND", "Store not found.");
  if (store.status !== "CONNECTED") throw new ShopifyOAuthError("NOT_CONNECTED", "Store is not connected.");
  if (!store.encRefreshToken) {
    await markNeedsReauth(storeId, "The access token expired and no refresh token is available.");
    throw new ShopifyOAuthError("REFRESH_FAILED", "Store needs to be reconnected.");
  }
  if (store.refreshTokenExpiresAt && store.refreshTokenExpiresAt.getTime() <= Date.now()) {
    await markNeedsReauth(storeId, "The refresh token expired (no API activity for too long).");
    throw new ShopifyOAuthError("REFRESH_FAILED", "Store needs to be reconnected.");
  }
  const creds = effectiveCredentials(store);
  let token: TokenResponse;
  try {
    token = await tokenRequest(
      store.shopDomain,
      { grant_type: "refresh_token", client_id: creds.clientId, client_secret: creds.clientSecret, refresh_token: decryptSecret(store.encRefreshToken, env.SHOPIFY_TOKEN_ENCRYPTION_KEY) },
      "REFRESH_FAILED",
    );
  } catch (err) {
    await markNeedsReauth(storeId, `Token refresh failed: ${describeError(err)}`);
    throw err;
  }
  return prisma.shopifyStore.update({
    where: { id: storeId },
    data: { ...encryptedTokenFields(token, env.SHOPIFY_TOKEN_ENCRYPTION_KEY, store), lastError: null, lastErrorAt: null },
  });
}

export type StoreTarget = { storeId: string; shopDomain: string; apiVersion: string; accessToken: string };

/**
 * A usable access token for a CONNECTED store, refreshing first when it is about to expire.
 * The decrypted token must not leave the server module that uses it.
 */
export async function getAccessToken(storeId: string): Promise<StoreTarget> {
  const env = shopifyEnv();
  let store = await prisma.shopifyStore.findUnique({ where: { id: storeId } });
  if (!store) throw new ShopifyOAuthError("NOT_FOUND", "Store not found.");
  if (store.status !== "CONNECTED" || !store.encAccessToken) throw new ShopifyOAuthError("NOT_CONNECTED", "Store is not connected. Use Connect / Reconnect first.");
  if (store.accessTokenExpiresAt && store.accessTokenExpiresAt.getTime() - Date.now() < ACCESS_TOKEN_REFRESH_MARGIN_MS) {
    store = await refreshAccessToken(storeId);
  }
  return { storeId, shopDomain: store.shopDomain, apiVersion: store.apiVersion, accessToken: decryptSecret(store.encAccessToken!, env.SHOPIFY_TOKEN_ENCRYPTION_KEY) };
}

/** Daily maintenance (D-031 layer 4): refresh every connected store so refresh tokens never age out. */
export async function refreshAllConnectedStores(): Promise<{ refreshed: string[]; failed: { storeId: string; error: string }[] }> {
  const stores = await prisma.shopifyStore.findMany({ where: { status: "CONNECTED", encRefreshToken: { not: null } }, select: { id: true } });
  const refreshed: string[] = [];
  const failed: { storeId: string; error: string }[] = [];
  for (const s of stores) {
    try {
      await refreshAccessToken(s.id);
      refreshed.push(s.id);
    } catch (err) {
      failed.push({ storeId: s.id, error: describeError(err) });
    }
  }
  return { refreshed, failed };
}

/** Remove install attempts that were never completed (abandoned “Add Shopify Store”). */
export async function cleanupAbandonedInstalls(olderThanMs = 24 * 3_600_000): Promise<number> {
  const r = await prisma.shopifyStore.deleteMany({ where: { status: "PENDING_INSTALL", installedAt: null, createdAt: { lt: new Date(Date.now() - olderThanMs) } } });
  return r.count;
}
