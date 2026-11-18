import type { InboxItem } from "@/notifications/read";
import { cn } from "@/lib/utils";
import { pageTitle } from "./community/forum-screens";
import { Button } from "./ui/button";
import { EmptyState } from "./ui/empty-state";

const eyebrow =
  "text-[12px] font-bold tracking-[0.12em] text-ink-muted uppercase";

const timeWords = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
});

/**
 * wave 4's Notifications board: the list, newest first, an unread dot on the
 * new ones, and "Mark all as read". Opening one marks it read on the way.
 */
export function NotificationsScreen({
  items,
  markAll,
  open,
  onPush,
}: {
  items: InboxItem[];
  markAll: () => void;
  /** Marks it read, then goes to it. */
  open: (item: InboxItem) => void;
  /** Opens "Turn on push"; absent before hydration. */
  onPush?: () => void;
}) {
  const unread = items.some((i) => i.unread);
  return (
    <div className="flex flex-col gap-space-3 px-space-4 pt-space-4 pb-space-6">
      <div className="flex items-center justify-between gap-space-3">
        <h1 className={pageTitle}>Notifications</h1>
        {unread ? (
          <Button type="button" variant="quiet" onClick={markAll}>
            Mark all as read
          </Button>
        ) : null}
      </div>
      <section
        aria-labelledby="push-card-heading"
        className="flex flex-col gap-space-2 rounded-radius-m bg-surface-raised px-[14px] py-space-3"
      >
        <h2 id="push-card-heading" className={eyebrow}>
          Push
        </h2>
        <p className="m-0 text-[16px] leading-[22px]">
          Lock reminders and scores on your phone, without the results.
        </p>
        <Button
          type="button"
          variant="secondary"
          className="self-start"
          disabled={!onPush}
          onClick={onPush}
        >
          Turn on push
        </Button>
      </section>
      {items.length === 0 ? (
        <EmptyState
          title="Nothing yet"
          body="Replies, mentions and your team's news show up here."
        />
      ) : (
        <>
          <ul
            aria-label="Notifications"
            className="m-0 flex list-none flex-col gap-space-2 p-0"
          >
            {items.map((item) => (
              <li key={`${item.source}:${item.id}`}>
                <a
                  href={item.href}
                  onClick={(e) => {
                    // A new tab or window goes straight there.
                    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey)
                      return;
                    e.preventDefault();
                    open(item);
                  }}
                  className={cn(
                    "flex min-h-[64px] items-start gap-space-3 rounded-radius-m px-[14px] py-space-3 text-ink no-underline outline-none hover:bg-surface-sunken focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring",
                    item.unread ? "bg-surface-raised" : "bg-surface",
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "mt-[6px] size-[8px] shrink-0 rounded-full",
                      item.unread ? "bg-heat" : "bg-transparent",
                    )}
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
                    <span className={eyebrow}>{item.label}</span>
                    <span
                      className={cn(
                        "text-[16px] leading-[22px] break-words",
                        item.unread ? "font-semibold" : "font-normal",
                      )}
                    >
                      {item.unread ? (
                        <span className="sr-only">Unread: </span>
                      ) : null}
                      {item.text}
                    </span>
                    <time
                      dateTime={item.createdAt}
                      className="text-[13px] text-ink-muted"
                    >
                      {timeWords.format(Date.parse(item.createdAt))}
                    </time>
                  </span>
                </a>
              </li>
            ))}
          </ul>
          <p className="m-0 text-center text-[14px] text-ink-muted">
            {"That's everything from the last 90 days."}
          </p>
        </>
      )}
    </div>
  );
}
