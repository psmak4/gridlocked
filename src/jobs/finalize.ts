import { and, asc, eq, inArray, ne, or } from "drizzle-orm";
import { events, reviewItems, sessionResultState, sessions } from "@/db/schema";
import type { Db } from "@/db/types";
import { reconcileWarnings } from "@/reference/review";
import { advanceStatus } from "@/results/status";
import { SCORED_KINDS } from "@/results/validate";
import { finalizePayload } from "./kinds";
import type { ResultsSource } from "./ports";
import type { JobHandler } from "./runner";
import { loadSession } from "./session-info";

/** Sessions the finalizer re-fetches: where late penalties change the order. */
const REFETCHED_KINDS = ["sprint", "race"] as const;

/**
 * The `finalize_check` handler (HLD §4.4). At each check after the race it
 * re-fetches the race (and the sprint, if the event has one) and compares the
 * snapshot with the one the results came from. A different snapshot is
 * normalized, which logs `result_changes`; `advanceStatus` then runs for every
 * re-fetched session, as it must after any normalization.
 *
 * The last check (`final` in the payload, the +48 h one) also finalizes the
 * event, if it can: every scored session of the event has to be `provisional`
 * and no blocking review item may be open. Then each becomes `final`
 * (`finalized_at` = now) and the event `completed`, in one transaction. If it
 * cannot, nothing changes and a `finalize_held:<event>` warning says why; the
 * warning closes itself once a later run of the check does finalize.
 *
 * Does nothing for a cancelled or completed event. A session that is already
 * final (an admin's call) is left exactly as it is.
 */
export function createFinalizeHandler(source: ResultsSource): JobHandler {
  return async (job, ctx) => {
    const db = ctx.db as Db;
    const { eventId, final } = finalizePayload.parse(job.payload);
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
          inArray(sessions.kind, [...REFETCHED_KINDS]),
        ),
      )
      .orderBy(asc(sessions.scheduledStart), asc(sessions.sequence));

    for (const { id } of targets) {
      const session = await loadSession(db, id);
      const [state] = await db
        .select()
        .from(sessionResultState)
        .where(eq(sessionResultState.sessionId, id));
      if (state?.status === "final") continue;

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
      await advanceStatus(db, ctx.clock.now(), id);
    }

    if (final) await finalizeEvent(db, ctx.clock.now(), event);
  };
}

/** Finalizes the event or records why not. See `createFinalizeHandler`. */
async function finalizeEvent(
  db: Db,
  now: Date,
  event: typeof events.$inferSelect,
): Promise<void> {
  await db.transaction(async (tx) => {
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

    const heldKey = `finalize_held:${event.id}`;
    if (scored.length === 0 || notReady.length > 0 || blocking.length > 0) {
      await reconcileWarnings(tx, now, heldKey, [
        {
          kind: "finalize_held",
          seasonId: event.seasonId,
          eventId: event.id,
          details: {
            scoredSessions: scored.length,
            notProvisional: notReady,
            openBlockingItems: blocking.length,
          },
          dedupeKey: heldKey,
        },
      ]);
      return;
    }

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
  });
}
