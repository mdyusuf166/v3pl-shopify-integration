import type { Metadata } from "next";
import { PortalMovements } from "@/components/portal/portal-movements";
import { requirePortalRole } from "@/server/auth/guards";

export const metadata: Metadata = { title: "Inventory history" };

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requirePortalRole("VENDOR");
  return <PortalMovements ownerId={user.ownerId} basePath="/portal/vendor/inventory" searchParams={await searchParams} />;
}
