import Link from "next/link";
import { redirect } from "next/navigation";
import { Building2, ShieldCheck } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { homePathForRole } from "@/lib/roles";
import { getCurrentUser } from "@/server/auth/current-user";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const user = await getCurrentUser();
  if (user) redirect(homePathForRole(user.role));

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-2xl space-y-8">
        <div className="text-center">
          <h1 className="text-3xl font-semibold tracking-tight">V3PL</h1>
          <p className="mt-2 text-muted-foreground">Choose how you want to sign in.</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Link href="/admin/login" className="group">
            <Card className="h-full transition-colors group-hover:border-foreground/30">
              <CardHeader>
                <ShieldCheck className="mb-2 size-6 text-muted-foreground" />
                <CardTitle>Staff sign in</CardTitle>
                <CardDescription>Administrators, warehouse and sales team.</CardDescription>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">/admin</CardContent>
            </Card>
          </Link>
          <Link href="/user/login" className="group">
            <Card className="h-full transition-colors group-hover:border-foreground/30">
              <CardHeader>
                <Building2 className="mb-2 size-6 text-muted-foreground" />
                <CardTitle>Vendor &amp; 3PL sign in</CardTitle>
                <CardDescription>Partner portal for vendors and 3PL clients.</CardDescription>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">/user</CardContent>
            </Card>
          </Link>
        </div>
      </div>
    </main>
  );
}
