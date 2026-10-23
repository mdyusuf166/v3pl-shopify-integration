import { NextResponse, type NextRequest } from "next/server";
import { checkDatabaseConnection } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/health — unauthenticated liveness/readiness probe.
 * Reports the runtime Node.js version (the firebase-admin → jwks-rsa → jose chain
 * needs Node ≥ 22.12 / 24 for require(esm), D-039) and database reachability.
 * Never returns secrets or error details.
 *
 * With `Authorization: Bearer <CRON_SECRET>` it adds operator diagnostics:
 * which environment variables are present (names only), env-validation errors,
 * the database error message, and whether Firebase Admin loads and initialises.
 */
export async function GET(req: NextRequest) {
  const db = await checkDatabaseConnection();
  const checks = await publicChecks(db);
  const body: Record<string, unknown> = {
    status: db.ok && checks.firebaseAdmin.ok && checks.serverEnv.ok ? "ok" : "degraded",
    node: process.version,
    env: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
    database: db.ok ? "connected" : "unavailable",
    appUrl: checks.appUrl,
    checks,
    time: new Date().toISOString(),
  };

  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization") ?? "";
  if (secret && secret.length >= 16 && auth === `Bearer ${secret}`) {
    body.diagnostics = await diagnostics(db);
  }

  return NextResponse.json(body, { status: db.ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}

const ENV_NAMES = [
  "DATABASE_URL",
  "DIRECT_URL",
  "FIREBASE_ADMIN_PROJECT_ID",
  "FIREBASE_ADMIN_CLIENT_EMAIL",
  "FIREBASE_ADMIN_PRIVATE_KEY",
  "NEXT_PUBLIC_FIREBASE_API_KEY",
  "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
  "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
  "NEXT_PUBLIC_FIREBASE_APP_ID",
  "NEXT_PUBLIC_APP_URL",
  "CLOUDINARY_CLOUD_NAME",
  "SHOPIFY_API_KEY",
  "SHOPIFY_TOKEN_ENCRYPTION_KEY",
  "CRON_SECRET",
] as const;

/** Error *code* only (e.g. P1001, ERR_REQUIRE_ESM, auth/argument-error) — safe to expose publicly. */
function errCode(err: unknown): string {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  const parts: string[] = [];
  while (cur && typeof cur === "object" && !seen.has(cur) && parts.length < 4) {
    seen.add(cur);
    const e = cur as { code?: unknown; errorCode?: unknown; name?: unknown; message?: unknown; cause?: unknown };
    const code = [e.code, e.errorCode].find((c) => typeof c === "string" && c.length <= 40) as string | undefined;
    const msg = typeof e.message === "string" ? e.message : "";
    // Next.js wraps external-module failures in a plain Error whose message embeds the inner code.
    const embedded = msg.match(/\[(ERR_[A-Z_]+)\]/)?.[1] ?? msg.match(/code: '([A-Z_]+)'/)?.[1];
    const missing = msg.match(/Cannot find (?:module|package) '([^']+)'/)?.[1];
    parts.push(code ?? embedded ?? (missing ? `MODULE_NOT_FOUND(${missing.split("/node_modules/").pop()})` : typeof e.name === "string" ? e.name : "UNKNOWN"));
    cur = e.cause;
  }
  return parts.join(" <- ") || "UNKNOWN";
}

/**
 * Public, secret-free readiness checks: which required env names are missing, the
 * database error code, and whether the Firebase Admin module loads on this runtime.
 */
async function publicChecks(db: Awaited<ReturnType<typeof checkDatabaseConnection>>) {
  const { describeEnvProblems } = await import("@/lib/env");
  const problems = describeEnvProblems();
  const serverEnvOk = problems.length === 0;

  let firebaseAdmin: { ok: boolean; code?: string } = { ok: true };
  try {
    const mod = await import("@/lib/firebase/admin");
    if (!problems.some((p) => p.group === "firebaseAdmin")) {
      try {
        await mod.firebaseAdminAuth().verifySessionCookie("probe", false);
      } catch (err) {
        const code = errCode(err);
        firebaseAdmin = code.startsWith("auth/") ? { ok: true, code } : { ok: false, code };
      }
    }
  } catch (err) {
    firebaseAdmin = { ok: false, code: errCode(err) };
  }

  let appUrl: { url: string; source: string } | { error: string } = { error: "unresolved" };
  try {
    const envMod = await import("@/lib/env");
    appUrl = { url: envMod.appUrl(), source: envMod.appUrlSource() };
  } catch {
    appUrl = { error: "invalid app env" };
  }

  return {
    serverEnv: { ok: serverEnvOk, problems },
    database: db.ok ? { ok: true } : { ok: false, code: db.code },
    firebaseAdmin,
    appUrl,
  };
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`.slice(0, 600);
  return String(err).slice(0, 600);
}

async function diagnostics(db: Awaited<ReturnType<typeof checkDatabaseConnection>>) {
  const envPresent: Record<string, boolean | string> = {};
  for (const name of ENV_NAMES) {
    const v = process.env[name];
    envPresent[name] = v ? `set (${v.length} chars)` : false;
  }
  const pk = process.env.FIREBASE_ADMIN_PRIVATE_KEY ?? "";
  envPresent["FIREBASE_ADMIN_PRIVATE_KEY.format"] = pk
    ? `${pk.includes("\\n") ? "escaped-newlines" : pk.includes("\n") ? "real-newlines" : "single-line"}; header=${pk.replace(/\\n/g, "\n").includes("-----BEGIN PRIVATE KEY-----")}`
    : "missing";

  let serverEnv: string = "ok";
  try {
    (await import("@/lib/env")).serverEnv();
  } catch (err) {
    serverEnv = errMessage(err);
  }

  let firebaseAdmin: string = "ok";
  try {
    const mod = await import("@/lib/firebase/admin");
    const auth = mod.firebaseAdminAuth();
    try {
      await auth.verifySessionCookie("not-a-cookie", false);
    } catch (err) {
      // Expected: an auth/argument error proves the module loaded and initialised.
      const code = (err as { code?: string }).code ?? "";
      firebaseAdmin = code.startsWith("auth/") ? `ok (probe rejected as expected: ${code})` : errMessage(err);
    }
  } catch (err) {
    firebaseAdmin = errMessage(err);
  }

  return {
    envPresent,
    serverEnv,
    database: db.ok ? "ok" : db.error.slice(0, 600),
    firebaseAdmin,
  };
}
