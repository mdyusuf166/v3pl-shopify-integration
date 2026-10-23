// Prisma 7 configuration. Loads .env.local first (Next.js convention), then .env.
import { config as loadEnv } from "dotenv";
import { defineConfig } from "prisma/config";

loadEnv({ path: ".env.local" });
loadEnv();

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // Migrations must use a direct (non-pooled) connection on Neon.
    // The application itself uses DATABASE_URL (pooled) via src/lib/prisma.ts.
    url: process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? "",
  },
});
