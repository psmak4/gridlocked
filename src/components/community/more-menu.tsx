import { Menu } from "@base-ui/react/menu";

const trigger =
  "flex size-[44px] shrink-0 items-center justify-center rounded-radius-m border-0 bg-transparent text-ink-muted outline-none hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring";

/** The "…" on a post or a chat message (wave 4): for now, "Report". */
export function MoreMenu({
  label,
  onReport,
}: {
  /** The trigger's name: "More for the post by late_braker". */
  label: string;
  onReport: () => void;
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
            <Menu.Item
              onClick={onReport}
              className="flex min-h-[44px] cursor-pointer items-center rounded-radius-s px-space-3 text-[16px] outline-none data-highlighted:bg-surface"
            >
              Report
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
