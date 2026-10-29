import { and, asc, desc, eq, inArray, ne, or } from "drizzle-orm";
import { events, reviewItems, sessionResultState, sessions } from "@/db/schema";
import type { Db } from "@/db/types";
import { reconcileWarnings } from "@/reference/review";
import { advanceStatus } from "@/results/status";
import { SCORED_KINDS } from "@/results/validate";
import {
  finalizeHeldKey,
  finalizePayload,
  type FinalizePayload,
} from "./kinds";
import { ProviderUnavailableError, type ResultsSource } from "./ports";
import { enqueue } from "./queue";
import type { JobHandler } from "./runner";
import { loadSession } from "./session-info";

/** A held event is looked at again this often (an hour if the provider was down). */
const HELD_RECHECK_MS = 6 * 3_600_000;
const OUTAGE_RECHECK_MS = 3_600_000;
/** Re-checking stops this long after the race ends; the warning stays open. */
const HELD_WINDOW_MS = 14 * 24 * 3_600_000;

/**
 * The `finalize_check` handler (HLD §4.4). At each check after the race it
 * re-fetches every scored session of the event (`SCORED_KINDS`: qualifying,
 * the sprint if there is one, and the race: a post-session disqualification
 * changes qualifying as much as a penalty changes the race) and compares the
 * snapshot with the one the results came from. A different snapshot is
 * normalized, which logs `result_changes`.
 *
 * `advanceStatus` then runs for each of those sessions that is not final or
 * cancelled, whether or not the re-fetch worked and whether or not anything
 * changed. That is what moves a session whose blocking item an admin resolved
 * (resolving it does not move the status itself) on to `provisional`, so
 * every check, not only the last one, leaves the statuses current before the
 * event is judged.
 *
 * The last planned check (`final` in the payload, the +48 h one) also
 * finalizes the event, if it can: every scored session of the event has to be
 * `provisional` and no blocking review item may be open. Then each becomes
 * `final` (`finalized_at` = now) and the event `completed`, in one
 * transaction.
 *
 * If it cannot, nothing changes and a `finalize_held:<event>` warning says
 * why. The event is not left to wait for the next admin action: a follow-up
 * check `finalize:<event>:held:<n>` (also `final`) is enqueued 6 h later, and
 * again after each hold, so once the blocker is resolved a later check
 * finalizes it and closes the warning. The follow-ups stop 14 days after the
 * race ends; the warning then stays open, with `recheckStopped` in its
 * details, for an admin to deal with.
 *
 * A provider outage skips that session's re-fetch at the early checks. At a
 * `final` check it also holds the event, even if everything else is ready:
 * finalizing on data that could not be re-checked would shut out a late
 * correction. The follow-up is then 1 h away, and a warning is only opened if
 * the outage lasts to the end of the 14 days.
 *
 * Does nothing for a cancelled or completed event. A session that is already
 * final (an admin's call) is left exactly as it is.
 */
export function createFinalizeHandler(source: ResultsSource): JobHandler {
  return async (job, ctx) => {
    const db = ctx.db as Db;
    const { eventId, final, afterHours, held } = finalizePayload.parse(
      job.payload,
    );
    const [event] = await db
      .select()
      .from(events)
      .where(eq(events.id, eventId));
    if (!event) throw new Error(`finalize: no event ${eventId}`);
    if (event.status !== "scheduled") return;

    const targets = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          eq(sessions.eventId, eventId),
          ne(sessions.status, "cancelled"),
          inArray(sessions.kind, [...SCORED_KINDS]),
        ),
      )
      .orderBy(asc(sessions.scheduledStart), asc(sessions.sequence));

    let unavailable = false;
    for (const { id } of targets) {
      const session = await loadSession(db, id);
      const [state] = await db
        .select()
        .from(sessionResultState)
        .where(eq(sessionResultState.sessionId, id));
      if (state?.status === "final") continue;

      // A failed re-fetch just skips this session's check: the next check (or
      // the final one, on what is stored) goes on.
      try {
        const fetched = await source.fetch(db, session, job.id);
        if (fetched.snapshotId !== (state?.currentSnapshotId ?? null)) {
          await source.normalize(
            db,
            ctx.clock.now(),
            session,
            fetched.snapshotId,
            fetched.body,
          );
        }
      } catch (error) {
        if (!(error instanceof ProviderUnavailableError)) throw error;
        unavailable = true;
      }
      await advanceStatus(db, ctx.clock.now(), id);
    }

    if (!final) return;
    const recheckAt = await finalizeEvent(
      db,
      ctx.clock.now(),
      event,
      unavailable,
    );
    if (recheckAt) {
      const n = (held ?? 0) + 1;
      const payload: FinalizePayload = {
        eventId,
        afterHours,
        final: true,
        held: n,
      };
      await enqueue(db, {
        kind: "finalize_check",
        dedupeKey: finalizeHeldKey(eventId, n),
        runAt: recheckAt,
        payload,
      });
    }
  };
}

