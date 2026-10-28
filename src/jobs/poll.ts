import { eq, sql } from "drizzle-orm";
import { sessionResultState } from "@/db/schema";
import type { Db } from "@/db/types";
import { openReviewItem } from "@/reference/review";
import { advanceStatus, type SessionResultStatus } from "@/results/status";
import { validateSession } from "@/results/validate";
import { getSetting } from "@/settings";
import { pollAttemptKey, pollPayload, type PollPayload } from "./kinds";
import { ProviderUnavailableError, type ResultsSource } from "./ports";
import { enqueue } from "./queue";
import type { JobHandler } from "./runner";
import { loadSession, type SessionInfo } from "./session-info";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * The `poll_session` handler (HLD §4.4): fetch the session's results,
 * normalize them and advance the status. The planned start job is attempt 0.
 * While the session is still `awaiting`, the next attempt
 * `poll:<session>:<attempt + 1>` is enqueued at `poll_schedule` backoff
 * `[attempt]` minutes (the last step repeats): +5, +15, then hourly.
 *
 * Once `scheduled_end + giveUpAfterHours` has passed with nothing to show,
 * the poller gives up (see `giveUp`). Any other status ends the chain: a
 * session under review waits for an admin, a provisional one is re-checked by
 * the finalizer.
 *
 * A provider outage (`ProviderUnavailableError`) counts as "still awaiting":
 * nothing is recorded, the next attempt is enqueued as usual, and the window
 * still ends in the give-up. Poll attempts never end the chain by failing.
 *
 * Does nothing for a cancelled session or event, or a final session. Safe to
 * run twice for the same attempt: normalization of a snapshot already
 * applied writes nothing and the next attempt has a fixed dedupe key.
 */
export function createPollHandler(source: ResultsSource): JobHandler {
  return async (job, ctx) => {
    const db = ctx.db as Db;
    const { sessionId, attempt } = pollPayload.parse(job.payload);
    const session = await loadSession(db, sessionId);
    if (session.cancelled) return;

    const [before] = await db
      .select({ status: sessionResultState.status })
      .from(sessionResultState)
      .where(eq(sessionResultState.sessionId, sessionId));
    if (before?.status === "final") return;

    // A provider outage is "no news": nothing is recorded and polling goes on
    // with the usual backoff until the window runs out. Any other error is a
    // bug or a database failure and fails the job.
    let status: SessionResultStatus;
    try {
      const fetched = await source.fetch(db, session, job.id);
      await source.normalize(
        db,
        ctx.clock.now(),
        session,
        fetched.snapshotId,
        fetched.body,
      );
      status = await advanceStatus(db, ctx.clock.now(), sessionId);
    } catch (error) {
      if (!(error instanceof ProviderUnavailableError)) throw error;
      // The state row carries the attempt count and the give-up time.
      await db
        .insert(sessionResultState)
        .values({ sessionId })
        .onConflictDoNothing();
      status = before?.status ?? "awaiting";
    }
    const now = ctx.clock.now();

    // `greatest`: a late duplicate of an older attempt cannot lower the count.
    await db
      .update(sessionResultState)
      .set({
        pollAttempts: sql`greatest(${sessionResultState.pollAttempts}, ${attempt + 1})`,
        nextPollAt: null,
      })
      .where(eq(sessionResultState.sessionId, sessionId));
    if (status !== "awaiting") return;

    const { backoffMinutes, giveUpAfterHours } = await getSetting(
      db,
      "poll_schedule",
    );
    const deadline =
      session.scheduledEnd.getTime() + giveUpAfterHours * HOUR_MS;
    if (now.getTime() >= deadline) {
      await giveUp(db, now, session);
      return;
    }

    const gap = backoffMinutes[Math.min(attempt, backoffMinutes.length - 1)]!;
    const nextAt = new Date(now.getTime() + gap * MINUTE_MS);
    const payload: PollPayload = { sessionId, attempt: attempt + 1 };
    await enqueue(db, {
      kind: "poll_session",
      dedupeKey: pollAttemptKey(sessionId, attempt + 1),
      runAt: nextAt,
      payload,
    });
    await db
      .update(sessionResultState)
      .set({ nextPollAt: nextAt })
      .where(eq(sessionResultState.sessionId, sessionId));
  };
}

/**
 * The poll window ran out (DM 2.3), in one transaction:
 * - `gave_up_at` is set (once: a repeat keeps the first time);
 * - a blocking `poll_gave_up` item raises the admin alert;
 * - if the session is incomplete, a blocking `missing_driver` item for each
 *   entered driver with no row (controller ruling R16). These keep their own
 *   `poll_gave_up:` keys, so the validator's reconciliation never closes them:
 *   an admin decides, e.g. by entering the results by hand.
 * Then the status is advanced, which holds the session as `under_review`.
 */
async function giveUp(db: Db, now: Date, session: SessionInfo): Promise<void> {
  await db.transaction(async (tx) => {
    const [state] = await tx
      .select()
      .from(sessionResultState)
      .where(eq(sessionResultState.sessionId, session.id))
      .for("update");
    if (state && state.gaveUpAt === null) {
      await tx
        .update(sessionResultState)
        .set({ gaveUpAt: now, nextPollAt: null, version: state.version + 1 })
        .where(eq(sessionResultState.sessionId, session.id));
    }

    const where = {
      seasonId: session.seasonId,
      eventId: session.eventId,
      sessionId: session.id,
    };
    await openReviewItem(tx, now, {
      kind: "poll_gave_up",
      severity: "blocking",
      ...where,
      details: { scheduledEnd: session.scheduledEnd.toISOString() },
      dedupeKey: `poll_gave_up:${session.id}`,
    });

    const incomplete = (await validateSession(tx, session.id)).find(
      (p) => p.kind === "incomplete",
    );
    for (const driverId of (incomplete?.details.missingDriverIds ??
      []) as string[]) {
      await openReviewItem(tx, now, {
        kind: "missing_driver",
        severity: "blocking",
        ...where,
        driverId,
        details: { driverId, reason: "poll_gave_up" },
        dedupeKey: `poll_gave_up:${session.id}:missing:${driverId}`,
      });
    }
  });
  await advanceStatus(db, now, session.id);
}
