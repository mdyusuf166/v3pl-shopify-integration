"use client";

import Link from "next/link";
import { PortalNav, type PortalNavItem } from "@/components/layout/portal-nav";
import { UserMenu, type ShellUser } from "@/components/layout/user-menu";
import { PORTAL_LOGIN_PATH } from "@/lib/auth-constants";

type Props = {
  user: ShellUser;
  homeHref: string;
  portalName: string;
  nav?: PortalNavItem[];
  children: React.ReactNode;
};

/** Partner portal frame (vendors / 3PL clients): header, tab navigation, content. */
export function PortalShell({ user, homeHref, portalName, nav, children }: Props) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b bg-background/95 px-4 backdrop-blur">
        <Link href={homeHref} className="flex items-center gap-2 font-semibold tracking-tight">
          <span className="flex size-7 items-center justify-center rounded-md bg-primary text-xs font-bold text-primary-foreground">V3</span>
          <span>V3PL</span>
          <span className="hidden text-sm font-normal text-muted-foreground sm:inline">· {portalName}</span>
        </Link>
        <div className="ml-auto">
          <UserMenu user={user} signOutRedirect={PORTAL_LOGIN_PATH} />
        </div>
      </header>
      {nav && nav.length > 0 && <PortalNav items={nav} />}
      <main className="flex-1 p-4 md:p-6 lg:p-8">
        <div className="mx-auto w-full max-w-6xl space-y-6">{children}</div>
      </main>
    </div>
  );
}
