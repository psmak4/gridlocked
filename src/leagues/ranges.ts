import { and, eq, isNotNull, ne, or } from "drizzle-orm";
import { leagues } from "@/db/schema";
import type { Db } from "@/db/types";

// A mini-league's range is event sequences, and planning renumbers the events
// still open for it (DM 3.3). So when a sequence moves, the range moves with
// it: a league stays on the real events its owner picked (DM 4.5).

export type LeagueRange = { start: number; end: number | null };

/** An event in lock order, with its sequence after planning (null if cancelled). */
export type PlannedEvent = { eventId: string; sequence: number | null };

/** The sequence nearest `from` in `order`, walking by `step`; null if none. */
function nearest(
  order: readonly PlannedEvent[],
  from: number,
  step: 1 | -1,
): number | null {
  for (let i = from; i >= 0 && i < order.length; i += step) {
    const sequence = order[i]!.sequence;
    if (sequence !== null) return sequence;
  }
  return null;
}

/**
 * The range covering the same real events after planning, given which event
 * held each sequence before (`before`) and every event now, in lock order
 * (`order`). A start on a cancelled event moves forward to the next race and
 * an end moves back to the race before it, so either end stays on a race the
 * range covers. A range left with no races moves to the next one. With nothing
 * after it, the range stays where it is and covers nothing: it never moves back
 * onto a race already scored, which would build no table for it, and a race
 * reinstated there is covered again. A sequence no event held is past the season
 * and stays as it is.
 */
export function rangeAfterRenumber(
  range: LeagueRange,
  before: ReadonlyMap<number, string>,
  order: readonly PlannedEvent[],
): LeagueRange {
  const indexOf = (sequence: number) => {
    const eventId = before.get(sequence);
    const index = order.findIndex((e) => e.eventId === eventId);
    return index === -1 ? null : index;
  };

  const startIndex = indexOf(range.start);
  const start =
    startIndex === null
      ? range.start
      : (nearest(order, startIndex, 1) ?? range.start);
  if (range.end === null) return { start, end: null };

  const endIndex = indexOf(range.end);
  const end =
    endIndex === null ? range.end : (nearest(order, endIndex, -1) ?? range.end);
  return { start, end: Math.max(start, end) };
}

/**
 * Moves the game's mini-league ranges to follow a renumbering, inside the
 * planning transaction. Writes only what differs, and a whole-season league
 * has nothing to move.
 */
export async function moveLeagueRanges(
  tx: Db,
  now: Date,
  gameId: string,
  before: ReadonlyMap<number, string>,
  order: readonly PlannedEvent[],
): Promise<void> {
  const rows = await tx
    .select({
      id: leagues.id,
      start: leagues.startSequence,
      end: leagues.endSequence,
    })
    .from(leagues)
    .where(
      and(
        eq(leagues.gameId, gameId),
        or(ne(leagues.startSequence, 1), isNotNull(leagues.endSequence)),
      ),
    );
  for (const row of rows) {
    const moved = rangeAfterRenumber(row, before, order);
    if (moved.start === row.start && moved.end === row.end) continue;
    await tx
      .update(leagues)
      .set({
        startSequence: moved.start,
        endSequence: moved.end,
        updatedAt: now,
      })
      .where(eq(leagues.id, row.id));
  }
}
