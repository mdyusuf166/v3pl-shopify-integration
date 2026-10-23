"use client";

import Link from "next/link";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

type Props = { error: Error & { digest?: string }; reset: () => void; homeHref: string };

/** Friendly error boundary body: no stack traces or internal details for end users. */
export function ErrorState({ error, reset, homeHref }: Props) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed px-6 py-16 text-center" role="alert">
      <AlertTriangle className="mb-3 size-8 text-amber-600" />
      <p className="font-medium">Something went wrong loading this page</p>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">Your data is safe. Try again, or go back to the overview. If this keeps happening, contact the V3PL team{error.digest ? ` and mention code ${error.digest}` : ""}.</p>
      <div className="mt-4 flex gap-2">
        <Button variant="outline" onClick={reset}>
          <RotateCcw /> Try again
        </Button>
        <Button render={<Link href={homeHref} />}>Back to overview</Button>
      </div>
    </div>
  );
}
