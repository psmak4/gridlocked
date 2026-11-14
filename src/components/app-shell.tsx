import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { BottomNav, type BottomNavItem } from "./ui/bottom-nav";
import { EmptyState } from "./ui/empty-state";
import { Icon } from "./ui/icons";

/** The app's main places. Forum and the bell join in M7. */
export type ShellItem = "home" | "team" | "leagues" | "profile";

const ITEMS: (BottomNavItem & { id: ShellItem; href: string })[] = [
  { id: "home", label: "Home", href: "/" },
  { id: "team", label: "Team", href: "/team" },
  { id: "leagues", label: "Leagues", href: "/leagues" },
  { id: "profile", label: "Profile", href: "/profile" },
];

const focusRing =
  "outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring";

/**
 * From 1024 px, the side menu replaces the bottom nav (wave 3): the wordmark,
 * then the same items.
 */
function SideMenu({ active }: { active: ShellItem }) {
  return (
    <nav
      aria-label="Main"
      data-slot="side-menu"
      className="sticky top-0 hidden h-dvh w-[240px] shrink-0 flex-col gap-space-4 border-r border-line bg-surface-raised px-space-3 py-space-4 lg:flex"
    >
      <a
        href="/"
        className={cn(
          "flex min-h-[44px] items-center rounded-radius-m px-space-2 font-display text-[24px] leading-[28px] text-ink no-underline",
          focusRing,
        )}
      >
        GRIDLOCKED
      </a>
      <ul className="m-0 flex list-none flex-col gap-space-1 p-0">
        {ITEMS.map((item) => {
          const current = item.id === active;
          return (
            <li key={item.id}>
              <a
                href={item.href}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "flex min-h-[44px] items-center gap-space-3 rounded-radius-m px-space-2 font-sans text-[16px] no-underline",
                  focusRing,
                  current
                    ? "bg-surface-sunken font-bold text-heat-text"
                    : "font-semibold text-ink-muted hover:text-ink",
                )}
              >
                <Icon name={item.id} />
                {item.label}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * The frame of the fantasy screens (M6): the bottom nav under 1024 px, fixed
 * with the safe-area inset, and from 1024 px the side menu beside a main
 * column of at most 1200 px. The site footer stays below (`__root.tsx`
 * leaves room for the bottom nav under it).
 */
export function AppShell({
  active,
  children,
}: {
  active: ShellItem;
  children: ReactNode;
}) {
  return (
    <div data-slot="app-shell" className="lg:flex">
      <SideMenu active={active} />
      <main className="mx-auto flex min-h-dvh w-full max-w-[1200px] min-w-0 flex-col">
        {children}
      </main>
      <div className="fixed inset-x-0 bottom-0 z-10 border-t border-line bg-surface-raised pb-[env(safe-area-inset-bottom)] lg:hidden">
        <BottomNav items={ITEMS} active={active} />
      </div>
    </div>
  );
}

/** What a fantasy screen shows before the season's game opens. */
export function NoGame() {
  return (
    <EmptyState
      headingLevel={1}
      title="No game yet"
      body="The game opens before the first race."
    />
  );
}
