import type { UserRole } from "@/generated/prisma/client";

/**
 * Role helpers — pure functions, safe for client and server.
 * Roles are string literals mirrored from the Prisma enum (type-checked via
 * `satisfies`) so this module never pulls the Prisma runtime into the browser.
 */
export const STAFF_ROLES = ["ADMIN", "WAREHOUSE", "SALES"] as const satisfies readonly UserRole[];
export const PORTAL_ROLES = ["VENDOR", "THREEPL_CLIENT"] as const satisfies readonly UserRole[];

export type StaffRole = (typeof STAFF_ROLES)[number];
export type PortalRole = (typeof PORTAL_ROLES)[number];

export function isStaffRole(role: UserRole): role is StaffRole {
  return (STAFF_ROLES as readonly UserRole[]).includes(role);
}

export function isPortalRole(role: UserRole): role is PortalRole {
  return (PORTAL_ROLES as readonly UserRole[]).includes(role);
}

/** Where a user lands after signing in (D-010). */
export function homePathForRole(role: UserRole): string {
  switch (role) {
    case "VENDOR":
      return "/portal/vendor";
    case "THREEPL_CLIENT":
      return "/portal/3pl";
    default:
      return "/admin";
  }
}

export const ROLE_LABELS: Record<UserRole, string> = {
  ADMIN: "Administrator",
  WAREHOUSE: "Warehouse",
  SALES: "Sales",
  VENDOR: "Vendor",
  THREEPL_CLIENT: "3PL Client",
};
