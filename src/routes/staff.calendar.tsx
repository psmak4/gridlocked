import { useState } from "react";
import {
  createFileRoute,
  Outlet,
  useLocation,
  useRouter,
} from "@tanstack/react-router";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { privateHeaders } from "@/lib/private-headers";
import { cn } from "@/lib/utils";
import { getCalendar, syncCalendarNow } from "@/server/staff";
import { STAFF_ERROR_WORDS } from "@/staff/errors";

/**
 * The calendar (wave 5, M8 Task 5): the season's events with their locks, in
 * UTC, and **Sync now**. Picking an event opens its editing panel beside the
 * table (`/staff/calendar/$eventId`); on a narrow screen the panel follows it.
 */
export const Route = createFileRoute("/staff/calendar")({
  loader: () => getCalendar({ data: {} }),
  head: () => ({ meta: [{ title: "Calendar · Staff · Gridlocked" }] }),
  headers: privateHeaders,
  component: Calendar,
});

const COLUMNS = ["RD", "EVENT", "DATES", "LOCK (UTC)", "STATUS"] as const;

function Calendar() {
  const result = Route.useLoaderData();
  const router = useRouter();
  const { pathname } = useLocation();
  const [sync, setSync] = useState<
    | { state: "idle" }
    | { state: "busy" }
    | { state: "done" | "error"; words: string }
  >({ state: "idle" });

  if (!result.ok) {
    return (
      <>
        <h1 className="font-display text-[32px] leading-[36px] uppercase">
          Calendar
        </h1>
        <p role="alert" className="text-[16px] font-semibold text-fall">
          {STAFF_ERROR_WORDS[result.error]}
        </p>
      </>
    );
  }
  const list = result.value;
  const selected = pathname.split("/")[3] ?? null;
  const summary = [
    `${list.rounds} rounds`,
    list.cancelled > 0 ? `${list.cancelled} cancelled` : null,
    list.syncedLabel ? `last synced ${list.syncedLabel}` : "not synced yet",
    "times in UTC",
  ].filter(Boolean);

  const syncNow = async () => {
    setSync({ state: "busy" });
    const answer = await syncCalendarNow({ data: { season: list.season } });
    if (answer.ok) {
      setSync({
        state: "done",
        words: answer.value.created
          ? "Sync queued. It runs within a few minutes."
          : "A sync is already queued for today.",
      });
      await router.invalidate();
    } else {
      setSync({ state: "error", words: STAFF_ERROR_WORDS[answer.error] });
    }
  };

  return (
    <>
      <header className="flex flex-wrap items-end justify-between gap-space-4">
        <div className="flex flex-col gap-space-1">
          <h1 className="font-display text-[36px] leading-[38px] font-normal uppercase">
            {list.season} calendar
          </h1>
          <p className="text-[16px] text-ink-muted">{summary.join(" · ")}</p>
        </div>
        <div className="flex flex-col items-end gap-space-1">
          <Button
            variant="secondary"
            onClick={syncNow}
            disabled={sync.state === "busy"}
          >
            Sync now
          </Button>
          {sync.state === "done" || sync.state === "error" ? (
            <p
              role={sync.state === "error" ? "alert" : "status"}
              className={cn(
                "text-[14px]",
                sync.state === "error"
                  ? "font-semibold text-fall"
                  : "text-ink-muted",
              )}
            >
              {sync.words}
            </p>
          ) : null}
        </div>
      </header>

      <div className="flex flex-wrap items-start gap-space-5">
        <div className="min-w-0 flex-[3_1_560px] overflow-x-auto rounded-radius-l bg-surface-raised">
          {list.events.length === 0 ? (
            <p className="p-space-4 text-[16px] text-ink-muted">
              No events for {list.season} yet. Sync the calendar to load them.
            </p>
          ) : (
            <table className="w-full min-w-[600px] border-collapse text-left text-[16px]">
              <thead>
                <tr className="text-[12px] tracking-[0.12em] text-ink-muted">
                  {COLUMNS.map((c, i) => (
                    <th
                      key={c}
                      scope="col"
                      className={cn(
                        "py-space-3 font-bold",
                        i === 0 || i === COLUMNS.length - 1
                          ? "px-space-4"
                          : "px-space-2",
                      )}
                    >
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {list.events.map((e) => {
                  const isSelected = e.id === selected;
                  return (
                    <tr
                      key={e.id}
                      data-slot="calendar-row"
                      className={cn(
                        "border-t border-line",
                        isSelected &&
                          "bg-surface outline-2 -outline-offset-2 outline-ink",
                      )}
                    >
                      <td className="px-space-4 py-[10px] font-numeric font-bold">
                        {e.badge.label === "Cancelled" ? "–" : e.round}
                      </td>
                      <td className="px-space-2 py-[10px]">
                        <a
                          href={`/staff/calendar/${e.id}`}
                          aria-current={isSelected ? "page" : undefined}
                          className="flex min-h-[44px] flex-col justify-center text-ink no-underline outline-none hover:underline focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                        >
                          <span className="font-bold">{e.name}</span>
                          <span className="text-[14px] text-ink-muted">
                            {e.circuit}
                            {e.lockAtSource === "admin"
                              ? " · lock set by hand"
                              : ""}
                          </span>
                        </a>
                      </td>
                      <td className="px-space-2 py-[10px] text-ink-muted">
                        {e.dates}
                      </td>
                      <td className="px-space-2 py-[10px] font-numeric font-semibold">
                        {e.lock}
                      </td>
                      <td className="px-space-4 py-[10px]">
                        <Badge tone={e.badge.tone}>{e.badge.label}</Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        <Outlet />
      </div>
    </>
  );
}
