import { Menu } from "@base-ui/react/menu";

const trigger =
  "flex size-[44px] shrink-0 items-center justify-center rounded-radius-m border-0 bg-transparent text-ink-muted outline-none hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring";

export type MoreItem = { label: string; onSelect: () => void };

/**
 * The "…" on a post or a chat message (wave 4): "Report" on someone else's,
 * "Edit" and "Delete" on your own post.
 */
export function MoreMenu({
  label,
  items,
}: {
  /** The trigger's name: "More for the post by late_braker". */
  label: string;
  items: MoreItem[];
}) {
  return (
    <Menu.Root>
      <Menu.Trigger aria-label={label} className={trigger}>
        <span aria-hidden="true" className="text-[20px] leading-none">
          …
        </span>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={4} align="end" className="z-40">
          <Menu.Popup className="min-w-[160px] rounded-radius-m bg-surface-raised p-space-1 text-ink shadow-[var(--shadow-sheet)] outline-none">
            {items.map((item) => (
              <Menu.Item
                key={item.label}
                onClick={item.onSelect}
                className="flex min-h-[44px] cursor-pointer items-center rounded-radius-s px-space-3 text-[16px] outline-none data-highlighted:bg-surface"
              >
                {item.label}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
