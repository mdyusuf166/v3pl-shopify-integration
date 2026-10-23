import { PortalShell } from "@/components/layout/portal-shell";
import { ROLE_LABELS } from "@/lib/roles";
import { requirePortalRole } from "@/server/auth/guards";
import { getOwner } from "@/server/services/owners";

export const dynamic = "force-dynamic";

export default async function VendorPortalLayout({ children }: { children: React.ReactNode }) {
  const user = await requirePortalRole("VENDOR");
  const owner = await getOwner(user.ownerId, "VENDOR");
  return (
    <PortalShell
      user={{ name: user.name, email: user.email, roleLabel: ROLE_LABELS[user.role] }}
      homeHref="/portal/vendor"
      portalName={owner?.businessName ?? "Vendor Portal"}
      nav={[
        { label: "Overview", href: "/portal/vendor" },
        { label: "Products & stock", href: "/portal/vendor/products" },
        { label: "Orders", href: "/portal/vendor/orders" },
        { label: "Customers", href: "/portal/vendor/customers" },
        { label: "Shipments", href: "/portal/vendor/shipments" },
        { label: "Returns", href: "/portal/vendor/returns" },
        { label: "Inventory history", href: "/portal/vendor/inventory" },
        { label: "Reports", href: "/portal/vendor/reports" },
        { label: "Finance", href: "/portal/vendor/finance" },
      ]}
    >
      {children}
    </PortalShell>
  );
}
