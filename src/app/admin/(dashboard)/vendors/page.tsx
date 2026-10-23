import type { Metadata } from "next";
import { OwnersList } from "@/components/owners/owners-list";
import { OWNER_TYPE_META } from "@/lib/validation/owners";
import { requireRole } from "@/server/auth/guards";

export const metadata: Metadata = { title: OWNER_TYPE_META.VENDOR.plural };

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireRole("ADMIN");
  return <OwnersList type="VENDOR" searchParams={await searchParams} />;
}
