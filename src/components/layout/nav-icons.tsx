"use client";

import type { LucideIcon } from "lucide-react";
import { ArrowLeftRight,
  BarChart3,
  Boxes,
  Building2,
  ClipboardList,
  Handshake,
  LayoutDashboard,
  PackageCheck,
  PackageOpen,
  Settings,
  ShoppingCart,
  Tags,
  Users,
  Warehouse,
 Contact, Wallet } from "lucide-react";
import type { NavIconName } from "@/config/navigation";

/** Client-side resolution of navigation icon names → Lucide components. */
export const NAV_ICONS: Record<NavIconName, LucideIcon> = {
  dashboard: LayoutDashboard,
  orders: ShoppingCart,
  customers: Contact,
  fulfillment: PackageCheck,
  inventory: Boxes,
  receiving: PackageOpen,
  transfers: ArrowLeftRight,
  products: Tags,
  warehouses: Warehouse,
  vendors: Handshake,
  threepl: Building2,
  finance: Wallet,
  reports: BarChart3,
  imports: ClipboardList,
  users: Users,
  settings: Settings,
};
