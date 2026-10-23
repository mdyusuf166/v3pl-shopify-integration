import { PageHeader } from "@/components/layout/page-header";
import { BalanceCard } from "@/components/finance/balance-card";
import { ChargesTable } from "@/components/finance/charges-table";
import { LedgerTable } from "@/components/finance/ledger-table";
import type { OwnerScope } from "@/server/services/finance";
import { listCharges, listLedgerEntries, scopedOwnerBalance, scopedVendorGrossMargin } from "@/server/services/finance";
import { GrossMarginCard } from "@/components/finance/gross-margin-card";

/** Portal finance page (vendor / 3PL): read-only balance, ledger and charges for the session owner only. */
export async function PortalFinance({ scope, basePath, ownerType, page = 1 }: { scope: OwnerScope; basePath: string; ownerType: "VENDOR" | "THREEPL_CLIENT"; page?: number }) {
  const [balance, ledger, charges, margin] = await Promise.all([scopedOwnerBalance(scope, null), listLedgerEntries(scope, { page }), listCharges(scope, { page: 1 }), ownerType === "VENDOR" ? scopedVendorGrossMargin(scope, null) : Promise.resolve(null)]);
  const orderHref = (id: string) => `${basePath}/orders/${id}`;
  return (
    <>
      <PageHeader title="Finance" description={ownerType === "VENDOR" ? "Payables V3PL has recorded for your received inventory, operational charges, payments, and the gross margin on your shipped products. An operational summary, not an invoice or accounting statement." : "Product value owed to you for shipped goods and operational charges owed to V3PL, kept separate, with payments on each side. An operational summary, not an invoice or accounting statement."} />
      <div className="grid gap-6 lg:grid-cols-2">
        <BalanceCard balance={balance} ownerLabel="you" ownerType={ownerType} />
        {margin && <GrossMarginCard margin={margin} ownerLabel="you" />}
      </div>
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Ledger</h2>
        <p className="text-sm text-muted-foreground">
          {ledger.total} entr{ledger.total === 1 ? "y" : "ies"} · page {ledger.page} of {ledger.pageCount}
        </p>
        <LedgerTable rows={ledger.items} orderHref={orderHref} ownerLabel="you" />
      </section>
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Charges</h2>
        <ChargesTable rows={charges.items} orderHref={orderHref} />
      </section>
    </>
  );
}
