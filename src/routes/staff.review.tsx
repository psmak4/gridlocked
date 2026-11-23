import {
  createFileRoute,
  Link,
  Outlet,
  useLocation,
} from "@tanstack/react-router";
import { Badge } from "@/components/ui/badge";
import { privateHeaders } from "@/lib/private-headers";
import { cn } from "@/lib/utils";
import { getReviewList } from "@/server/staff";
import { STAFF_ERROR_WORDS } from "@/staff/errors";

/**
 * The review queue (wave 5's review board, M8 Task 10): every item a human
 * must decide, Open (blocking first) or Resolved. Picking one opens its
 * panel beside the list (`/staff/review/$itemId`), with the evidence, what
 * it holds up, a reason and its actions; on a narrow screen the panel comes
 * first.
 */
type Tab = "open" | "resolved";

export const Route = createFileRoute("/staff/review")({
  validateSearch: (search: Record<string, unknown>): { tab: Tab } => ({
    tab: search.tab === "resolved" ? "resolved" : "open",
  }),
  loaderDeps: ({ search }) => ({ tab: search.tab }),
  loader: ({ deps }) => getReviewList({ data: { tab: deps.tab } }),
  head: () => ({ meta: [{ title: "Review queue · Staff · Gridlocked" }] }),
  headers: privateHeaders,
  component: ReviewQueue,
});

const eyebrow = "text-[12px] font-bold tracking-[0.12em] text-ink-muted";

const TABS: { id: Tab; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "resolved", label: "Resolved" },
];

function ReviewQueue() {
  const result = Route.useLoaderData();
  const { tab } = Route.useSearch();
  const { pathname } = useLocation();
  const selected = pathname.split("/")[3] ?? null;

  return (
    <>
      <header className="flex flex-col gap-space-1">
        <span className={eyebrow}>RESULTS AND SCORING</span>
        <h1 className="font-display text-[36px] leading-[38px] font-normal uppercase">
          Review queue
        </h1>
        <p className="max-w-[760px] text-[16px] text-ink-muted">
          Everything a person must decide: what was found, the evidence, and
          what it holds up. Every decision takes a reason for the audit log.
        </p>
      </header>

      <nav aria-label="Review queue tabs" className="flex gap-space-2">
        {TABS.map((t) => (
          <Link
            key={t.id}
            to="/staff/review"
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
              {tab === "open"
                ? "Nothing is waiting. Items appear here when a check needs a person."
                : "Nothing has been resolved yet."}
            </p>
          ) : (
            <ul
              aria-label={tab === "open" ? "Open items" : "Resolved items"}
              className="m-0 flex list-none flex-col gap-space-2 p-0"
            >
              {result.value.map((item) => (
                <li key={item.id} data-slot="review-item">
                  <Link
                    to="/staff/review/$itemId"
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
                      {item.status === "open" ? (
                        <Badge
                          tone={
                            item.severity === "blocking" ? "caution" : "neutral"
                          }
                        >
                          {item.severity === "blocking"
                            ? "Holds scoring"
                            : "Warning"}
                        </Badge>
                      ) : (
                        <Badge>
                          {item.status === "dismissed"
                            ? "Dismissed"
                            : "Resolved"}
                        </Badge>
                      )}
                      <span className="text-[14px] text-ink-muted">
                        {item.event
                          ? `Round ${item.event.round} · ${item.whenLabel}`
                          : item.whenLabel}
                      </span>
                    </span>
                    <span className="text-[16px] font-bold">{item.title}</span>
                    {item.status === "open" ? (
                      <span className="text-[14px] text-ink-muted">
                        {item.summary}
                      </span>
                    ) : (
                      <span className="text-[14px]">
                        {item.resolution}
                        {item.reason ? ` · “${item.reason}”` : ""}
                      </span>
                    )}
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
