import Link from "next/link";
import { Plus, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/common/empty-state";
import { NativeSelect } from "@/components/common/native-select";
import { Pagination } from "@/components/common/pagination";
import { SearchFilterBar } from "@/components/common/search-filter-bar";
import { PageHeader } from "@/components/layout/page-header";
import { formatDateTime } from "@/lib/format";
import { CUSTOMER_SOURCE_LABEL, customerListQuerySchema } from "@/lib/validation/customers";
import { listCustomers, type CustomerScope } from "@/server/services/customers";

type Props = {
  /** ALWAYS derived from the session by the page — never from the URL. */
  scope: CustomerScope;
  basePath: string;
  searchParams: Record<string, string | string[] | undefined>;
  /** Staff only: owner filter options. */
  owners?: { id: string; businessName: string; type: "VENDOR" | "THREEPL_CLIENT" }[];
  canCreate: boolean;
  description: string;
};

/** Shared customer list behind /admin/customers and the portals' Customers tab (D-060). */
export async function CustomerList({ scope, basePath, searchParams, owners, canCreate, description }: Props) {
  const query = customerListQuerySchema.parse({ q: typeof searchParams.q === "string" ? searchParams.q : undefined, ownerId: typeof searchParams.ownerId === "string" && searchParams.ownerId ? searchParams.ownerId : undefined, page: typeof searchParams.page === "string" ? searchParams.page : undefined });
  const result = await listCustomers(scope, { q: query.q, ownerId: scope.ownerId ? undefined : query.ownerId, page: query.page });
  const hrefFor = (page: number) => {
    const p = new URLSearchParams();
    if (query.q) p.set("q", query.q);
    if (query.ownerId) p.set("ownerId", query.ownerId);
    if (page > 1) p.set("page", String(page));
    const s = p.toString();
    return `${basePath}${s ? `?${s}` : ""}`;
  };
  const newButton = canCreate ? (
    <Button render={<Link href={`${basePath}/new`} />}>
      <Plus /> Add customer
    </Button>
  ) : null;

  return (
    <>
      <PageHeader title="Customers" description={description} actions={newButton} />
      <SearchFilterBar q={query.q} placeholder="Search name, email or phone…">
        {owners && (
          <NativeSelect name="ownerId" defaultValue={query.ownerId ?? ""} aria-label="Belongs to" className="w-52">
            <option value="">Everyone</option>
            <option value="company">Company (V3PL)</option>
            {owners.filter((o) => o.type === "VENDOR").length > 0 && (
              <optgroup label="Vendors">
                {owners
                  .filter((o) => o.type === "VENDOR")
                  .map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.businessName}
                    </option>
                  ))}
              </optgroup>
            )}
            {owners.filter((o) => o.type === "THREEPL_CLIENT").length > 0 && (
              <optgroup label="3PL clients">
                {owners
                  .filter((o) => o.type === "THREEPL_CLIENT")
                  .map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.businessName}
                    </option>
                  ))}
              </optgroup>
            )}
          </NativeSelect>
        )}
      </SearchFilterBar>
      {result.items.length === 0 ? (
        <EmptyState icon={Users} title={query.q ? "No customers match your search" : "No customers yet"} description={query.q ? "Try another name, email or phone number." : "Customers appear here when you add them or save them from an order."} action={!query.q ? newButton ?? undefined : undefined} />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Customer</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead className="hidden md:table-cell">Ships to</TableHead>
                {owners && <TableHead className="hidden lg:table-cell">Belongs to</TableHead>}
                <TableHead className="text-right">Orders</TableHead>
                <TableHead className="hidden md:table-cell">Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.items.map((c) => (
                <TableRow key={c.id}>
                  <TableCell>
                    <Link href={`${basePath}/${c.id}`} className="font-medium hover:underline">
                      {c.name}
                    </Link>
                    <div className="text-xs text-muted-foreground">{CUSTOMER_SOURCE_LABEL[c.source] ?? c.source}</div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{c.email ?? "—"}</TableCell>
                  <TableCell className="text-muted-foreground">{c.phone ?? "—"}</TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">{[c.shipCity, c.shipCountry].filter(Boolean).join(", ") || "—"}</TableCell>
                  {owners && <TableCell className="hidden lg:table-cell">{c.owner ? <Badge variant="outline">{c.owner.businessName}</Badge> : <span className="text-muted-foreground">Company</span>}</TableCell>}
                  <TableCell className="text-right tabular-nums">{c._count.orders}</TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">{formatDateTime(c.updatedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <Pagination page={result.page} pageCount={result.pageCount} total={result.total} pageSize={result.pageSize} hrefFor={hrefFor} />
    </>
  );
}
