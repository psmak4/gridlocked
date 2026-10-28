import type { Db } from "@/db/types";
import { rosterCheck } from "@/reference/roster-check";
import { rosterPayload } from "./kinds";
import type { ParticipantsSource } from "./ports";
import type { JobHandler } from "./runner";
import { loadSession } from "./session-info";

/**
 * The `roster_check` handler (HLD §8.2): fetch who took part in the practice
 * session, store them, and compare FP2 and FP3 with the event's entries.
 * Surprises become warnings in the review queue; a session OpenF1 does not
 * have yet fails the job, so the runner retries it. Does nothing for a
 * cancelled session or event. Safe to repeat: participants are replaced and
 * the findings are reconciled.
 */
export function createRosterHandler(source: ParticipantsSource): JobHandler {
  return async (job, ctx) => {
    const db = ctx.db as Db;
    const { eventId, sessionId } = rosterPayload.parse(job.payload);
    const session = await loadSession(db, sessionId);
    if (session.cancelled) return;
    if (session.eventId !== eventId) {
      throw new Error(`session ${sessionId} is not in event ${eventId}`);
    }
    await source.refresh(db, ctx.clock.now(), session, job.id);
    await rosterCheck(db, ctx.clock.now(), eventId);
  };
}
