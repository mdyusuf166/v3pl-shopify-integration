"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";

/** Clears the server session cookie and returns to the given sign-in page. */
export function useSignOut(redirectTo: string) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  const signOut = useCallback(async () => {
    setPending(true);
    try {
      await fetch("/api/auth/session", { method: "DELETE" });
    } finally {
      router.replace(redirectTo);
      router.refresh();
    }
  }, [router, redirectTo]);

  return { signOut, pending };
}
