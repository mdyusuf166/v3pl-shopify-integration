"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export type PortalNavItem = { label: string; href: string };

/** Horizontal tab navigation for the partner portals. */
export function PortalNav({ items }: { items: PortalNavItem[] }) {
  const pathname = usePathname();
  return (
    <nav className="sticky top-14 z-20 border-b bg-background" aria-label="Portal" data-slot="portal-nav">
      {/* Tabs wrap on narrow screens instead of scrolling: no stray scrollbar (QA UI-03/04). */}
      <div className="mx-auto flex w-full max-w-6xl flex-wrap gap-x-1 px-4">
        {items.map((item) => {
          const active = item.href === pathname || (item.href !== items[0].href && pathname.startsWith(`${item.href}/`)) || (item.href === items[0].href && pathname === item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn("-mb-px whitespace-nowrap border-b-2 px-3 py-2.5 text-sm transition-colors", active ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}
            >
              {item.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
