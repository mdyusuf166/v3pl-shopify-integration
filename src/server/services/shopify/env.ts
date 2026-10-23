import { z } from "zod";

/**
 * Shopify-specific environment (Shopify session, D-027). Validated lazily like the core
 * groups in src/lib/env.ts so builds never need the values. Never import from the browser.
 *
 * Where each value comes from: docs/shopify-setup.md Part E.
 */

export const SHOPIFY_DEFAULT_API_VERSION = "2026-07";

/**
 * Minimum scopes (D-023; `write_orders` added for manual V3PL orders → Shopify, D-062; `read_customers` added for
 * the customer directory sync, D-065). Must match the Dev Dashboard configuration exactly.
 */
export const SHOPIFY_DEFAULT_SCOPES = [
  "read_orders",
  "write_orders",
  "write_merchant_managed_fulfillment_orders",
  "read_fulfillments",
  "read_products",
  "write_inventory",
  "read_locations",
  "read_customers",
].join(",");

const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

const schema = z.object({
  SHOPIFY_API_KEY: z.string().trim().min(1, "SHOPIFY_API_KEY (app Client ID) is required"),
  SHOPIFY_API_SECRET: z.string().trim().min(1, "SHOPIFY_API_SECRET (app Client secret) is required"),
  SHOPIFY_API_VERSION: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .trim()
      .regex(/^\d{4}-(01|04|07|10)$/, "SHOPIFY_API_VERSION must look like 2026-07")
      .default(SHOPIFY_DEFAULT_API_VERSION),
  ),
  SHOPIFY_SCOPES: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .trim()
      .transform((v) => v.split(",").map((s) => s.trim()).filter(Boolean).join(","))
      .default(SHOPIFY_DEFAULT_SCOPES),
  ),
  SHOPIFY_TOKEN_ENCRYPTION_KEY: z
    .string()
    .trim()
    .min(1, "SHOPIFY_TOKEN_ENCRYPTION_KEY is required")
    .refine((v) => {
      try {
        return Buffer.from(v, "base64").length === 32;
      } catch {
        return false;
      }
    }, "SHOPIFY_TOKEN_ENCRYPTION_KEY must be 32 bytes, base64 encoded (openssl rand -base64 32)"),
});

export type ShopifyEnv = z.infer<typeof schema>;

let cached: ShopifyEnv | null = null;

export function shopifyEnv(): ShopifyEnv {
  if (cached) return cached;
  const result = schema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Shopify environment is not configured (see docs/shopify-setup.md Part E):\n${issues}`);
  }
  cached = result.data;
  return cached;
}

export function isShopifyConfigured(): boolean {
  return schema.safeParse(process.env).success;
}

/** Names of missing/invalid Shopify variables — safe to show to Admin (names only). */
export function shopifyEnvProblems(): string[] {
  const result = schema.safeParse(process.env);
  if (result.success) return [];
  return [...new Set(result.error.issues.map((i) => String(i.path[0] ?? "")).filter(Boolean))];
}

/** Bearer secret for /api/cron/* (also honoured by /api/health diagnostics). Null when unset or too short. */
export function cronSecret(): string | null {
  const v = process.env.CRON_SECRET?.trim();
  return v && v.length >= 16 ? v : null;
}

/** Test seam: clear the cached env after mutating process.env. */
export function __resetShopifyEnvCache(): void {
  cached = null;
}
