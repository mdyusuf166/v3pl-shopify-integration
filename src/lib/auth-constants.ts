/**
 * Auth constants safe to import anywhere (proxy/edge, server, client).
 * No Firebase or Prisma imports allowed in this module.
 */
export const SESSION_COOKIE = "v3pl_session";

/** Session cookie lifetime. Firebase allows 5 minutes .. 14 days. */
export const SESSION_TTL_SECONDS = 5 * 24 * 60 * 60; // 5 days

export const STAFF_LOGIN_PATH = "/admin/login";
export const PORTAL_LOGIN_PATH = "/user/login";
