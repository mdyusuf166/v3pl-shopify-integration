import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/layout/page-header";
import { BalanceCard } from "@/components/finance/balance-card";
import { ChargesTable } from "@/components/finance/charges-table";
import { LedgerTable } from "@/components/finance/ledger-table";
import { SettlementForm } from "@/components/finance/settlement-form";
import { GrossMarginCard } from "@/components/finance/gross-margin-card";
import { VendorPayableForm } from "@/components/finance/vendor-payable-form";
import { OWNER_TYPE_META } from "@/lib/validation/owners";
import { requireRole } from "@/server/auth/guards";
import { listCharges, listLedgerEntries, ownerBalance, receivingAllocations, vendorGrossMargin } from "@/server/services/finance";
import { getOwner } from "@/server/services/owners";

export const metadata: Metadata = { title: "Owner ledger" };

export default async function OwnerFinancePage({ params, searchParams }: { params: Promise<{ ownerId: string }>; searchParams: Promise<{ page?: string; cpage?: string }> }) {
  await requireRole("ADMIN");
  const { ownerId } = await params;
  const sp = await searchParams;
  const owner = await getOwner(ownerId);
  if (!owner) notFound();
  const scope = { ownerId: undefined }; // admin: unrestricted; the owner comes from the admin's URL
  const isVendor = owner.type === "VENDOR";
  const [balance, ledger, charges, allocations, margin] = await Promise.all([ownerBalance(owner.id), listLedgerEntries(scope, { ownerId: owner.id, page: Number(sp.page ?? 1) }), listCharges(scope, { ownerId: owner.id, page: Number(sp.cpage ?? 1) }), isVendor ? receivingAllocations(owner.id) : Promise.resolve([]), isVendor ? vendorGrossMargin(owner.id) : Promise.resolve(null)]);
  const meta = OWNER_TYPE_META[owner.type];
  const orderHref = (id: string) => `/admin/orders/${id}`;
  return (
    <>
      <div>
        <Link href="/admin/finance" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ChevronLeft className="size-4" /> Finance
        </Link>
      </div>
      <PageHeader
        title={owner.businessName}
        description={`${meta.singular} · ${owner.code} · settlement ledger`}
        actions={
          <>
            <Badge variant="outline">{owner.chargesEnabled ? "Charges enabled" : "Charges off"}</Badge>
            <Link href={`${meta.basePath}/${owner.id}`} className="text-sm text-muted-foreground underline-offset-2 hover:underline">
              Profile
            </Link>
          </>
        }
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-1">
          <BalanceCard balance={balance} ownerLabel={meta.singular.toLowerCase()} ownerType={owner.type} />
          {margin && <GrossMarginCard margin={margin} />}
        </div>
        <div className="space-y-6 lg:col-span-2">
          {isVendor && <VendorPayableForm ownerId={owner.id} ownerName={owner.businessName} rows={allocations.map((a) => ({ receivingItemId: a.receivingItemId, reference: a.reference, receivedAt: a.receivedAt.toISOString(), warehouse: a.warehouse, sku: a.sku, title: a.title, received: a.received, allocated: a.allocated, remaining: a.remaining, wholesalePrice: a.wholesalePrice?.toString() ?? null }))} />}
          <SettlementForm ownerId={owner.id} ownerName={owner.businessName} />
        </div>
      </div>
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Ledger</h2>
        <p className="text-sm text-muted-foreground">
          {ledger.total} entr{ledger.total === 1 ? "y" : "ies"} · page {ledger.page} of {ledger.pageCount}
        </p>
        <LedgerTable rows={ledger.items} orderHref={orderHref} ownerLabel={meta.singular.toLowerCase()} />
        {ledger.pageCount > 1 && (
          <div className="flex gap-2 text-sm">
            {ledger.page > 1 && <Link href={`?page=${ledger.page - 1}`}>← Newer</Link>}
            {ledger.page < ledger.pageCount && <Link href={`?page=${ledger.page + 1}`}>Older →</Link>}
          </div>
        )}
      </section>
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Charges</h2>
        <p className="text-sm text-muted-foreground">{charges.total} charge{charges.total === 1 ? "" : "s"} recorded; each one also appears in the ledger above.</p>
        <ChargesTable rows={charges.items} orderHref={orderHref} />
      </section>
    </>
  );
}
