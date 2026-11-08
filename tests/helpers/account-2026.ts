// A user with something in every part of the game, for the export and
// deletion tests (DM 6.7): a team in the recorded 2026 game with a saved
// lineup for round 1, and a private league they own with that team in it.
import type { Db } from "@/db/types";
import type { ClockDb } from "@/lib/resolve-clock";
import { createLeague, joinLeague } from "@/leagues/leagues";
import { openGame, saveLineup, type LineupPick } from "@/game/lineups";
import { createTeam } from "@/game/teams";
import { setSimulatedClock } from "@/replay/clock-loop";
import { round2026, seedGame2026 } from "./game-2026";
import { seedUser, type SeedUserInput } from "./users";

export const GAME_NOW = new Date("2026-02-01T09:00:00.000Z");
const HOUR_MS = 3_600_000;

// 280 + 250 + 95 + 85 + 80 + 90 + 70 = 950, inside the $100M budget.
const DRIVERS = ["norris", "piastri", "hulkenberg", "hadjar", "bearman"];
const CONSTRUCTORS = ["haas", "audi"];

/** The 2026 game, open, with round 1 and 2 to hand. */
export async function seedOpenGame(db: Db & ClockDb) {
  const game = await seedGame2026(db, GAME_NOW);
  await setSimulatedClock(db, GAME_NOW);
  const round1 = await round2026(db, 1);
  const round2 = await round2026(db, 2);
  await openGame(db, GAME_NOW, game.gameId);
  const picks = async (): Promise<LineupPick[]> => [
    ...(await Promise.all(
      DRIVERS.map(async (key) => ({
        assetId: await game.assetId(key),
        isBoost: key === DRIVERS[0],
      })),
    )),
    ...(await Promise.all(
      CONSTRUCTORS.map(async (key) => ({
        assetId: await game.assetId(key),
        isBoost: false,
      })),
    )),
  ];
  /** A team for `userId` with a lineup saved an hour before round 1 locks. */
  const teamWithLineup = async (userId: string, name: string) => {
    const teamId = await createTeam(db, GAME_NOW, {
      gameId: game.gameId,
      userId,
      name,
    });
    const savedAt = new Date(round1.lockAt.getTime() - HOUR_MS);
    await setSimulatedClock(db, savedAt);
    const { versionId } = await saveLineup(db, savedAt, {
      teamId,
      picks: await picks(),
      basedOnVersionId: null,
    });
    await setSimulatedClock(db, GAME_NOW);
    return { teamId, versionId };
  };
  return { ...game, round1, round2, teamWithLineup };
}

/**
 * A user (from `seedUser`) with a team, a lineup, and a private league they
 * own, which the team has joined.
 */
export async function seedPlayer(
  db: Db,
  game: Awaited<ReturnType<typeof seedOpenGame>>,
  input: SeedUserInput = {},
) {
  const userId = await seedUser(db, input);
  const { teamId, versionId } = await game.teamWithLineup(userId, "Box Box");
  const { leagueId, joinCode } = await createLeague(db, GAME_NOW, {
    gameId: game.gameId,
    ownerUserId: userId,
    kind: "private",
    name: "Pit Wall",
  });
  const { membershipId } = await joinLeague(db, GAME_NOW, {
    joinCode,
    teamId,
    userId,
  });
  return { userId, teamId, versionId, leagueId, joinCode, membershipId };
}
