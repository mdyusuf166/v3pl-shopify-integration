import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native/server-only packages must not be bundled by the client/edge compilers.
  serverExternalPackages: ["firebase-admin", "@prisma/client", "@prisma/adapter-pg", "pg"],
  poweredByHeader: false,
};

export default nextConfig;
