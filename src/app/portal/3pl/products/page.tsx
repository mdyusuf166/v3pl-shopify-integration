import type { Metadata } from "next";
import { PortalProducts } from "@/components/portal/portal-products";
import { requirePortalRole } from "@/server/auth/guards";

export const metadata: Metadata = { title: "Products & stock" };

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requirePortalRole("THREEPL_CLIENT");
  return <PortalProducts ownerId={user.ownerId} basePath="/portal/3pl/products" searchParams={await searchParams} intro="Your products stored in the warehouse and how much is available to fulfil orders." />;
}
