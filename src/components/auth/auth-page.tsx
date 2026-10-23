import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Props = {
  title: string;
  description: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
};

/** Centered card layout shared by the /admin and /user sign-in screens. */
export function AuthPage({ title, description, children, footer }: Props) {
  return (
    <main className="flex flex-1 items-center justify-center bg-muted/40 p-6">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <Link href="/" className="text-2xl font-semibold tracking-tight">
            V3PL
          </Link>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </CardHeader>
          <CardContent>{children}</CardContent>
        </Card>
        {footer && <p className="text-center text-sm text-muted-foreground">{footer}</p>}
      </div>
    </main>
  );
}
