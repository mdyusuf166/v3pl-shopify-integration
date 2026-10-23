"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { NavSection } from "@/config/navigation";
import { NAV_ICONS } from "@/components/layout/nav-icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type Props = {
  sections: NavSection[];
  onNavigate?: () => void;
};

function isActive(pathname: string, href: string): boolean {
  if (href === "/admin") return pathname === "/admin";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function SidebarNav({ sections, onNavigate }: Props) {
  const pathname = usePathname();

  return (
    <nav className="scrollbar-none flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3" aria-label="Main" data-slot="sidebar-nav">
      {sections.map((section) => (
        <div key={section.title} className="space-y-0.5">
          <p className="px-2 text-[11px] font-medium uppercase leading-4 tracking-wider text-sidebar-foreground/55">
            {section.title}
          </p>
          <ul className="space-y-0.5">
            {section.items.map((item) => {
              const Icon = NAV_ICONS[item.icon];
              const active = isActive(pathname, item.href);

              if (item.comingSoonPhase) {
                return (
                  <li key={item.href}>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <span
                            aria-disabled
                            className="flex w-full cursor-not-allowed items-center gap-2.5 rounded-md px-2 py-1 text-sm text-sidebar-foreground/45"
                          />
                        }
                      >
                        <Icon className="size-4 shrink-0" />
                        <span className="truncate">{item.label}</span>
                        <span className="ml-auto rounded bg-sidebar-accent px-1.5 py-0.5 text-[10px] font-medium text-sidebar-foreground/70">
                          P{item.comingSoonPhase}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="right">Available in Phase {item.comingSoonPhase}</TooltipContent>
                    </Tooltip>
                  </li>
                );
              }

              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex items-center gap-2.5 rounded-md px-2 py-1 text-sm transition-colors",
                      active
                        ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                        : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
                    )}
                  >
                    <Icon className="size-4 shrink-0" />
                    <span className="truncate">{item.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
