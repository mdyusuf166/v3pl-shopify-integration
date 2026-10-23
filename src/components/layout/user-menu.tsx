"use client";

import { ChevronDown, LogOut } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSignOut } from "@/components/auth/use-sign-out";

export type ShellUser = { name: string; email: string; roleLabel: string };

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "?";
  const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (first + last).toUpperCase();
}

/**
 * Account menu. `variant="sidebar"` renders the full-width row anchored at the bottom of the admin
 * sidebar (name + role on the dark surface, menu opens upwards); the default renders the compact
 * header button used by the portals.
 */
export function UserMenu({ user, signOutRedirect, variant = "default" }: { user: ShellUser; signOutRedirect: string; variant?: "default" | "sidebar" }) {
  const { signOut, pending } = useSignOut(signOutRedirect);
  const sidebar = variant === "sidebar";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          sidebar ? (
            <Button variant="ghost" className="h-auto w-full justify-start gap-2.5 px-2 py-2 text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground" aria-label="Account menu" />
          ) : (
            <Button variant="ghost" className="h-9 gap-2 px-2" aria-label="Account menu" />
          )
        }
      >
        <Avatar className="size-7">
          <AvatarFallback className={sidebar ? "bg-sidebar-accent text-xs text-sidebar-foreground" : "text-xs"}>{initials(user.name)}</AvatarFallback>
        </Avatar>
        {sidebar ? (
          <span className="min-w-0 flex-1 text-left leading-tight">
            <span className="block truncate text-sm font-medium">{user.name}</span>
            <span className="block truncate text-[11px] text-sidebar-foreground/60">{user.roleLabel}</span>
          </span>
        ) : (
          <span className="hidden text-sm font-medium sm:inline">{user.name}</span>
        )}
        <ChevronDown className={sidebar ? "size-4 shrink-0 text-sidebar-foreground/60" : "hidden size-4 text-muted-foreground sm:inline"} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align={sidebar ? "start" : "end"} side={sidebar ? "top" : "bottom"} className="w-60">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="space-y-0.5 py-1.5">
            <p className="text-sm font-medium text-foreground">{user.name}</p>
            <p className="truncate text-xs font-normal">{user.email}</p>
            <p className="text-xs font-normal">{user.roleLabel}</p>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => void signOut()} disabled={pending}>
          <LogOut />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
