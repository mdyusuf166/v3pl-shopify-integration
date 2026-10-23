import type { UserRole } from "@/generated/prisma/client";
import { isPortalRole, isStaffRole } from "@/lib/roles";

/** Directory scope derived from the session (D-060): staff see everything, portal users only their owner. */
export type CustomerScope = { ownerId: string | undefined };

export function customerScopeFor(user: { role: UserRole; ownerId: string | null } | null): CustomerScope | null {
  if (!user) return null;
  if (isStaffRole(user.role)) return { ownerId: undefined };
  if (isPortalRole(user.role) && user.ownerId) return { ownerId: user.ownerId };
  return null;
}
