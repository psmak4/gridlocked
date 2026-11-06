// Test helper for tests outside src/providers: the 2026 replays, over the
// recorded fixtures. Like the other helpers it may import src/providers.
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { eventEntries, events, sessions } from "@/db/schema";
import type { Db } from "@/db/types";
import { replayWeekend, type ReplayOptions } from "@/providers/replay/harness";
import { replaySeasonGame } from "@/providers/replay/season-game";
import type { TickDb } from "@/jobs/tick";
import { insertNoTimeResult } from "@/replay/admin";
import { idFor } from "./ingest-2026";

const FIXTURES = fileURLToPath(new URL("../fixtures", import.meta.url));

/** One recorded weekend of 2026 (`replayWeekend`). */
export const replayRound = (
  db: TickDb,
  round: number,
  options: Omit<ReplayOptions, "season" | "round" | "fixturesDir"> = {},
) =>
  replayWeekend(db, { season: 2026, round, fixturesDir: FIXTURES, ...options });

/**
 * The drivers Jolpica left out of a round's qualifying, in the order staff
 * enter them: nobody with no Q1 time has a row.
 */
export const NO_TIME_DRIVERS: Record<number, string[]> = {
  1: ["max_verstappen", "sainz", "stroll"],
  14: ["bearman", "stroll"],
};

/** Staff enter the round's left-out drivers, after the recorded rows. */
export async function enterNoTimeDrivers(db: Db, now: Date, round: number) {
  const [row] = await db
    .select({ eventId: events.id, sessionId: sessions.id })
    .from(sessions)
    .innerJoin(events, eq(events.id, sessions.eventId))
    .where(and(eq(events.round, round), eq(sessions.kind, "qualifying")));
  const keys = NO_TIME_DRIVERS[round];
  if (!row || !keys) throw new Error(`no left-out drivers in round ${round}`);
  const first = 23 - keys.length;
  for (const [i, key] of keys.entries()) {
    const driverId = await idFor(db, "driver", key);
    const [entry] = await db
      .select()
      .from(eventEntries)
      .where(
        and(
          eq(eventEntries.eventId, row.eventId),
          eq(eventEntries.driverId, driverId),
        ),
      );
    await insertNoTimeResult(db, now, {
      ...row,
      driverId,
      constructorId: entry!.constructorId,
      carNumber: entry!.carNumber,
      position: first + i,
      reason: `Set no time in qualifying: Jolpica omits ${key}`,
    });
  }
}

export { replaySeasonGame };
