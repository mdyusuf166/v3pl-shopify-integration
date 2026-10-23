import Link from "next/link";
import { SearchX } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function PortalNotFound() {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed px-6 py-16 text-center">
      <SearchX className="mb-3 size-8 text-muted-foreground" />
      <p className="font-medium">We couldn&apos;t find that</p>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">The page or record doesn&apos;t exist, or it isn&apos;t part of your account.</p>
      <Button className="mt-4" render={<Link href="/portal/vendor" />}>Back to overview</Button>
    </div>
  );
}