/**
 * Finalizes the event or records why not (see `createFinalizeHandler`).
 * Returns when to check again, or null when it finalized or the re-check
 * window is over.
 */
async function finalizeEvent(
  db: Db,
  now: Date,
  event: typeof events.$inferSelect,
  unavailable: boolean,
): Promise<Date | null> {
  return db.transaction(async (tx) => {
    const scored = (
      await tx
        .select({ id: sessions.id, kind: sessions.kind })
        .from(sessions)
        .where(
          and(
            eq(sessions.eventId, event.id),
            ne(sessions.status, "cancelled"),
            inArray(sessions.kind, [...SCORED_KINDS]),
          ),
        )
        .orderBy(asc(sessions.scheduledStart), asc(sessions.sequence))
    ).filter((s) => SCORED_KINDS.includes(s.kind));
    const ids = scored.map((s) => s.id);

    // Lock the state rows, so the status can't move under this check.
    const states = new Map(
      (ids.length === 0
        ? []
        : await tx
            .select()
            .from(sessionResultState)
            .where(inArray(sessionResultState.sessionId, ids))
            .for("update")
      ).map((s) => [s.sessionId, s]),
    );
    const notReady = scored
      .map((s) => ({
        sessionId: s.id,
        kind: s.kind,
        status: states.get(s.id)?.status ?? "awaiting",
      }))
      .filter((s) => s.status !== "provisional");

    const blocking = await tx
      .select({ id: reviewItems.id })
      .from(reviewItems)
      .where(
        and(
          eq(reviewItems.status, "open"),
          eq(reviewItems.severity, "blocking"),
          or(
            eq(reviewItems.eventId, event.id),
            ids.length === 0 ? undefined : inArray(reviewItems.sessionId, ids),
          ),
        ),
      );

    const [race] = await tx
      .select({ end: sessions.scheduledEnd })
      .from(sessions)
      .where(
        and(
          eq(sessions.eventId, event.id),
          eq(sessions.kind, "race"),
          ne(sessions.status, "cancelled"),
        ),
      )
      .orderBy(desc(sessions.scheduledEnd))
      .limit(1);
    const stopped =
      !race || now.getTime() >= race.end.getTime() + HELD_WINDOW_MS;
    const recheckAt = stopped
      ? null
      : new Date(
          now.getTime() + (unavailable ? OUTAGE_RECHECK_MS : HELD_RECHECK_MS),
        );

    const heldKey = `finalize_held:${event.id}`;
    const blocked =
      scored.length === 0 || notReady.length > 0 || blocking.length > 0;
    // An outage alone is not worth a warning until the re-checks run out.
    if (blocked || (unavailable && stopped)) {
      await reconcileWarnings(tx, now, heldKey, [
        {
          kind: "finalize_held",
          seasonId: event.seasonId,
          eventId: event.id,
          details: {
            scoredSessions: scored.length,
            notProvisional: notReady,
            openBlockingItems: blocking.length,
            providerUnavailable: unavailable,
            recheckStopped: stopped,
          },
          dedupeKey: heldKey,
        },
      ]);
    }
    if (blocked || unavailable) return recheckAt;

    for (const id of ids) {
      const state = states.get(id)!;
      await tx
        .update(sessionResultState)
        .set({ status: "final", finalizedAt: now, version: state.version + 1 })
        .where(eq(sessionResultState.sessionId, id));
    }
    await tx
      .update(events)
      .set({ status: "completed", updatedAt: now })
      .where(eq(events.id, event.id));
    await reconcileWarnings(tx, now, heldKey, []);
    return null;
  });
}
