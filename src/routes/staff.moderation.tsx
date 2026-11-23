import {
  createFileRoute,
  Link,
  Outlet,
  useLocation,
} from "@tanstack/react-router";
import { REASON_WORDS } from "@/components/community/report-sheet";
import { Badge } from "@/components/ui/badge";
import { privateHeaders } from "@/lib/private-headers";
import { cn } from "@/lib/utils";
import { getModQueue } from "@/server/staff";
import { STAFF_ERROR_WORDS } from "@/staff/errors";

/**
 * The moderation queue (wave 5's moderation board, M8 Task 11): what readers
 * reported and what the filter raised, Open, Auto-hidden (hidden by reports
 * until someone decides) or Done. Picking one opens its panel beside the
 * list (`/staff/moderation/$itemId`); on a narrow screen the panel comes
 * first.
 */
type Tab = "open" | "hidden" | "done";

export const Route = createFileRoute("/staff/moderation")({
  validateSearch: (search: Record<string, unknown>): { tab: Tab } => ({
    tab: search.tab === "hidden" || search.tab === "done" ? search.tab : "open",
  }),
  loaderDeps: ({ search }) => ({ tab: search.tab }),
  loader: ({ deps }) => getModQueue({ data: { tab: deps.tab } }),
  head: () => ({ meta: [{ title: "Moderation · Staff · Gridlocked" }] }),
  headers: privateHeaders,
  component: ModerationQueue,
});

const eyebrow = "text-[12px] font-bold tracking-[0.12em] text-ink-muted";

const TABS: { id: Tab; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "hidden", label: "Auto-hidden" },
  { id: "done", label: "Done" },
];

/** "Post", "Thread", "Chat message". */
export const TYPE_WORDS: Record<string, string> = {
  post: "Post",
  thread: "Thread",
  chat_message: "Chat message",
  user: "Account",
  team_name: "Team name",
  league_name: "League name",
};

export function reasonWords(reason: string): string {
  return reason === "filter"
    ? "Raised by the filter"
    : (REASON_WORDS[reason as keyof typeof REASON_WORDS] ?? reason);
}

const EMPTY: Record<Tab, string> = {
  open: "Nothing is waiting. Reports and filter hits appear here.",
  hidden: "Nothing is hidden by reports right now.",
  done: "Nothing has been decided yet.",
};

function ModerationQueue() {
  const result = Route.useLoaderData();
  const { tab } = Route.useSearch();
  const { pathname } = useLocation();
  const selected = pathname.split("/")[3] ?? null;

  return (
    <>
      <header className="flex flex-col gap-space-1">
        <span className={eyebrow}>MODERATION</span>
        <h1 className="font-display text-[36px] leading-[38px] font-normal uppercase">
          Moderation queue
        </h1>
        <p className="max-w-[760px] text-[16px] text-ink-muted">
          What readers reported, as it was when first reported. The author sees
          your note, and can appeal.
        </p>
      </header>

      <nav
        aria-label="Moderation queue tabs"
        className="flex flex-wrap gap-space-2"
      >
        {TABS.map((t) => (
          <Link
            key={t.id}
            to="/staff/moderation"
            search={{ tab: t.id }}
            aria-current={tab === t.id ? "page" : undefined}
            className={cn(
              "flex min-h-[44px] items-center rounded-radius-pill border-2 px-space-4 text-[16px] font-bold no-underline outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-focus-ring",
              tab === t.id
                ? "border-ink bg-ink text-surface"
                : "border-line-strong text-ink",
            )}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      <div className="flex flex-wrap items-start gap-space-5">
        <div className="min-w-0 flex-[3_1_480px] max-lg:order-last">
          {!result.ok ? (
            <p role="alert" className="text-[16px] font-semibold text-fall">
              {STAFF_ERROR_WORDS[result.error]}
            </p>
          ) : result.value.length === 0 ? (
            <p className="rounded-radius-l bg-surface-raised p-space-4 text-[16px] text-ink-muted">
              {EMPTY[tab]}
            </p>
          ) : (
            <ul
              aria-label="Moderation items"
              className="m-0 flex list-none flex-col gap-space-2 p-0"
            >
              {result.value.map((item) => (
                <li key={item.id} data-slot="mod-item">
                  <Link
                    to="/staff/moderation/$itemId"
                    params={{ itemId: item.id }}
                    search={{ tab }}
                    aria-current={item.id === selected ? "page" : undefined}
                    className={cn(
                      "flex min-h-[44px] flex-col gap-[2px] rounded-radius-l bg-surface-raised p-space-4 text-ink no-underline outline-none hover:underline focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-focus-ring",
                      item.id === selected &&
                        "outline-2 -outline-offset-2 outline-ink",
                    )}
                  >
                    <span className="flex flex-wrap items-center gap-space-2">
                      <Badge
                        tone={
                          item.state === "Auto-hidden" ? "caution" : "neutral"
                        }
                      >
                        {item.state}
                      </Badge>
                      <span className={eyebrow}>
                        {reasonWords(item.reason).toUpperCase()} ·{" "}
                        {(TYPE_WORDS[item.type] ?? item.type).toUpperCase()}
                      </span>
                    </span>
                    <span className="text-[16px] font-bold break-words">
                      {item.snippet}
                    </span>
                    <span className="text-[14px] text-ink-muted">
                      {item.where ? `${item.where} · ` : ""}
                      {item.reports === 1
                        ? "1 report"
                        : `${item.reports} reports`}{" "}
                      · {item.ageLabel}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
        <Outlet />
      </div>
    </>
  );
}
