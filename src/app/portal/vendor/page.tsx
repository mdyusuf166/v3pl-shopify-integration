import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PortalDashboard } from "@/components/portal/portal-dashboard";
import { requirePortalRole } from "@/server/auth/guards";
import { getOwner } from "@/server/services/owners";

export const metadata: Metadata = { title: "Vendor Portal" };

export default async function PortalHome() {
  const user = await requirePortalRole("VENDOR");
  // Scope comes from the session (user.ownerId), never from the URL.
  const owner = await getOwner(user.ownerId, "VENDOR");
  if (!owner) notFound();
  return <PortalDashboard owner={owner} userName={user.name} basePath="/portal/vendor" canCreateOrders={false} />;
}
