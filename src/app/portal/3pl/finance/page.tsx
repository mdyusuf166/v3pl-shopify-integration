import type { Metadata } from "next";
import { PortalFinance } from "@/components/finance/portal-finance";
import { customerScopeFor } from "@/lib/customer-scope";
import { requirePortalRole } from "@/server/auth/guards";

export const metadata: Metadata = { title: "Finance" };

export default async function PortalFinancePage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const user = await requirePortalRole("THREEPL_CLIENT");
  const sp = await searchParams;
  // Scope comes from the session (owner pinned to the user), never from the URL.
  const scope = customerScopeFor(user);
  if (!scope) return null;
  return <PortalFinance scope={scope} ownerType="THREEPL_CLIENT" basePath="/portal/3pl" page={Number(sp.page ?? 1)} />;
}
