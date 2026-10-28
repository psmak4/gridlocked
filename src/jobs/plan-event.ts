import { and, asc, eq, ne } from "drizzle-orm";
import { events, sessions } from "@/db/schema";
import type { Db } from "@/db/types";
import { getSetting } from "@/settings";
import {
  finalizeKey,
  POLLED_KINDS,
  pollStartKey,
  ROSTER_KINDS,
  rosterKey,
  type FinalizePayload,
  type PollPayload,
  type RosterPayload,
} from "./kinds";
import { enqueue } from "./queue";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** The roster check waits this long after FP2 and FP3 end (HLD §8.2). */
const ROSTER_DELAY_MS = 30 * MINUTE_MS;

/**
 * Writes an event's calendar-driven jobs as `pending` rows with future
 * `run_at` (DM 2.10), all through `enqueue` so planning again only moves them:
 * - `poll:<session>:start` at each qualifying, sprint and race session's
 *   `scheduled_end`. Sprint qualifying has no poll: Jolpica serves no results
 *   for it;
 * - `finalize:<event>:+<h>h` at the race's `scheduled_end` plus each
 *   `finalizer_checks` setting (the last one finalizes the event);
 * - `roster:<event>:fp2|fp3` 30 minutes after that practice session ends.
 *
 * A cancelled event, and a cancelled session, get nothing. A job that is
 * running or has finished is left alone by `enqueue`, and a job planned
 * earlier for something later cancelled is left in place: its handler checks
 * the status first and does nothing. Call it when an event is created and
 * whenever its session times change.
 */
export async function planEventJobs(db: Db, eventId: string): Promise<void> {
  const [event] = await db
    .select({ id: events.id, status: events.status })
    .from(events)
    .where(eq(events.id, eventId));
  if (!event) throw new Error(`planEventJobs: no event ${eventId}`);
  if (event.status === "cancelled") return;

  const planned = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.eventId, eventId), ne(sessions.status, "cancelled")))
    .orderBy(asc(sessions.scheduledStart), asc(sessions.sequence));
  const { afterHours } = await getSetting(db, "finalizer_checks");
  const hours = [...new Set(afterHours)].sort((a, b) => a - b);

  await db.transaction(async (tx) => {
    for (const session of planned) {
      if ((POLLED_KINDS as readonly string[]).includes(session.kind)) {
        const payload: PollPayload = { sessionId: session.id, attempt: 0 };
        await enqueue(tx, {
          kind: "poll_session",
          dedupeKey: pollStartKey(session.id),
          runAt: session.scheduledEnd,
          payload,
        });
      }
    }

    // The first practice session of each kind (a format never has two).
    for (const kind of ROSTER_KINDS) {
      const session = planned.find((s) => s.kind === kind);
      if (!session) continue;
      const payload: RosterPayload = { eventId, sessionId: session.id };
      await enqueue(tx, {
        kind: "roster_check",
        dedupeKey: rosterKey(eventId, kind),
        runAt: new Date(session.scheduledEnd.getTime() + ROSTER_DELAY_MS),
        payload,
      });
    }

    // Relative to the last race of the event.
    const race = planned
      .filter((s) => s.kind === "race")
      .sort((a, b) => b.scheduledEnd.getTime() - a.scheduledEnd.getTime())[0];
    if (race) {
      for (const [i, h] of hours.entries()) {
        const payload: FinalizePayload = {
          eventId,
          afterHours: h,
          final: i === hours.length - 1,
        };
        await enqueue(tx, {
          kind: "finalize_check",
          dedupeKey: finalizeKey(eventId, h),
          runAt: new Date(race.scheduledEnd.getTime() + h * HOUR_MS),
          payload,
        });
      }
    }
  });
}
