import type { UserRef } from "../api/types";
import logoIcon from "../assets/logo-icon.png";
import { displayName, initials } from "../lib/utils";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { Archive, LogOut } from "lucide-react";

export function AppHeader({
  user,
  onLogout,
  middleRef,
}: {
  user: UserRef | null;
  onLogout: () => void;
  middleRef?: (el: HTMLDivElement | null) => void;
}) {
  return (
    <header className="relative z-10 flex h-12 shrink-0 items-center gap-3 bg-surface px-4 shadow-[0_1px_3px_rgba(0,0,0,0.08)]">
      <div className="flex shrink-0 items-center gap-2">
        <img src={logoIcon} alt="" className="h-7 w-7" />
        <span className="hidden font-display text-[15px] font-medium lg:block">Archive Engine</span>
      </div>
      <div ref={middleRef} className="flex min-w-0 flex-1 items-center gap-3" />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="rounded-full outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
            aria-label="Account menu"
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-accent-300 to-accent-500 text-xs font-semibold text-white">
              {initials(user)}
            </span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {user ? (
            <div className="px-2 py-1.5">
              <div className="truncate text-sm font-medium">{displayName(user)}</div>
              <div className="truncate text-xs text-neutral-500">{user.email}</div>
            </div>
          ) : null}
          <DropdownMenuItem onSelect={onLogout}>
            <LogOut className="h-4 w-4" />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
