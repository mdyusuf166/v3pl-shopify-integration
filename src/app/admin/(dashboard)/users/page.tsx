import type { Metadata } from "next";
import { Users } from "lucide-react";
import { EmptyState } from "@/components/common/empty-state";
import { NativeSelect } from "@/components/common/native-select";
import { Pagination } from "@/components/common/pagination";
import { SearchFilterBar } from "@/components/common/search-filter-bar";
import { PageHeader } from "@/components/layout/page-header";
import { CreateUserDialog } from "@/components/users/create-user-dialog";
import { UsersTable } from "@/components/users/users-table";
import { ROLE_LABELS } from "@/lib/roles";
import { USER_ROLES, userListQuerySchema } from "@/lib/validation/users";
import { requireRole } from "@/server/auth/guards";
import { listUsers } from "@/server/services/users";

export const metadata: Metadata = { title: "Users" };

export default async function UsersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const me = await requireRole("ADMIN");
  const sp = await searchParams;
  const query = userListQuerySchema.parse({
    q: typeof sp.q === "string" ? sp.q : undefined,
    role: typeof sp.role === "string" ? sp.role : undefined,
    status: typeof sp.status === "string" ? sp.status : undefined,
    page: typeof sp.page === "string" ? sp.page : undefined,
  });
  const result = await listUsers({ q: query.q, role: query.role, status: query.status, page: query.page });

  const hrefFor = (page: number) => {
    const p = new URLSearchParams();
    if (query.q) p.set("q", query.q);
    if (query.role !== "ALL") p.set("role", query.role);
    if (query.status !== "ALL") p.set("status", query.status);
    if (page > 1) p.set("page", String(page));
    const s = p.toString();
    return `/admin/users${s ? `?${s}` : ""}`;
  };

  return (
    <>
      <PageHeader title="Users" description="Everyone who can sign in: staff at /admin, vendor and 3PL users at /user." />

      <SearchFilterBar q={query.q} placeholder="Search name, email or business…" actions={<CreateUserDialog mode="staff" />}>
        <NativeSelect name="role" defaultValue={query.role} aria-label="Role filter" className="w-40">
          <option value="ALL">All roles</option>
          {USER_ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect name="status" defaultValue={query.status} aria-label="Status filter" className="w-36">
          <option value="ALL">Active &amp; blocked</option>
          <option value="ACTIVE">Active</option>
          <option value="DISABLED">Disabled</option>
          <option value="BANNED">Banned</option>
          <option value="DELETED">Deleted</option>
        </NativeSelect>
      </SearchFilterBar>

      {result.items.length === 0 ? (
        <EmptyState icon={Users} title="No users match these filters" description="Try a different search or clear the filters." />
      ) : (
        <UsersTable users={result.items} currentUserId={me.id} />
      )}

      <Pagination page={result.page} pageCount={result.pageCount} total={result.total} pageSize={result.pageSize} hrefFor={hrefFor} />
    </>
  );
}
