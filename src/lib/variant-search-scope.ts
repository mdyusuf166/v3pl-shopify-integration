import type { UserRole } from "@/generated/prisma/client";
import { isPortalRole, isStaffRole } from "@/lib/roles";

/**
 * Who may search the catalogue, and within which owner (QA UI-06 / SEC-03).
 * - Staff: any owner; the requested filter (if any) is honoured.
 * - Portal users (vendor / 3PL client): always their own owner — the client-supplied id is ignored.
 * - No session / no owner: refused. Callers must return a normal failure, never redirect, because a
 *   redirect from a server action navigates the browser away from the form being filled in.
 */
export type VariantSearchScope = { ok: true; ownerId: string | undefined } | { ok: false; reason: "unauthenticated" | "forbidden" };

export function variantSearchScope(user: { role: UserRole; ownerId: string | null } | null, requestedOwnerId?: string): VariantSearchScope {
  if (!user) return { ok: false, reason: "unauthenticated" };
  if (isStaffRole(user.role)) return { ok: true, ownerId: requestedOwnerId || undefined };
  if (isPortalRole(user.role) && user.ownerId) return { ok: true, ownerId: user.ownerId };
  return { ok: false, reason: "forbidden" };
}
