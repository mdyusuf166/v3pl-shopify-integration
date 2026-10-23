import type { UserRole } from "@/generated/prisma/client";
import { STAFF_ROLES } from "@/lib/roles";

/**
 * Icon names are plain strings so this config can be built in Server Components
 * and passed to Client Components (functions cannot cross that boundary).
 * The client resolves them via NAV_ICONS in components/layout/nav-icons.tsx.
 */
export type NavIconName =
  | "dashboard"
  | "orders"
  | "customers"
  | "fulfillment"
  | "inventory"
  | "receiving"
  | "transfers"
  | "products"
  | "warehouses"
  | "vendors"
  | "threepl"
  | "reports"
  | "imports"
  | "users"
  | "settings" | "finance";

export type NavItem = {
  label: string;
  href: string;
  icon: NavIconName;
  /** Staff roles allowed to see this item. Server guards enforce the same rule per route. */
  roles: readonly UserRole[];
  /** Set while the module is not built yet: shown disabled with the phase it arrives in (D-035). */
  comingSoonPhase?: number;
};

export type NavSection = { title: string; items: NavItem[] };

const ALL_STAFF = STAFF_ROLES;
const ADMIN_ONLY = ["ADMIN"] as const;
const ADMIN_WAREHOUSE = ["ADMIN", "WAREHOUSE"] as const;

/**
 * Admin-area navigation (D-010: all internal staff use /admin with role-based
 * visibility). Items become live as their phase is delivered.
 */
export const ADMIN_NAV: NavSection[] = [
  {
    title: "Overview",
    items: [{ label: "Dashboard", href: "/admin", icon: "dashboard", roles: ALL_STAFF }],
  },
  {
    title: "Operations",
    items: [
      { label: "Orders", href: "/admin/orders", icon: "orders", roles: ALL_STAFF },
      { label: "Customers", href: "/admin/customers", icon: "customers", roles: ["ADMIN", "SALES"] as const },
      { label: "Fulfillment", href: "/admin/fulfillment", icon: "fulfillment", roles: ADMIN_WAREHOUSE },
      { label: "Inventory", href: "/admin/inventory", icon: "inventory", roles: ALL_STAFF },
      { label: "Receiving", href: "/admin/receiving", icon: "receiving", roles: ADMIN_WAREHOUSE },
      { label: "Transfers", href: "/admin/transfers", icon: "transfers", roles: ADMIN_WAREHOUSE },
    ],
  },
  {
    title: "Catalog",
    items: [
      { label: "Products", href: "/admin/products", icon: "products", roles: ALL_STAFF },
      { label: "Warehouses", href: "/admin/warehouses", icon: "warehouses", roles: ADMIN_WAREHOUSE },
    ],
  },
  {
    title: "Partners",
    items: [
      { label: "Vendors", href: "/admin/vendors", icon: "vendors", roles: ADMIN_ONLY },
      { label: "3PL Clients", href: "/admin/3pl-clients", icon: "threepl", roles: ADMIN_ONLY },
      { label: "Finance", href: "/admin/finance", icon: "finance", roles: ADMIN_ONLY },
    ],
  },
  {
    title: "Insights",
    items: [
      { label: "Reports", href: "/admin/reports", icon: "reports", roles: ADMIN_ONLY },
      { label: "Imports & Exports", href: "/admin/imports", icon: "imports", roles: ["ADMIN", "SALES"] as const },
    ],
  },
  {
    title: "Administration",
    items: [
      { label: "Users", href: "/admin/users", icon: "users", roles: ADMIN_ONLY },
      { label: "Settings", href: "/admin/settings", icon: "settings", roles: ADMIN_ONLY },
    ],
  },
];

export function navForRole(role: UserRole): NavSection[] {
  return ADMIN_NAV.map((section) => ({
    ...section,
    items: section.items.filter((item) => item.roles.includes(role)),
  })).filter((section) => section.items.length > 0);
}
