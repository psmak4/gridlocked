import { cn } from "@/lib/utils";
import { Icon } from "./ui/icons";

const focusRing =
  "outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring";

/** "Notifications, 3 unread": what the bell says to a screen reader. */
export const bellLabel = (unread: number) =>
  unread > 0 ? `Notifications, ${unread} unread` : "Notifications";

/** The count on the bell: 99 at most, then "99+". */
export const bellCount = (unread: number) =>
  unread > 99 ? "99+" : String(unread);

/** The bell in a phone's header (wave 4): a link to the list, with the count. */
export function NotificationBell({
  unread,
  className,
}: {
  unread: number;
  className?: string;
}) {
  return (
    <a
      href="/notifications"
      aria-label={bellLabel(unread)}
      data-slot="notification-bell"
      className={cn(
        "relative inline-flex size-[44px] items-center justify-center rounded-radius-m text-ink no-underline",
        focusRing,
        className,
      )}
    >
      <Icon name="bell" />
      {unread > 0 ? (
        <span
          aria-hidden="true"
          className="absolute top-[4px] right-[2px] min-w-[18px] rounded-radius-pill bg-heat px-[5px] text-center font-sans text-[11px] leading-[18px] font-bold text-on-heat"
        >
          {bellCount(unread)}
        </span>
      ) : null}
    </a>
  );
}
