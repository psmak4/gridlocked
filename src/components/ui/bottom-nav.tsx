import { cn } from "@/lib/utils";
import { Icon, iconNames, type IconName } from "./icons";

type BottomNavItem = {
  id: string;
  label: string;
  href?: string;
  /** Defaults to the icon named like the item's id. */
  icon?: IconName;
};

type BottomNavProps = {
  /** Five at most. */
  items: BottomNavItem[];
  /** The id of the current item. */
  active: string;
  className?: string;
};

const iconFor = (item: BottomNavItem): IconName =>
  item.icon ??
  ((iconNames as readonly string[]).includes(item.id)
    ? (item.id as IconName)
    : "home");

/**
 * The app's main navigation: icon and label for each item. The app shell fixes
 * it to the bottom and adds the safe-area inset.
 */
function BottomNav({ items, active, className }: BottomNavProps) {
  const shown = items.slice(0, 5);
  return (
    <nav
      aria-label="Main"
      data-slot="bottom-nav"
      className={cn("h-[60px] bg-surface-raised", className)}
    >
      <ul
        className="grid h-full list-none"
        style={{
          gridTemplateColumns: `repeat(${shown.length}, minmax(0, 1fr))`,
        }}
      >
        {shown.map((item) => {
          const current = item.id === active;
          return (
            <li key={item.id} className="flex">
              <a
                href={item.href ?? "#"}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "flex min-h-[44px] flex-1 flex-col items-center justify-center gap-[3px] font-sans text-[12px] no-underline outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring",
                  current
                    ? "font-bold text-heat-text"
                    : "font-semibold text-ink-muted",
                )}
              >
                <Icon name={iconFor(item)} />
                {item.label}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export { BottomNav };
export type { BottomNavItem, BottomNavProps };
