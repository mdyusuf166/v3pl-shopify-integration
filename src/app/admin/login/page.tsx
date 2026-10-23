import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthPage } from "@/components/auth/auth-page";
import { LoginForm } from "@/components/auth/login-form";
import { homePathForRole } from "@/lib/roles";
import { getCurrentUser } from "@/server/auth/current-user";

export const metadata: Metadata = { title: "Staff sign in" };
export const dynamic = "force-dynamic";

export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const user = await getCurrentUser();
  if (user) redirect(homePathForRole(user.role));
  const { next } = await searchParams;

  return (
    <AuthPage
      title="Staff sign in"
      description="Administrators, warehouse and sales team."
      footer={
        <>
          Vendor or 3PL client?{" "}
          <Link href="/user/login" className="underline underline-offset-4">
            Sign in here
          </Link>
        </>
      }
    >
      <LoginForm audience="staff" next={next} />
    </AuthPage>
  );
}
