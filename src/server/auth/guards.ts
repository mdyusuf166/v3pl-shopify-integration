import "server-only";
import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import type { UserRole } from "@/generated/prisma/client";
import { PORTAL_LOGIN_PATH, STAFF_LOGIN_PATH } from "@/lib/auth-constants";
import { homePathForRole, isPortalRole, isStaffRole } from "@/lib/roles";
import { getCurrentUser, type CurrentUser } from "@/server/auth/current-user";

/**
 * Server-side route guards. Every protected layout/page/route handler calls one
 * of these. UI-level hiding is never relied upon (spec §56).
 */

/** Any active internal staff user (ADMIN / WAREHOUSE / SALES). Redirects otherwise. */
export async function requireStaff(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect(STAFF_LOGIN_PATH);
  if (!isStaffRole(user.role)) redirect(homePathForRole(user.role));
  return user;
}

/** Staff user holding one of the given roles. Others are sent back to the dashboard. */
export async function requireRole(...roles: UserRole[]): Promise<CurrentUser> {
  const user = await requireStaff();
  if (!roles.includes(user.role)) redirect("/admin?forbidden=1");
  return user;
}

/** Any active portal user (VENDOR / THREEPL_CLIENT). */
export async function requirePortalUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect(PORTAL_LOGIN_PATH);
  if (!isPortalRole(user.role)) redirect(homePathForRole(user.role));
  return user;
}

export type PortalUser = CurrentUser & { ownerId: string };

/**
 * Portal user of one exact role; the other portal role is redirected to its own home.
 * Returns a non-null `ownerId` — the ONLY value portal queries may scope by.
 * IDs from URLs or request bodies are never used for owner scoping (spec §56).
 */
export async function requirePortalRole(role: "VENDOR" | "THREEPL_CLIENT"): Promise<PortalUser> {
  const user = await requirePortalUser();
  if (user.role !== role) redirect(homePathForRole(user.role));
  if (!user.ownerId) redirect(PORTAL_LOGIN_PATH); // cannot happen (DB CHECK constraint) — defensive
  return { ...user, ownerId: user.ownerId };
}

// --- API route handlers -----------------------------------------------------

export type ApiAuthResult = { user: CurrentUser; error?: undefined } | { user?: undefined; error: NextResponse };

/**
 * For Route Handlers: returns the user or a ready-to-return 401/403 response.
 * `roles` empty = any active user.
 */
export async function authorizeApi(...roles: UserRole[]): Promise<ApiAuthResult> {
  const user = await getCurrentUser();
  if (!user) {
    return { error: NextResponse.json({ error: "unauthenticated" }, { status: 401 }) };
  }
  if (roles.length > 0 && !roles.includes(user.role)) {
    return { error: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  }
  return { user };
}
