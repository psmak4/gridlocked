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
 * What the staff actions need from the adapters, injected by the caller
 * (scripts/staff.ts) since only adapters know providers exist (HLD §3.3).
 */
export interface StaffDeps {
  /** Re-stores a practice session's participants from its stored answer. */
  rematchParticipants?(db: Db, now: Date, sessionId: string): Promise<void>;
}

/**
 * Checks an event again after staff change who is expected there: FP2's and
 * FP3's participants are matched again against the new entries (when
 * `deps.rematchParticipants` is given), then the roster check, then
 * `advanceStatus` for every scored session that has results (a
 * `session_result_state` row). A `final` session is left as it is.
 */
export async function revalidateEvent(
  db: Db,
  now: Date,
  eventId: string,
  deps: StaffDeps = {},
): Promise<SessionMove[]> {
  if (deps.rematchParticipants) {
    const practice = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          eq(sessions.eventId, eventId),
          inArray(sessions.kind, ["fp2", "fp3"]),
        ),
      );
    for (const p of practice) await deps.rematchParticipants(db, now, p.id);
  }
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
