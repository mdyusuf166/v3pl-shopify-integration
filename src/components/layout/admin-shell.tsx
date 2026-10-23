"use client";

import { useState } from "react";
import Link from "next/link";
import { Menu } from "lucide-react";
import type { NavSection } from "@/config/navigation";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { SidebarNav } from "@/components/layout/sidebar-nav";
import { UserMenu, type ShellUser } from "@/components/layout/user-menu";
import { STAFF_LOGIN_PATH } from "@/lib/auth-constants";

type Props = {
  user: ShellUser;
  sections: NavSection[];
  children: React.ReactNode;
};

function Brand() {
  return (
    <Link href="/admin" className="flex h-14 shrink-0 items-center gap-2 border-b border-sidebar-border px-4 font-semibold tracking-tight text-sidebar-foreground">
      <span className="flex size-7 items-center justify-center rounded-md bg-sidebar-primary text-xs font-bold text-sidebar-primary-foreground">
        V3
      </span>
      <span>V3PL</span>
    </Link>
  );
}

/** Account row anchored at the bottom of the sidebar (desktop) and of the navigation sheet (mobile); never scrolls with the nav. */
function AccountFooter({ user }: { user: ShellUser }) {
  return (
    <div data-slot="sidebar-account" className="shrink-0 border-t border-sidebar-border p-2">
      <UserMenu user={user} signOutRedirect={STAFF_LOGIN_PATH} variant="sidebar" />
    </div>
  );
}

/**
 * Admin application frame: sticky sidebar on desktop (brand → scrollable navigation → account footer),
 * sheet drawer behind a minimal header on mobile. Navigation is already filtered by role on the
 * server; this component only renders it.
 */
export function AdminShell({ user, sections, children }: Props) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="flex min-h-screen w-full">
      {/* Desktop sidebar: sticky to the viewport so it never scrolls away on long pages (D-056).
          The nav is sized to fit normal desktop heights; it only scrolls internally when the viewport
          is genuinely too short (zoom / small window) — QA UI-13. */}
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col self-start overflow-hidden border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:flex">
        <Brand />
        <SidebarNav sections={sections} />
        <AccountFooter user={user} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile only: menu trigger + brand. On desktop the sidebar carries the account, so there is no page header (QA UI-14). */}
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/80 md:hidden">
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger render={<Button variant="ghost" size="icon" aria-label="Open navigation" />}>
              <Menu />
            </SheetTrigger>
            <SheetContent side="left" className="flex w-72 flex-col bg-sidebar p-0 text-sidebar-foreground" showCloseButton>
              <SheetHeader className="border-b border-sidebar-border p-0">
                <SheetTitle className="sr-only">Navigation</SheetTitle>
                <Brand />
              </SheetHeader>
              <SidebarNav sections={sections} onNavigate={() => setMobileOpen(false)} />
              <AccountFooter user={user} />
            </SheetContent>
          </Sheet>
          <span className="font-semibold tracking-tight">V3PL</span>
        </header>

        <main className="flex-1 p-4 md:p-6 lg:p-8">
          <div className="mx-auto w-full max-w-7xl space-y-6">{children}</div>
        </main>
      </div>
    </div>
  );
}
