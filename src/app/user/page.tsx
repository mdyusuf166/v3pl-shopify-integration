import { redirect } from "next/navigation";
import { PORTAL_LOGIN_PATH } from "@/lib/auth-constants";
import { homePathForRole } from "@/lib/roles";
import { getCurrentUser } from "@/server/auth/current-user";

export const dynamic = "force-dynamic";

/** /user — shared partner entry point (D-010): routes to the right portal or to sign-in. */
export default async function UserEntryPage() {
  const user = await getCurrentUser();
  redirect(user ? homePathForRole(user.role) : PORTAL_LOGIN_PATH);
}
