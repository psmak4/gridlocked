// Test helper for tests outside src/providers: the 2026 replays, over the
// recorded fixtures. Like the other helpers it may import src/providers.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import {
  eventEntries,
  events,
  sessionResultState,
  sessions,
  teams,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { createLeague, joinLeague } from "@/leagues/leagues";
import { newId } from "@/lib/ids";
import { replayWeekend, type ReplayOptions } from "@/providers/replay/harness";
import { applyPenalty } from "@/providers/replay/penalty";
import { replaySeasonGame } from "@/providers/replay/season-game";
import {
  replaySeasonScoring,
  type SeasonScoringOptions,
} from "@/providers/replay/season-scoring";
import type { TickDb } from "@/jobs/tick";
import { insertNoTimeResult } from "@/replay/admin";
import { gameScriptSchema } from "@/replay/game-script";
import { addOverride } from "@/results/overrides";
import { SYSTEM_USER_ID } from "@/identity/system";
import { revalidateEvent } from "@/staff/revalidate";
import { readFixture } from "./fixtures";
import { seedGame2026 } from "./game-2026";
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
      sessionId: row.sessionId,
      driverId,
      constructorId: entry!.constructorId,
      carNumber: entry!.carNumber,
      position: first + i,
      reason: `Set no time in qualifying: Jolpica omits ${key}`,
    });
  }
}

export { replaySeasonGame };

const SEEDED_AT = new Date("2026-02-01T09:00:00.000Z");

/**
 * The 2026 season through `throughRound`, over the whole pipeline
 * (`replaySeasonScoring`), for the teams of scores-2026-script.json.
 */
export function replayScores2026(
  db: TickDb,
  options: Pick<
    SeasonScoringOptions,
    "throughRound" | "injections" | "actions"
  >,
) {
  return replaySeasonScoring(
    db,
    gameScriptSchema.parse(readFixture("scores-2026-script.json")),
    {
      ...options,
      fixturesDir: FIXTURES,
      seed: async (seedDb) => {
        const game = await seedGame2026(seedDb, SEEDED_AT);
        return {
          ...game,
          driverId: (key) => idFor(seedDb, "driver", key),
          constructorId: (key) => idFor(seedDb, "constructor", key),
        };
      },
    },
  );
}

/**
 * Private leagues every team of the game joins, each by name with its first
 * and last sequence (none: to the end of the season). Round 4 has no sequence
 * once it is cancelled, so round 5 is sequence 4.
 */
export async function createTestLeagues(
  db: Db,
  now: Date,
  gameId: string,
  ranges: Record<string, [start: number, end?: number]>,
): Promise<void> {
  const members = await db
    .select({ id: teams.id, userId: teams.userId })
    .from(teams)
    .where(eq(teams.gameId, gameId));
  for (const [name, [startSequence, endSequence]] of Object.entries(ranges)) {
    const { joinCode } = await createLeague(db, now, {
      gameId,
      ownerUserId: newId(),
      kind: "private",
      name,
      startSequence,
      endSequence,
    });
    for (const team of members) {
      await joinLeague(db, now, {
        joinCode,
        teamId: team.id,
        userId: team.userId,
      });
    }
  }
}

/**
 * A stewards' penalty after the event is final: `seconds` on `driver`'s race,
 * the classification redone by `applyPenalty` over the recorded body, and a
 * staff override for each row that moved, then the event checked again.
 *
 * A stand-in, in the test helpers on purpose. A final session takes no
 * override until M8 brings the audited reopen, which replaces this: it opens
 * the session by hand for the length of the change, and counts it in
 * `reopened_count` as a reopen would.
 */
export async function lateStewardsPenalty(
  db: Db,
  now: Date,
  input: { round: number; driver: string; seconds: number; reason: string },
) {
  const { round, driver, seconds, reason } = input;
  const [race] = await db
    .select({ id: sessions.id, eventId: sessions.eventId })
    .from(sessions)
    .innerJoin(events, eq(events.id, sessions.eventId))
    .where(and(eq(events.round, round), eq(sessions.kind, "race")));
  if (!race) throw new Error(`no race in round ${round}`);

  const file = join(
    FIXTURES,
    "jolpica",
    "2026",
    `r${String(round).padStart(2, "0")}-results.json`,
  );
  const body = JSON.parse(readFileSync(file, "utf8")) as RaceBody;
  const before = body.MRData.RaceTable.Races[0]!.Results;
  const after = applyPenalty(body, driver, seconds).MRData.RaceTable.Races[0]!
    .Results;
  const moved = after.filter((row) => {
    const was = before.find((b) => b.Driver.driverId === row.Driver.driverId);
    return was?.position !== row.position || was.points !== row.points;
  });
  if (moved.length === 0) throw new Error("the penalty moved nobody");

  const state = eq(sessionResultState.sessionId, race.id);
  const [held] = await db.select().from(sessionResultState).where(state);
  await db
    .update(sessionResultState)
    .set({ status: "provisional", reopenedCount: held!.reopenedCount + 1 })
    .where(state);
  for (const row of moved) {
    await addOverride(db, now, {
      sessionId: race.id,
      driverId: await idFor(db, "driver", row.Driver.driverId),
      kind: "patch",
      fields: {
        position: Number(row.position),
        provider_position_text: row.positionText,
        official_points: Number(row.points).toFixed(1),
        ...(row.Time?.millis === undefined
          ? {}
          : { time_ms: Number(row.Time.millis) }),
      },
      reason,
      createdBy: SYSTEM_USER_ID,
    });
  }
  await revalidateEvent(db, now, race.eventId);
  await db.update(sessionResultState).set({ status: "final" }).where(state);
}

interface RaceBody {
  MRData: {
    RaceTable: {
      Races: Array<{
        Results: Array<{
          position: string;
          positionText: string;
          points: string;
          Driver: { driverId: string };
          Time?: { millis?: string };
        }>;
      }>;
    };
  };
}
