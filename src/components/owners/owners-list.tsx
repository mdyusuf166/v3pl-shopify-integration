import Link from "next/link";
import { Building2, Handshake, Plus } from "lucide-react";
import type { OwnerType } from "@/generated/prisma/client";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/common/empty-state";
import { NativeSelect } from "@/components/common/native-select";
import { Pagination } from "@/components/common/pagination";
import { SearchFilterBar } from "@/components/common/search-filter-bar";
import { StatusBadge } from "@/components/common/status-badge";
import { PageHeader } from "@/components/layout/page-header";
import { OWNER_TYPE_META, ownerListQuerySchema } from "@/lib/validation/owners";
import { listOwners } from "@/server/services/owners";

type Props = {
  type: OwnerType;
  searchParams: Record<string, string | string[] | undefined>;
};

/** Shared server component behind /admin/vendors and /admin/3pl-clients. */
export async function OwnersList({ type, searchParams }: Props) {
  const meta = OWNER_TYPE_META[type];
  const query = ownerListQuerySchema.parse({
    q: typeof searchParams.q === "string" ? searchParams.q : undefined,
    status: typeof searchParams.status === "string" ? searchParams.status : undefined,
    page: typeof searchParams.page === "string" ? searchParams.page : undefined,
  });
  const result = await listOwners({ type, q: query.q, status: query.status, page: query.page });

  const hrefFor = (page: number) => {
    const p = new URLSearchParams();
    if (query.q) p.set("q", query.q);
    if (query.status !== "ACTIVE") p.set("status", query.status);
    if (page > 1) p.set("page", String(page));
    const s = p.toString();
    return `${meta.basePath}${s ? `?${s}` : ""}`;
  };

  const Icon = type === "VENDOR" ? Handshake : Building2;
  const newButton = (
    <Button render={<Link href={`${meta.basePath}/new`} />}>
      <Plus /> New {meta.singular.toLowerCase()}
    </Button>
  );

  return (
    <>
      <PageHeader
        title={meta.plural}
        description={
          type === "VENDOR"
            ? "Partners whose products you stock and sell."
            : "Companies that store their stock in your warehouses and use your fulfillment."
        }
      />

      <SearchFilterBar q={query.q} placeholder={`Search ${meta.plural.toLowerCase()}…`} actions={newButton}>
        <NativeSelect name="status" defaultValue={query.status} aria-label="Status filter" className="w-36">
          <option value="ACTIVE">Active</option>
          <option value="INACTIVE">Inactive</option>
          <option value="ALL">All statuses</option>
        </NativeSelect>
      </SearchFilterBar>

      {result.items.length === 0 ? (
        <EmptyState
          icon={Icon}
          title={query.q || query.status !== "ACTIVE" ? `No ${meta.plural.toLowerCase()} match these filters` : `No ${meta.plural.toLowerCase()} yet`}
          description={query.q ? "Try a different search or clear the filters." : `Create your first ${meta.singular.toLowerCase()} to start adding products and users.`}
          action={!query.q ? newButton : undefined}
        />
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Business</TableHead>
                <TableHead className="hidden md:table-cell">Contact</TableHead>
                <TableHead className="hidden lg:table-cell">Email</TableHead>
                <TableHead className="text-right">Users</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.items.map((owner) => (
                <TableRow key={owner.id}>
                  <TableCell className="font-mono text-xs">{owner.code}</TableCell>
                  <TableCell>
                    <Link href={`${meta.basePath}/${owner.id}`} className="font-medium hover:underline">
                      {owner.businessName}
                    </Link>
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">{owner.contactName ?? "—"}</TableCell>
                  <TableCell className="hidden text-muted-foreground lg:table-cell">{owner.email ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{owner._count.users}</TableCell>
                  <TableCell>
                    <StatusBadge status={owner.status} />
                  </TableCell>
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
