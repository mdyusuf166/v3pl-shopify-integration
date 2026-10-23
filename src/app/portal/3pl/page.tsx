import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PortalDashboard } from "@/components/portal/portal-dashboard";
import { requirePortalRole } from "@/server/auth/guards";
import { getOwner } from "@/server/services/owners";

export const metadata: Metadata = { title: "3PL Portal" };

export default async function PortalHome() {
  const user = await requirePortalRole("THREEPL_CLIENT");
  // Scope comes from the session (user.ownerId), never from the URL.
  const owner = await getOwner(user.ownerId, "THREEPL_CLIENT");
  if (!owner) notFound();
  return <PortalDashboard owner={owner} userName={user.name} basePath="/portal/3pl" canCreateOrders={true} />;
}
