import Link from "next/link";
import { Building2, Handshake, Users } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { prisma } from "@/lib/prisma";

/** Compact counts for the admin dashboard (spec §54: Vendors, 3PL clients, users). */
export async function PartnerStats() {
  const [vendors, clients, staff, portalUsers] = await prisma.$transaction([
    prisma.owner.count({ where: { type: "VENDOR", status: "ACTIVE" } }),
    prisma.owner.count({ where: { type: "THREEPL_CLIENT", status: "ACTIVE" } }),
    prisma.user.count({ where: { role: { in: ["ADMIN", "WAREHOUSE", "SALES"] }, status: "ACTIVE" } }),
    prisma.user.count({ where: { role: { in: ["VENDOR", "THREEPL_CLIENT"] }, status: "ACTIVE" } }),
  ]);

  const tiles = [
    { label: "Active vendors", value: vendors, href: "/admin/vendors", icon: Handshake },
    { label: "Active 3PL clients", value: clients, href: "/admin/3pl-clients", icon: Building2 },
    { label: "Staff users", value: staff, href: "/admin/users?role=ALL", icon: Users },
    { label: "Portal users", value: portalUsers, href: "/admin/users", icon: Users },
  ];

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {tiles.map((t) => (
        <Link key={t.label} href={t.href} className="group">
          <Card className="transition-colors group-hover:border-foreground/30">
            <CardContent className="flex items-center justify-between pt-4">
              <div>
                <p className="text-sm text-muted-foreground">{t.label}</p>
                <p className="text-2xl font-semibold tabular-nums">{t.value}</p>
              </div>
              <t.icon className="size-5 text-muted-foreground" />
            </CardContent>
          </Card>
        </Link>
      ))}
    </div>
  );
}
