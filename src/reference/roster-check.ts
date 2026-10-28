import { and, asc, eq, inArray } from "drizzle-orm";
import {
  eventEntries,
  events,
  sessionParticipants,
  sessions,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { openReviewItem } from "./review";

/** A roster finding. The same shape the results validator reports. */
export interface RosterProblem {
  kind: "team_change" | "missing_driver";
  /** Always a warning: practice is a signal, the results decide. */
  severity: "warning";
  details: Record<string, unknown>;
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Compares who ran in FP2 and FP3 with the event's entries (HLD §8.2), and
 * opens a warning for each surprise:
 * - `team_change`: a participant whose constructor differs from their entry,
 *   or who has no entry at all (a possible substitute);
 * - `missing_driver`: an entered driver absent from every one of FP2 and FP3
 *   that has participants.
 * FP1 opens nothing: young-driver runs would be false positives. A session
 * with no participants yet is not judged. Reads only our tables. Returns every
 * finding, new or already open; a second call opens nothing new.
 */
export async function rosterCheck(
  db: Db,
  now: Date,
  eventId: string,
): Promise<RosterProblem[]> {
  const [event] = await db
    .select({ seasonId: events.seasonId })
    .from(events)
    .where(eq(events.id, eventId));
  if (!event) throw new Error(`rosterCheck: no event ${eventId}`);

  const practice = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(
        eq(sessions.eventId, eventId),
        inArray(sessions.kind, ["fp2", "fp3"]),
      ),
    )
    .orderBy(asc(sessions.kind));
  const entries = await db
    .select()
    .from(eventEntries)
    .where(eq(eventEntries.eventId, eventId));
  const entryByDriver = new Map(entries.map((e) => [e.driverId, e]));

  const judged: Array<{
    sessionId: string;
    participants: Array<{ driverId: string; constructorId: string }>;
  }> = [];
  for (const { id } of practice) {
    const participants = await db
      .select({
        driverId: sessionParticipants.driverId,
        constructorId: sessionParticipants.constructorId,
      })
      .from(sessionParticipants)
      .where(eq(sessionParticipants.sessionId, id));
    if (participants.length > 0) judged.push({ sessionId: id, participants });
  }
  if (judged.length === 0) return [];

  const problems: RosterProblem[] = [];
  const open = async (
    problem: RosterProblem,
    sessionId: string | null,
    dedupeKey: string,
  ) => {
    problems.push(problem);
    await openReviewItem(db, now, {
      kind: problem.kind,
      severity: "warning",
      seasonId: event.seasonId,
      eventId,
      sessionId,
      driverId: problem.details.driverId as string,
      details: problem.details,
      dedupeKey,
    });
  };

  // One finding per driver, however many sessions show it.
  const flagged = new Set<string>();
  for (const { sessionId, participants } of judged) {
    for (const p of [...participants].sort((a, b) =>
      byText(a.driverId, b.driverId),
    )) {
      if (flagged.has(p.driverId)) continue;
      const entry = entryByDriver.get(p.driverId);
      if (entry && entry.constructorId === p.constructorId) continue;
      flagged.add(p.driverId);
      await open(
        {
          kind: "team_change",
          severity: "warning",
          details: {
            driverId: p.driverId,
            constructorId: p.constructorId,
            expectedConstructorId: entry?.constructorId ?? null,
            sessionId,
          },
        },
        sessionId,
        `roster:${eventId}:team_change:${p.driverId}`,
      );
    }
  }

  const ran = new Set(
    judged.flatMap((j) => j.participants.map((p) => p.driverId)),
  );
  for (const entry of [...entries].sort((a, b) =>
    byText(a.driverId, b.driverId),
  )) {
    if (ran.has(entry.driverId)) continue;
    await open(
      {
        kind: "missing_driver",
        severity: "warning",
        details: {
          driverId: entry.driverId,
          constructorId: entry.constructorId,
          sessionIds: judged.map((j) => j.sessionId),
        },
      },
      null,
      `roster:${eventId}:missing:${entry.driverId}`,
    );
  }
  return problems;
}
