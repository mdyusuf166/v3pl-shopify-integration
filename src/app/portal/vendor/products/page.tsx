import type { Metadata } from "next";
import { PortalProducts } from "@/components/portal/portal-products";
import { requirePortalRole } from "@/server/auth/guards";

export const metadata: Metadata = { title: "Products & stock" };

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requirePortalRole("VENDOR");
  return <PortalProducts ownerId={user.ownerId} basePath="/portal/vendor/products" searchParams={await searchParams} intro="Your products and how much of each is in the warehouse." />;
}
