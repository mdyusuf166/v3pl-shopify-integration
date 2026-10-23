import Link from "next/link";
import { SearchX } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function AdminNotFound() {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed px-6 py-16 text-center">
      <SearchX className="mb-3 size-8 text-muted-foreground" />
      <p className="font-medium">Not found</p>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">The record may have been removed or the link is wrong.</p>
      <Button className="mt-4" render={<Link href="/admin" />}>Back to dashboard</Button>
    </div>
  );
}
