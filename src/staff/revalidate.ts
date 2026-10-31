import { and, eq, inArray } from "drizzle-orm";
import { sessionResultState, sessions } from "@/db/schema";
import type { Db } from "@/db/types";
import { rosterCheck } from "@/reference/roster-check";
import { advanceStatus } from "@/results/status";
import { SCORED_KINDS } from "@/results/validate";

/** How one session's status moved when an event was checked again. */
export interface SessionMove {
  sessionId: string;
  kind: string;
  previous: string;
  next: string;
}

/**
 * Checks an event again after staff change who is expected there: the roster
 * check, then `advanceStatus` for every scored session that has results
 * (a `session_result_state` row). A `final` session is left as it is.
 */
export async function revalidateEvent(
  db: Db,
  now: Date,
  eventId: string,
): Promise<SessionMove[]> {
  await rosterCheck(db, now, eventId);
  const scored = await db
    .select({ id: sessions.id, kind: sessions.kind })
    .from(sessions)
    .innerJoin(
      sessionResultState,
      eq(sessionResultState.sessionId, sessions.id),
    )
    .where(
      and(
        eq(sessions.eventId, eventId),
        inArray(sessions.kind, [...SCORED_KINDS]),
      ),
    )
    .orderBy(sessions.scheduledStart);
  const moves: SessionMove[] = [];
  for (const s of scored) {
    const advance = await advanceStatus(db, now, s.id);
    moves.push({
      sessionId: s.id,
      kind: s.kind,
      previous: advance.previous,
      next: advance.next,
    });
  }
  return moves;
}
