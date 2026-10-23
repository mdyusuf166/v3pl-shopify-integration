"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { FirebaseError } from "firebase/app";
import { signInWithEmailAndPassword, signOut } from "firebase/auth";
import { Loader2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { firebaseClientAuth, isFirebaseClientConfigured } from "@/lib/firebase/client";

const schema = z.object({
  email: z.email("Enter a valid email address"),
  password: z.string().min(1, "Enter your password"),
});
type FormValues = z.infer<typeof schema>;

type Props = {
  audience: "staff" | "portal";
  next?: string;
};

type LoginError = { message: string; link?: { href: string; label: string } };

function firebaseErrorMessage(code: string): string {
  switch (code) {
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found":
    case "auth/invalid-email":
      return "Incorrect email or password.";
    case "auth/user-disabled":
      return "This account has been disabled. Contact an administrator.";
    case "auth/too-many-requests":
      return "Too many attempts. Please wait a moment and try again.";
    case "auth/network-request-failed":
      return "Network error. Check your connection and try again.";
    default:
      return "Sign-in failed. Please try again.";
  }
}

export function LoginForm({ audience, next }: Props) {
  const router = useRouter();
  const [error, setError] = useState<LoginError | null>(null);
  const configured = isFirebaseClientConfigured();

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: "", password: "" },
  });
  const { isSubmitting } = form.formState;

  async function onSubmit(values: FormValues) {
    setError(null);
    try {
      const auth = await firebaseClientAuth();
      const credential = await signInWithEmailAndPassword(auth, values.email, values.password);
      const idToken = await credential.user.getIdToken();
      // The browser never keeps a Firebase session; the httpOnly cookie is the session.
      await signOut(auth);

      const res = await fetch("/api/auth/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken, audience, next }),
      });
      const data = (await res.json().catch(() => ({}))) as { message?: string; redirectTo?: string; error?: string };

      if (!res.ok) {
        setError({
          message: data.message ?? "Sign-in failed.",
          link:
            data.error === "wrong_portal" && data.redirectTo
              ? { href: data.redirectTo, label: "Go to the correct sign-in page" }
              : undefined,
        });
        return;
      }
      router.replace(data.redirectTo ?? "/");
      router.refresh();
    } catch (err) {
      const message = err instanceof FirebaseError ? firebaseErrorMessage(err.code) : "Sign-in failed. Please try again.";
      setError({ message });
    }
  }

  if (!configured) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          Firebase is not configured for this environment. Set the <code>NEXT_PUBLIC_FIREBASE_*</code> variables
          (see <code>.env.example</code>) and restart the server.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          autoComplete="username"
          autoFocus
          disabled={isSubmitting}
          aria-invalid={!!form.formState.errors.email}
          {...form.register("email")}
        />
        {form.formState.errors.email && (
          <p className="text-sm text-destructive">{form.formState.errors.email.message}</p>
        )}
      </div>
      <div className="space-y-2">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          type="password"
          autoComplete="current-password"
          disabled={isSubmitting}
          aria-invalid={!!form.formState.errors.password}
          {...form.register("password")}
        />
        {form.formState.errors.password && (
          <p className="text-sm text-destructive">{form.formState.errors.password.message}</p>
        )}
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>
            <span>{error.message}</span>
            {error.link && (
              <Link href={error.link.href} className="ml-1 underline underline-offset-4">
                {error.link.label}
              </Link>
            )}
          </AlertDescription>
        </Alert>
      )}

      <Button type="submit" className="w-full" disabled={isSubmitting}>
        {isSubmitting && <Loader2 className="animate-spin" />}
        Sign in
      </Button>
    </form>
  );
}
