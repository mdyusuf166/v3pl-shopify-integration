import { AdminShell } from "@/components/layout/admin-shell";
import { navForRole } from "@/config/navigation";
import { ROLE_LABELS } from "@/lib/roles";
import { requireStaff } from "@/server/auth/guards";

export const dynamic = "force-dynamic";

/**
 * Protected admin area. requireStaff() verifies the session cookie, loads the
 * ACTIVE user from the database and rejects non-staff roles — server-side,
 * before anything renders.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await requireStaff();

  return (
    <AdminShell
      user={{ name: user.name, email: user.email, roleLabel: ROLE_LABELS[user.role] }}
      sections={navForRole(user.role)}
    >
      {children}
    </AdminShell>
  );
}
