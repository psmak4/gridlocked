import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
  STAFF_MENU_GROUPS,
  type StaffMenuGroup,
  type StaffMenuItem,
} from "@/staff/menu";

const focusRing =
  "outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring";

/**
 * The frame of the staff screens (wave 5): the staff side menu beside the
 * page, desktop-first; under 1024 px the menu sits above the page and the
 * page is one column. No bottom nav, and nothing here links to the public
 * screens but the wordmark's own area.
 */
export function StaffShell({
  menu,
  current,
  who,
  children,
}: {
  /** From `staffMenu`, so a moderator's has only their screens. */
  menu: StaffMenuItem[];
  /** The id of the screen shown. */
  current: string;
  who: { username: string; role: "moderator" | "admin" };
  children: ReactNode;
}) {
  const groups = (Object.keys(STAFF_MENU_GROUPS) as StaffMenuGroup[])
    .map((group) => ({
      group,
      items: menu.filter((item) => item.group === group),
    }))
    .filter(({ items }) => items.length > 0);
  return (
    <div data-slot="staff-shell" className="min-h-dvh bg-surface lg:flex">
      <nav
        aria-label="Staff"
        className="flex flex-col gap-space-4 border-b border-line bg-surface-raised px-space-3 py-space-4 lg:sticky lg:top-0 lg:h-dvh lg:w-[260px] lg:shrink-0 lg:border-r lg:border-b-0"
      >
        <a
          href="/staff"
          className={cn(
            "flex min-h-[44px] items-center rounded-radius-m px-space-2 font-display text-[20px] leading-[24px] text-ink no-underline",
            focusRing,
          )}
        >
          GRIDLOCKED · STAFF
        </a>
        {groups.map(({ group, items }) => (
          <section key={group} aria-labelledby={`staff-menu-${group}`}>
            <h2
              id={`staff-menu-${group}`}
              className="px-space-2 pb-space-1 text-[14px] font-bold text-ink-muted"
            >
              {STAFF_MENU_GROUPS[group]}
            </h2>
            <ul className="m-0 flex list-none flex-col gap-space-1 p-0">
              {items.map((item) => {
                const active = item.id === current;
                return (
                  <li key={item.id}>
                    <a
                      data-slot="staff-menu-item"
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "flex min-h-[44px] items-center gap-space-2 rounded-radius-m px-space-2 font-sans text-[16px] no-underline",
                        focusRing,
                        active
                          ? "bg-surface font-bold text-heat-text"
                          : "font-semibold text-ink-muted hover:text-ink",
                      )}
                    >
                      {item.label}
                      {item.count !== null ? (
                        <span className="sr-only">{`, ${item.count} waiting`}</span>
                      ) : null}
                      {item.count !== null ? (
                        <span
                          aria-hidden="true"
                          className="ml-auto min-w-[22px] rounded-radius-pill bg-heat px-[6px] text-center text-[12px] leading-[20px] font-bold text-on-heat"
                        >
                          {item.count}
                        </span>
                      ) : null}
                    </a>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
        <p className="px-space-2 text-[14px] text-ink-muted lg:mt-auto">
          {`Signed in as ${who.username} · ${who.role} · 2-step on`}
        </p>
      </nav>
      <main className="flex min-w-0 flex-1 flex-col gap-space-4 px-space-4 py-space-4 lg:px-space-6">
        {children}
      </main>
    </div>
  );
}
