import Link from "next/link";
import type { UserRole, UserStatus } from "@/generated/prisma/client";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusBadge } from "@/components/common/status-badge";
import { UserActionsMenu } from "@/components/users/user-actions-menu";
import { ROLE_LABELS } from "@/lib/roles";

export type UserRow = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  role: UserRole;
  status: UserStatus;
  lastLoginAt: Date | null;
  createdAt: Date;
  owner?: { id: string; type: "VENDOR" | "THREEPL_CLIENT"; businessName: string } | null;
};

type Props = {
  users: UserRow[];
  currentUserId: string;
  /** Hide the owner column when the table is already scoped to one owner. */
  showOwner?: boolean;
};

const fmt = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });
const fmtDate = new Intl.DateTimeFormat("en", { dateStyle: "medium" });

export function UsersTable({ users, currentUserId, showOwner = true }: Props) {
  return (
    <div className="overflow-hidden rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>User</TableHead>
            <TableHead>Role</TableHead>
            {showOwner && <TableHead className="hidden md:table-cell">Vendor / 3PL</TableHead>}
            <TableHead>Status</TableHead>
            <TableHead className="hidden lg:table-cell">Last sign-in</TableHead>
            <TableHead className="hidden lg:table-cell">Created</TableHead>
            <TableHead className="w-10" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.map((u) => (
            <TableRow key={u.id}>
              <TableCell>
                <div className="font-medium">
                  {u.name}
                  {u.id === currentUserId && <span className="ml-2 text-xs text-muted-foreground">(you)</span>}
                </div>
                <div className="text-xs text-muted-foreground">{u.email}</div>
              </TableCell>
              <TableCell>{ROLE_LABELS[u.role]}</TableCell>
              {showOwner && (
                <TableCell className="hidden md:table-cell">
                  {u.owner ? (
                    <Link
                      href={`${u.owner.type === "VENDOR" ? "/admin/vendors" : "/admin/3pl-clients"}/${u.owner.id}`}
                      className="hover:underline"
                    >
                      {u.owner.businessName}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">Staff</span>
                  )}
                </TableCell>
              )}
              <TableCell>
                <StatusBadge status={u.status} />
              </TableCell>
              <TableCell className="hidden text-muted-foreground lg:table-cell">{u.lastLoginAt ? fmt.format(u.lastLoginAt) : "Never"}</TableCell>
              <TableCell className="hidden text-muted-foreground lg:table-cell">{fmtDate.format(u.createdAt)}</TableCell>
              <TableCell>
                {u.status !== "DELETED" && (
                  <UserActionsMenu user={{ id: u.id, name: u.name, email: u.email, status: u.status }} isSelf={u.id === currentUserId} />
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
