import type { Db } from "@/db/types";
import { openReviewItem } from "@/reference/review";
import { rosterCheck } from "@/reference/roster-check";
import { getSetting } from "@/settings";
import {
  rosterPayload,
  rosterRetryKey,
  type RosterKind,
  type RosterPayload,
} from "./kinds";
import { ProviderUnavailableError, type ParticipantsSource } from "./ports";
import { enqueue } from "./queue";
import type { JobHandler } from "./runner";
import { loadSession } from "./session-info";

const MINUTE_MS = 60_000;
/** Re-checks stop this long after the practice session ends. */
const GIVE_UP_AFTER_MS = 6 * 3_600_000;

/**
 * The `roster_check` handler (HLD §8.2): fetch who took part in the practice
 * session, store them, and compare FP2 and FP3 with the event's entries.
 * Surprises become warnings in the review queue. Does nothing for a cancelled
 * session or event. Safe to repeat: participants are replaced and the
 * findings are reconciled.
 *
 * A session OpenF1 has no answer for yet (it publishes a little after the
 * session ends) is treated like an outage, not a failure: the job succeeds and
 * enqueues `roster:<event>:<kind>:retry:<n>` at the `poll_schedule` backoff
 * (5, 15, then hourly), the last one no later than the session's end plus six
 * hours. If the answer is still missing then, a `roster_unavailable` warning
 * says so and the check ends. Any other error still fails the job.
 */
export function createRosterHandler(source: ParticipantsSource): JobHandler {
  return async (job, ctx) => {
    const db = ctx.db as Db;
    const {
      eventId,
      sessionId,
      attempt = 0,
    } = rosterPayload.parse(job.payload);
    const session = await loadSession(db, sessionId);
    if (session.cancelled) return;
    if (session.eventId !== eventId) {
      throw new Error(`session ${sessionId} is not in event ${eventId}`);
    }
    const now = ctx.clock.now();
    try {
      await source.refresh(db, now, session, job.id);
    } catch (error) {
      if (!(error instanceof ProviderUnavailableError)) throw error;
      const deadline = session.scheduledEnd.getTime() + GIVE_UP_AFTER_MS;
      if (now.getTime() >= deadline) {
        await openReviewItem(db, now, {
          kind: "roster_unavailable",
          severity: "warning",
          seasonId: session.seasonId,
          eventId,
          sessionId,
          details: {
            kind: session.kind,
            attempts: attempt + 1,
            lastError: error.message,
          },
          dedupeKey: `roster_unavailable:${sessionId}`,
        });
        return;
      }
      const { backoffMinutes } = await getSetting(db, "poll_schedule");
      const gap = backoffMinutes[Math.min(attempt, backoffMinutes.length - 1)]!;
      const payload: RosterPayload = {
        eventId,
        sessionId,
        attempt: attempt + 1,
      };
      await enqueue(db, {
        kind: "roster_check",
        dedupeKey: rosterRetryKey(
          eventId,
          session.kind as RosterKind,
          attempt + 1,
        ),
        runAt: new Date(Math.min(now.getTime() + gap * MINUTE_MS, deadline)),
        payload,
      });
      return;
    }
    await rosterCheck(db, now, eventId);
  };
}
