import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Pure cryptographic helpers for the Shopify integration. No database, no network.
 *
 * - Token encryption at rest: AES-256-GCM (D-017/D-022). Blob format: `v1.<iv>.<tag>.<ciphertext>`
 *   (base64url parts). A random 12-byte IV per encryption; the auth tag protects integrity.
 * - Webhook verification: HMAC-SHA256 of the raw body, base64, key = app client secret.
 * - OAuth callback verification: HMAC-SHA256 hex of the sorted query string (hmac removed).
 */

const ENC_VERSION = "v1";

function keyFromBase64(keyB64: string): Buffer {
  const key = Buffer.from(keyB64, "base64");
  if (key.length !== 32) throw new Error("Encryption key must be 32 bytes (base64).");
  return key;
}

export function encryptSecret(plain: string, keyB64: string): string {
  const key = keyFromBase64(keyB64);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [ENC_VERSION, iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(".");
}

export function decryptSecret(blob: string, keyB64: string): string {
  const [version, ivB64, tagB64, ctB64] = blob.split(".");
  if (version !== ENC_VERSION || !ivB64 || !tagB64 || !ctB64) throw new Error("Unrecognised encrypted value.");
  const key = keyFromBase64(keyB64);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64url")), decipher.final()]).toString("utf8");
}

/** Constant-time string comparison (different lengths → false, still constant-time on the compared part). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    // Compare against itself to keep timing uniform, then fail.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

export function hmacSha256Base64(secret: string, data: string | Buffer): string {
  return createHmac("sha256", secret).update(data).digest("base64");
}

export function hmacSha256Hex(secret: string, data: string | Buffer): string {
  return createHmac("sha256", secret).update(data).digest("hex");
}

/** Shopify webhook: `X-Shopify-Hmac-Sha256` = base64(HMAC-SHA256(raw body, client secret)). */
export function verifyWebhookHmac(rawBody: string | Buffer, headerValue: string | null | undefined, secret: string): boolean {
  if (!headerValue || !secret) return false;
  return safeEqual(hmacSha256Base64(secret, rawBody), headerValue.trim());
}

/**
 * Shopify OAuth callback / app-link verification: remove `hmac` (and legacy `signature`),
 * percent-encode `%`, `&`, `=` in keys and `%`, `&` in values, sort by key, join `k=v` with `&`,
 * then HMAC-SHA256 hex with the client secret.
 */
export function oauthQueryMessage(params: URLSearchParams): string {
  const encKey = (s: string) => s.replace(/%/g, "%25").replace(/&/g, "%26").replace(/=/g, "%3D");
  const encVal = (s: string) => s.replace(/%/g, "%25").replace(/&/g, "%26");
  const pairs: [string, string][] = [];
  params.forEach((value, key) => {
    if (key === "hmac" || key === "signature") return;
    pairs.push([encKey(key), encVal(value)]);
  });
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}

export function verifyOAuthQueryHmac(params: URLSearchParams, secret: string): boolean {
  const provided = params.get("hmac");
  if (!provided || !secret) return false;
  return safeEqual(hmacSha256Hex(secret, oauthQueryMessage(params)), provided.toLowerCase());
}

/** Shopify's own rule for the `shop` parameter: `<handle>.myshopify.com`, lower-case letters, digits, hyphens. */
export const SHOP_DOMAIN_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

/**
 * Accepts "casabella", "casabella.myshopify.com", "https://casabella.myshopify.com/admin"
 * and returns the canonical `casabella.myshopify.com`, or null when it is not a valid shop domain.
 */
export function normalizeShopDomain(input: string): string | null {
  let s = input.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^https?:\/\//, "").split("/")[0].split("?")[0].split("#")[0];
  if (!s.includes(".")) s = `${s}.myshopify.com`;
  return SHOP_DOMAIN_RE.test(s) && s.length <= 120 ? s : null;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
