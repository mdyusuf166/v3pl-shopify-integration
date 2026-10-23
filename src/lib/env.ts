import { z } from "zod";

/**
 * Server-side environment variables, validated lazily on first use so that
 * `next build` does not require secrets for pages that never touch them.
 * Never import this module from client components.
 *
 * Validation is split into independent groups (D-040): a malformed value in one
 * group (e.g. NEXT_PUBLIC_APP_URL) must never block the database or Firebase Admin.
 */

const databaseSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
});

const firebaseAdminSchema = z.object({
  FIREBASE_ADMIN_PROJECT_ID: z.string().trim().min(1, "FIREBASE_ADMIN_PROJECT_ID is required"),
  FIREBASE_ADMIN_CLIENT_EMAIL: z.string().trim().pipe(z.email("FIREBASE_ADMIN_CLIENT_EMAIL must be an email")),
  FIREBASE_ADMIN_PRIVATE_KEY: z
    .string()
    .min(1, "FIREBASE_ADMIN_PRIVATE_KEY is required")
    // Vercel / dotenv may store the PEM with literal "\n"; restore real newlines.
    .transform((v) => v.replace(/\\n/g, "\n").trim())
    .refine((v) => v.includes("-----BEGIN PRIVATE KEY-----"), "FIREBASE_ADMIN_PRIVATE_KEY must be a PEM private key"),
});

const cloudinarySchema = z.object({
  CLOUDINARY_CLOUD_NAME: z.string().trim().min(1, "CLOUDINARY_CLOUD_NAME is required"),
  CLOUDINARY_API_KEY: z.string().trim().min(1, "CLOUDINARY_API_KEY is required"),
  CLOUDINARY_API_SECRET: z.string().trim().min(1, "CLOUDINARY_API_SECRET is required"),
});

const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

const appSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /** Optional explicit override; on Vercel the canonical URL is derived from system variables (D-042). */
  NEXT_PUBLIC_APP_URL: z.preprocess(
    emptyToUndefined,
    z.string().trim().pipe(z.url("NEXT_PUBLIC_APP_URL must be a full URL, e.g. https://v3pl.vercel.app")).optional(),
  ),
  VERCEL_ENV: z.enum(["production", "preview", "development"]).optional(),
  /** Vercel system variable: shortest production domain, no scheme (e.g. v3pl.vercel.app). */
  VERCEL_PROJECT_PRODUCTION_URL: z.preprocess(emptyToUndefined, z.string().trim().optional()),
  /** Vercel system variable: this deployment's domain, no scheme. */
  VERCEL_URL: z.preprocess(emptyToUndefined, z.string().trim().optional()),
});

export type DatabaseEnv = z.infer<typeof databaseSchema>;
export type FirebaseAdminEnv = z.infer<typeof firebaseAdminSchema>;
export type AppEnv = z.infer<typeof appSchema>;
export type CloudinaryEnv = z.infer<typeof cloudinarySchema>;
export type ServerEnv = DatabaseEnv & FirebaseAdminEnv & AppEnv;

const cache = new Map<string, unknown>();

function load<T>(key: string, schema: z.ZodType<T, unknown>): T {
  const hit = cache.get(key);
  if (hit) return hit as T;
  const result = schema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid server environment (${key}). Check .env.local / Vercel variables (see .env.example):\n${issues}`);
  }
  cache.set(key, result.data);
  return result.data;
}

export function databaseEnv(): DatabaseEnv {
  return load("database", databaseSchema);
}

export function firebaseAdminEnv(): FirebaseAdminEnv {
  return load("firebaseAdmin", firebaseAdminSchema);
}

export function appEnv(): AppEnv {
  return load("app", appSchema);
}

/** Cloudinary is optional infrastructure (product images); validated only when used. */
export function cloudinaryEnv(): CloudinaryEnv {
  return load("cloudinary", cloudinarySchema);
}

export function isCloudinaryConfigured(): boolean {
  return cloudinarySchema.safeParse(process.env).success;
}

/**
 * Canonical public origin of this deployment, without trailing slash (D-042).
 * Resolution order:
 *   1. NEXT_PUBLIC_APP_URL when explicitly set (local dev, custom domains, self-hosting)
 *   2. Vercel production: https://VERCEL_PROJECT_PRODUCTION_URL (stable, e.g. https://v3pl.vercel.app)
 *   3. Vercel preview:    https://VERCEL_URL (per-deployment URL)
 *   4. http://localhost:3000
 * Server-side only; use it for absolute links, OAuth redirect URIs and webhook URLs.
 */
export function appUrl(): string {
  const env = appEnv();
  const pick =
    env.NEXT_PUBLIC_APP_URL ??
    (env.VERCEL_ENV === "production" && env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`
      : env.VERCEL_ENV === "preview" && env.VERCEL_URL
        ? `https://${env.VERCEL_URL}`
        : env.VERCEL_PROJECT_PRODUCTION_URL
          ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`
          : "http://localhost:3000");
  return pick.replace(/\/+$/, "");
}

/** Which source appUrl() resolved from — for health/diagnostics output. */
export function appUrlSource(): "NEXT_PUBLIC_APP_URL" | "VERCEL_PROJECT_PRODUCTION_URL" | "VERCEL_URL" | "default" {
  const env = appEnv();
  if (env.NEXT_PUBLIC_APP_URL) return "NEXT_PUBLIC_APP_URL";
  if (env.VERCEL_ENV === "preview" && env.VERCEL_URL) return "VERCEL_URL";
  if (env.VERCEL_PROJECT_PRODUCTION_URL) return "VERCEL_PROJECT_PRODUCTION_URL";
  return "default";
}

/** All groups at once (throws if any group is invalid). */
export function serverEnv(): ServerEnv {
  return { ...databaseEnv(), ...firebaseAdminEnv(), ...appEnv() };
}

/**
 * Names of environment variables that are missing or malformed, per group.
 * Contains variable names only — safe to expose in health output.
 */
export function describeEnvProblems(): { group: string; missing: string[]; invalid: string[] }[] {
  const groups: [string, z.ZodObject][] = [
    ["database", databaseSchema],
    ["firebaseAdmin", firebaseAdminSchema],
    ["app", appSchema],
  ];
  return groups
    .map(([group, schema]) => {
      const result = schema.safeParse(process.env);
      if (result.success) return { group, missing: [], invalid: [] };
      const missing = new Set<string>();
      const invalid = new Set<string>();
      for (const issue of result.error.issues) {
        const name = String(issue.path[0] ?? "");
        if (!name) continue;
        (process.env[name] ? invalid : missing).add(name);
      }
      return { group, missing: [...missing], invalid: [...invalid] };
    })
    .filter((g) => g.missing.length > 0 || g.invalid.length > 0);
}

export const isProduction = process.env.NODE_ENV === "production";
