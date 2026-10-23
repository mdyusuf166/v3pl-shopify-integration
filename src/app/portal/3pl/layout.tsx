import { PortalShell } from "@/components/layout/portal-shell";
import { ROLE_LABELS } from "@/lib/roles";
import { requirePortalRole } from "@/server/auth/guards";
import { getOwner } from "@/server/services/owners";

export const dynamic = "force-dynamic";

export default async function ThreePlPortalLayout({ children }: { children: React.ReactNode }) {
  const user = await requirePortalRole("THREEPL_CLIENT");
  const owner = await getOwner(user.ownerId, "THREEPL_CLIENT");
  return (
    <PortalShell
      user={{ name: user.name, email: user.email, roleLabel: ROLE_LABELS[user.role] }}
      homeHref="/portal/3pl"
      portalName={owner?.businessName ?? "3PL Portal"}
      nav={[
        { label: "Overview", href: "/portal/3pl" },
        { label: "Products & stock", href: "/portal/3pl/products" },
        { label: "Orders", href: "/portal/3pl/orders" },
        { label: "Customers", href: "/portal/3pl/customers" },
        { label: "Shipments", href: "/portal/3pl/shipments" },
        { label: "Returns", href: "/portal/3pl/returns" },
        { label: "Inventory history", href: "/portal/3pl/inventory" },
        { label: "Reports", href: "/portal/3pl/reports" },
        { label: "Finance", href: "/portal/3pl/finance" },
      ]}
    >
      {children}
    </PortalShell>
  );
}
