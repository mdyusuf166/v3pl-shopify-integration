import type { Metadata } from "next";
import Link from "next/link";
import { ChevronRight, Receipt, Store } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/layout/page-header";
import { requireRole } from "@/server/auth/guards";
import { storeCounters } from "@/server/services/shopify/stores";
import { listChargeRules } from "@/server/services/charges";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  await requireRole("ADMIN");
  const shopify = await storeCounters().catch(() => ({ total: 0, connected: 0, attention: 0 }));
  const rules = await listChargeRules();
  const activeRules = rules.filter((r) => r.active).length;

  return (
    <>
      <PageHeader title="Settings" description="Platform configuration and connected sales channels." />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Link href="/admin/settings/shopify" className="group">
          <Card className="h-full transition-colors group-hover:border-primary/50">
            <CardContent className="flex items-start gap-4 pt-5">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Store className="size-5" />
              </span>
              <div className="min-w-0 flex-1 space-y-1">
                <p className="font-medium">Shopify Stores</p>
                <p className="text-sm text-muted-foreground">
                  {shopify.total === 0
                    ? "Connect the first store"
                    : `${shopify.connected} of ${shopify.total} connected${shopify.attention ? ` · ${shopify.attention} need attention` : ""}`}
                </p>
              </div>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
            </CardContent>
          </Card>
        </Link>
        <Link href="/admin/settings/charges" className="group">
          <Card className="h-full transition-colors group-hover:border-primary/50">
            <CardContent className="flex items-start gap-4 pt-5">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Receipt className="size-5" />
              </span>
              <div className="min-w-0 flex-1 space-y-1">
                <p className="font-medium">Operational Charges</p>
                <p className="text-sm text-muted-foreground">{rules.length === 0 ? "Define picking, packing, shipping and other charge rules" : `${activeRules} active of ${rules.length} rule${rules.length === 1 ? "" : "s"}`}</p>
              </div>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
            </CardContent>
          </Card>
        </Link>
      </div>
    </>
  );
}
