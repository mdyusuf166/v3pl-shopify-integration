import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, Pencil, Users } from "lucide-react";
import type { OwnerType } from "@/generated/prisma/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/common/empty-state";
import { StatusBadge } from "@/components/common/status-badge";
import { PageHeader } from "@/components/layout/page-header";
import { OwnerProfileCard } from "@/components/owners/owner-profile-card";
import { OwnerStatusButton } from "@/components/owners/owner-status-button";
import { CreateUserDialog } from "@/components/users/create-user-dialog";
import { UsersTable } from "@/components/users/users-table";
import { OWNER_TYPE_META } from "@/lib/validation/owners";
import { getCurrentUser } from "@/server/auth/current-user";
import { getOwnerWithUsers } from "@/server/services/owners";
import { BalanceCard } from "@/components/finance/balance-card";
import { ownerBalance } from "@/server/services/finance";

export async function OwnerDetail({ type, id }: { type: OwnerType; id: string }) {
  const meta = OWNER_TYPE_META[type];
  const [owner, me] = await Promise.all([getOwnerWithUsers(id, type), getCurrentUser()]);
  if (!owner) notFound();
  const balance = await ownerBalance(owner.id);

  return (
    <>
      <div>
        <Link href={meta.basePath} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ChevronLeft className="size-4" /> {meta.plural}
        </Link>
      </div>
      <PageHeader
        title={owner.businessName}
        description={`${meta.singular} · ${owner.code}`}
        actions={
          <>
            <StatusBadge status={owner.status} className="mr-2" />
            <Button variant="outline" render={<Link href={`${meta.basePath}/${owner.id}/edit`} />}>
              <Pencil /> Edit
            </Button>
            <OwnerStatusButton type={type} id={owner.id} status={owner.status} businessName={owner.businessName} />
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-1">
          <OwnerProfileCard owner={owner} />
          <div className="mt-6">
            <BalanceCard balance={balance} href={`/admin/finance/${owner.id}`} ownerLabel={meta.singular.toLowerCase()} ownerType={type} />
          </div>
          {owner.notes && (
            <Card className="mt-6">
              <CardHeader>
                <CardTitle>Internal notes</CardTitle>
              </CardHeader>
              <CardContent className="text-sm whitespace-pre-line">{owner.notes}</CardContent>
            </Card>
          )}
        </div>

        <div className="space-y-4 lg:col-span-2">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold">Portal users</h2>
              <p className="text-sm text-muted-foreground">People who can sign in at /user and see only this {meta.singular.toLowerCase()}&apos;s data.</p>
            </div>
            {owner.status === "ACTIVE" && (
              <CreateUserDialog mode="portal" role={meta.userRole} ownerId={owner.id} ownerName={owner.businessName} />
            )}
          </div>
          {owner.users.length === 0 ? (
            <EmptyState
              icon={Users}
              title="No portal users yet"
              description={
                owner.status === "ACTIVE"
                  ? "Add a user so this business can sign in and see its inventory and orders."
                  : `Reactivate this ${meta.singular.toLowerCase()} to add users.`
              }
            />
          ) : (
            <UsersTable users={owner.users} currentUserId={me?.id ?? ""} showOwner={false} />
          )}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Products, inventory and orders</CardTitle>
              <CardDescription>Appear here from Phase 3 onwards, scoped to this {meta.singular.toLowerCase()}.</CardDescription>
            </CardHeader>
          </Card>
        </div>
      </div>
    </>
  );
}
