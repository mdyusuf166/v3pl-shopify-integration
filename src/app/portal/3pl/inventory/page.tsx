import type { Metadata } from "next";
import { PortalMovements } from "@/components/portal/portal-movements";
import { requirePortalRole } from "@/server/auth/guards";

export const metadata: Metadata = { title: "Inventory history" };

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requirePortalRole("THREEPL_CLIENT");
  return <PortalMovements ownerId={user.ownerId} basePath="/portal/3pl/inventory" searchParams={await searchParams} />;
}
