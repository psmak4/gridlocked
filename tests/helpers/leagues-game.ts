// Test helper for leagues: the recorded 2026 game, open for teams, and a second
// game in another season to tell the games apart. Like the other helpers it may
// import src/providers.
import { and, asc, eq, isNotNull } from "drizzle-orm";
import {
  circuits,
  constructors,
  drivers,
  events,
  gameEvents,
  games,
  seasons,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { createGame } from "@/game/games";
import { RULESET_2026 } from "@/game/ruleset";
import { newId } from "@/lib/ids";
import { SCORING_RULES_2026 } from "@/scoring/rules";
import { importReferenceFixtures2026 } from "./pipeline-2026";

/**
 * Imports the 2026 reference data and creates two games, both `open`: the 2026
 * one (all its events, by `eventIds[sequence - 1]`) and a one-event game for a
 * made-up 2025 season. `constructorIds` and `driverIds` are the reference rows.
 */
export async function seedLeagueGames(db: Db, now: Date) {
  const { seasonId } = await importReferenceFixtures2026(db, now);
  const { gameId } = await createGame(db, now, {
    seasonId,
    slug: "2026-fantasy",
    name: "2026 Fantasy",
    params: RULESET_2026,
    rules: SCORING_RULES_2026,
    notes: "The 2026 rules.",
  });

  const otherSeasonId = newId();
  await db.insert(seasons).values({
    id: otherSeasonId,
    year: 2025,
    status: "completed",
    createdAt: now,
    updatedAt: now,
  });
  const [circuit] = await db.select().from(circuits).limit(1);
  await db.insert(events).values({
    id: newId(),
    seasonId: otherSeasonId,
    round: 1,
    slug: "2025-round-1",
    name: "2025 Round 1",
    circuitId: circuit!.id,
    format: "standard",
    status: "scheduled",
    lockAt: new Date("2025-03-15T04:00:00.000Z"),
    lockAtSource: "default",
    createdAt: now,
    updatedAt: now,
  });
  const { gameId: otherGameId } = await createGame(db, now, {
    seasonId: otherSeasonId,
    slug: "2025-fantasy",
    name: "2025 Fantasy",
    params: RULESET_2026,
    rules: SCORING_RULES_2026,
    notes: "Another game.",
  });
  await db.update(games).set({ status: "open" });

  const eventIds = (
    await db
      .select({ eventId: gameEvents.eventId })
      .from(gameEvents)
      .where(and(eq(gameEvents.gameId, gameId), isNotNull(gameEvents.sequence)))
      .orderBy(asc(gameEvents.sequence))
  ).map((row) => row.eventId);
  return {
    gameId,
    otherGameId,
    eventIds,
    constructorIds: (
      await db
        .select({ id: constructors.id })
        .from(constructors)
        .orderBy(asc(constructors.slug))
    ).map((r) => r.id),
    driverIds: (
      await db
        .select({ id: drivers.id })
        .from(drivers)
        .orderBy(asc(drivers.slug))
    ).map((r) => r.id),
  };
}
