import Link from "next/link";
import { cn } from "@/lib/utils";

export type TabLink = { key: string; label: string; count?: number };

/** Server-rendered tab bar driven by a `?tab=` query parameter (no client state). */
export function TabLinks({ tabs, active, hrefFor }: { tabs: TabLink[]; active: string; hrefFor: (key: string) => string }) {
  return (
    <nav className="inline-flex h-8 w-fit items-center justify-center rounded-lg bg-muted p-[3px] text-muted-foreground" aria-label="Sections">
      {tabs.map((t) => {
        const isActive = t.key === active;
        return (
          <Link
            key={t.key}
            href={hrefFor(t.key)}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "inline-flex h-[calc(100%-1px)] items-center justify-center gap-1.5 rounded-md border border-transparent px-2.5 py-0.5 text-sm font-medium whitespace-nowrap transition-all",
              isActive ? "bg-background text-foreground shadow-sm" : "text-foreground/60 hover:text-foreground",
            )}
          >
            {t.label}
            {t.count !== undefined && t.count > 0 && <span className="rounded-full bg-amber-100 px-1.5 text-[10px] font-semibold text-amber-800 dark:bg-amber-950 dark:text-amber-300">{t.count}</span>}
          </Link>
        );
      })}
    </nav>
  );
}
