import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Props = {
  /** Current search text. */
  q?: string;
  placeholder?: string;
  /** Extra filter controls (selects) rendered inline; they submit with the form. */
  children?: React.ReactNode;
  /** Right-aligned actions, e.g. a "New" button. */
  actions?: React.ReactNode;
};

/** GET-form filter bar: plain HTML, works without JavaScript, URL is shareable. */
export function SearchFilterBar({ q, placeholder = "Search…", children, actions }: Props) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <form method="get" className="flex flex-1 flex-wrap items-center gap-2">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input name="q" defaultValue={q ?? ""} placeholder={placeholder} className="pl-8" aria-label="Search" />
        </div>
        {children}
        <Button type="submit" variant="secondary" size="sm">
          Apply
        </Button>
      </form>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
