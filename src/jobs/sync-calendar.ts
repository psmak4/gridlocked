import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { events, jobs, seasons, sessions } from "@/db/schema";
import type { Db } from "@/db/types";
import { getSetting } from "@/settings";
import { syncEventEntries } from "@/reference/sync-event-entries";
import { republishIfEarlier, type DueStore } from "./due-times";
import { planEventJobs } from "./plan-event";
import { syncCalendarKey, syncCalendarPayload } from "./kinds";
import type { CalendarSyncSource } from "./ports";
import type { ClockDb } from "@/lib/resolve-clock";
import { enqueue, type JobsDb } from "./queue";
import type { JobHandler } from "./runner";

/**
 * Enqueues the season's calendar sync for the UTC day of `now`, due now. A
 * second call on the same day finds the same job (dedupe key
 * `sync_calendar:<season>:<yyyy-mm-dd>`). Callers outside a tick (an admin
 * action) pass the due-times `store` so the file moves earlier to `now`; the
 * tick itself republishes after every run and needs no store.
 */
export async function enqueueCalendarSync(
  db: JobsDb & ClockDb,
  now: Date,
  season: number,
  store?: DueStore,
) {
  const result = await enqueue(db, {
    kind: "sync_calendar",
    dedupeKey: syncCalendarKey(season, now.toISOString().slice(0, 10)),
    runAt: now,
    payload: { season },
  });
  if (store) await republishIfEarlier(db, store, now, now);
  return result;
}

/** The next day's sync runs at this hour, UTC (before any session of the day). */
const SYNC_HOUR_UTC = 6;
const DAY_MS = 24 * 3_600_000;

/** The instant of the next day's sync: 06:00 UTC on the day after `now`'s. */
function tomorrowsSyncAt(now: Date): Date {
  const midnight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  return new Date(midnight + DAY_MS + SYNC_HOUR_UTC * 3_600_000);
}

/**
 * The backstop for the sync's own chain (the safety tick calls it): the season
 * to sync is the one whose row is `active`, else the year of `now`. If no
 * `sync_calendar` job for it is `pending` or `failed` (a failed one is waiting
 * for its retry), enqueues one due now. Returns whether it enqueued one.
 */
export async function ensureCalendarSync(
  db: JobsDb & ClockDb,
  now: Date,
): Promise<boolean> {
  const [active] = await db
    .select({ year: seasons.year })
    .from(seasons)
    .where(eq(seasons.status, "active"))
    .orderBy(desc(seasons.year))
    .limit(1);
  const season = active?.year ?? now.getUTCFullYear();
  const [waiting] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.kind, "sync_calendar"),
        inArray(jobs.status, ["pending", "failed"]),
        sql`${jobs.payload}->>'season' = ${String(season)}`,
      ),
    )
    .limit(1);
  if (waiting) return false;
  return (await enqueueCalendarSync(db, now, season)).created;
}

/**
 * The `sync_calendar` handler (HLD §4.5): fetch the season's calendar, drivers
 * and constructors and apply them (through the port), then for every event
 * still to be run (`scheduled`: not cancelled, not completed) copy the seats
 * onto its entries and plan its jobs. Both steps are idempotent, so a run
 * that finds nothing new changes nothing; a session time that moved moves its
 * pending jobs.
 *
 * Only events still to finish are planned: those whose latest race ends, plus
 * the last `finalizer_checks` delay, after now (the same for an event with no
 * race, by its last session). A past event is left exactly as it is, so the
 * first sync after the 2026 import (`importSeason2026`, which finalizes
 * nothing, so its rounds stay `provisional`) does not queue a backlog of
 * polls and finalize checks for weekends that are over.
 *
 * The last thing it does is enqueue the next day's sync at 06:00 UTC, which is
 * what makes the sync recur. A run that fails enqueues nothing: the runner's
 * retry does, and the safety tick (`ensureCalendarSync`) restarts a chain
 * that has been lost.
 */
export function createSyncCalendarHandler(
  source: CalendarSyncSource,
): JobHandler {
  return async (job, ctx) => {
    const db = ctx.db as Db;
    const { season } = syncCalendarPayload.parse(job.payload);
    await source.sync(db, ctx.clock, season, job.id);

    const now = ctx.clock.now();
    const { afterHours } = await getSetting(db, "finalizer_checks");
    const settle = Math.max(...afterHours) * 3_600_000;
    const todo = await db
      .select({ id: events.id })
      .from(events)
      .innerJoin(seasons, eq(seasons.id, events.seasonId))
      .where(and(eq(seasons.year, season), eq(events.status, "scheduled")))
      .orderBy(asc(events.round));
    for (const { id } of todo) {
      const ends = await db
        .select({ kind: sessions.kind, end: sessions.scheduledEnd })
        .from(sessions)
        .where(and(eq(sessions.eventId, id), ne(sessions.status, "cancelled")));
      const races = ends.filter((s) => s.kind === "race");
      const last = Math.max(
        ...(races.length > 0 ? races : ends).map((s) => s.end.getTime()),
      );
      if (ends.length > 0 && last + settle <= now.getTime()) continue;
      await syncEventEntries(db, id, now);
      await planEventJobs(db, id);
    }

    const next = tomorrowsSyncAt(now);
    await enqueue(db, {
      kind: "sync_calendar",
      dedupeKey: syncCalendarKey(season, next.toISOString().slice(0, 10)),
      runAt: next,
      payload: { season },
    });
  };
}
