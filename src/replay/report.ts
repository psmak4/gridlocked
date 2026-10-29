import { and, asc, count, eq, ne } from "drizzle-orm";
import {
  jobs,
  resultChanges,
  reviewItems,
  sessionResultState,
  sessions,
  events,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { SCORED_KINDS } from "@/results/validate";

/** What a replayed weekend left behind. */
export interface ReplayReport {
  /** Result status of each scored session that ran, by session kind. */
  sessionStatuses: Record<string, string>;
  /** Scored sessions with no recorded results, cancelled in the setup. */
  cancelledSessions: string[];
  eventStatus: string;
  /** Review items opened during the replay, by kind. */
  reviewItems: Record<string, number>;
  resultChanges: number;
  /**
   * Jobs of the replayed event by status: its polls, roster checks and
   * finalize checks. The calendar syncs, and the jobs the syncs plan for the
   * season's other events, are not part of one weekend.
   */
  jobs: Record<string, number>;
  /** The daily calendar syncs (HLD §4.5) by status. */
  calendarSyncs: Record<string, number>;
  /**
   * Ticks that opened the database (the rest only read the due-times file):
   * one per minute that ran a job, the event's or a calendar sync.
   */
  wakeTicks: number;
}

/**
 * Reads the report off the database. The replay database starts empty, so
 * every review item, result change and job in it belongs to this replay.
 */
export async function buildReport(
  db: Db,
  eventId: string,
  extras: { wakeTicks: number; cancelledSessions: string[] },
): Promise<ReplayReport> {
  const [event] = await db
    .select({ status: events.status })
    .from(events)
    .where(eq(events.id, eventId));
  if (!event) throw new Error(`report: no event ${eventId}`);

  const scored = await db
    .select({
      kind: sessions.kind,
      status: sessionResultState.status,
    })
    .from(sessions)
    .leftJoin(sessionResultState, eq(sessionResultState.sessionId, sessions.id))
    .where(and(eq(sessions.eventId, eventId), ne(sessions.status, "cancelled")))
    .orderBy(asc(sessions.scheduledStart), asc(sessions.sequence));
  const sessionStatuses: Record<string, string> = {};
  for (const row of scored) {
    if (SCORED_KINDS.includes(row.kind)) {
      sessionStatuses[row.kind] = row.status ?? "awaiting";
    }
  }

  const byKind: Record<string, number> = {};
  const items = await db
    .select({ kind: reviewItems.kind, n: count() })
    .from(reviewItems)
    .groupBy(reviewItems.kind);
  for (const { kind, n } of items) byKind[kind] = n;

  // Poll and roster jobs name a session, finalize jobs the event.
  const sessionIds = new Set(
    (
      await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.eventId, eventId))
    ).map((s) => s.id),
  );
  const byStatus: Record<string, number> = {};
  const syncs: Record<string, number> = {};
  for (const job of await db.select().from(jobs)) {
    const payload = job.payload as { eventId?: string; sessionId?: string };
    const tally =
      job.kind === "sync_calendar"
        ? syncs
        : payload.eventId === eventId ||
            (payload.sessionId !== undefined &&
              sessionIds.has(payload.sessionId))
          ? byStatus
          : null;
    if (tally) tally[job.status] = (tally[job.status] ?? 0) + 1;
  }

  const [changes] = await db.select({ n: count() }).from(resultChanges);

  return {
    sessionStatuses,
    cancelledSessions: extras.cancelledSessions,
    eventStatus: event.status,
    reviewItems: byKind,
    resultChanges: changes!.n,
    jobs: byStatus,
    calendarSyncs: syncs,
    wakeTicks: extras.wakeTicks,
  };
}
