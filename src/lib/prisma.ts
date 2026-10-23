import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { databaseEnv, isProduction } from "@/lib/env";

/**
 * Single PrismaClient per process (reused across hot reloads in development).
 * Constructed lazily so importing this module never requires DATABASE_URL at
 * build time — only the first query does.
 */
const globalForPrisma = globalThis as unknown as { __v3plPrisma?: PrismaClient };

function createClient(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: databaseEnv().DATABASE_URL });
  return new PrismaClient({
    adapter,
    log: isProduction ? ["error"] : ["warn", "error"],
  });
}

function getClient(): PrismaClient {
  if (!globalForPrisma.__v3plPrisma) {
    globalForPrisma.__v3plPrisma = createClient();
  }
  return globalForPrisma.__v3plPrisma;
}

export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    const client = getClient();
    const value = Reflect.get(client, prop, client);
    return typeof value === "function" ? value.bind(client) : value;
  },
});

/** Cheap connectivity probe used by the dashboard system-status card. */
export async function checkDatabaseConnection(): Promise<{ ok: true } | { ok: false; error: string; code: string }> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true };
  } catch (err) {
    const e = err as { code?: unknown; errorCode?: unknown; name?: unknown };
    const code = [e?.code, e?.errorCode, e?.name].find((c) => typeof c === "string") as string | undefined;
    return { ok: false, error: err instanceof Error ? err.message : String(err), code: code ?? "UNKNOWN" };
  }
}
