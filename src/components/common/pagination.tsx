import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

type Props = {
  page: number;
  pageCount: number;
  total: number;
  pageSize: number;
  /** Builds the href for a page, preserving current filters. */
  hrefFor: (page: number) => string;
};

export function Pagination({ page, pageCount, total, pageSize, hrefFor }: Props) {
  if (total === 0) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);

  return (
    <div className="flex items-center justify-between gap-4 text-sm text-muted-foreground">
      <span>
        Showing {from}–{to} of {total}
      </span>
      {pageCount > 1 && (
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" disabled={page <= 1} render={page > 1 ? <Link href={hrefFor(page - 1)} /> : undefined}>
            <ChevronLeft /> Previous
          </Button>
          <span className="px-2">
            Page {page} of {pageCount}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= pageCount}
            render={page < pageCount ? <Link href={hrefFor(page + 1)} /> : undefined}
          >
            Next <ChevronRight />
          </Button>
        </div>
      )}
    </div>
  );
}
