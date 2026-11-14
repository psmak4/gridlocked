/**
 * Teams on the fantasy screens (M6 Task 6): the viewer's teams in the
 * current game, and creating, renaming and removing one. The rules are the
 * game layer's (`src/game/teams.ts`); this adds who may, and the auto
 * leagues a new team joins.
 */
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { profiles, teams } from "@/db/schema";
import type { Db } from "@/db/types";
import { GameError, isUniqueViolation } from "@/game/errors";
import { createTeam, removeTeam, renameTeam, teamsPerUser } from "@/game/teams";
import { syncProfileAutoLeagues } from "@/identity/profile";
import {
  requireComplete,
  requireWritable,
  type Viewer,
} from "@/identity/viewer";
import { refusalOf, type Refusal } from "@/server/play-actions";
import { currentGame, type CurrentGame } from "./current-game";

export type TeamSummary = {
  id: string;
  slot: number;
  name: string;
  status: "active" | "retired";
  /** It has locked into an event, so removing it retires it. */
  locked: boolean;
};

/** A user's teams in a game, by slot. */
export async function myTeams(
  db: Db,
  input: { gameId: string; userId: string },
): Promise<TeamSummary[]> {
  const rows = await db
    .select({
      id: teams.id,
      slot: teams.slot,
      name: teams.name,
      status: teams.status,
      firstEventId: teams.firstEventId,
    })
    .from(teams)
    .where(and(eq(teams.gameId, input.gameId), eq(teams.userId, input.userId)))
    .orderBy(asc(teams.slot));
  return rows.map(({ firstEventId, ...team }) => ({
    ...team,
    locked: firstEventId !== null,
  }));
}

export type TeamsPage = {
  game: CurrentGame | null;
  teams: TeamSummary[];
  /** A slot is free for another team. */
  canCreate: boolean;
};

/** `/team`: the current game and the viewer's teams in it. */
export async function teamsPage(
  db: Db,
  viewer: Viewer | null,
): Promise<TeamsPage> {
  const v = requireComplete(viewer);
  const game = await currentGame(db);
  if (!game) return { game: null, teams: [], canCreate: false };
  const mine = await myTeams(db, { gameId: game.id, userId: v.userId });
  return {
    game,
    teams: mine,
    canCreate: mine.length < (await teamsPerUser(db, game.id)),
  };
}

// The name's length is the game layer's check (`bad_name`); this only keeps
// an absurd input out.
const name = z.string().max(200);

export const createTeamInput = z.object({ name });
export const renameTeamInput = z.object({ teamId: z.uuid(), name });
export const removeTeamInput = z.object({ teamId: z.uuid() });

/**
 * A new team in the current game, in the lowest free slot, and straight into
 * the auto leagues its owner's profile calls for, in the same transaction
 * (M6 plan, finding 2).
 */
export function createTeamAction(
  db: Db,
  now: Date,
  viewer: Viewer | null,
  data: z.infer<typeof createTeamInput>,
): Promise<{ ok: true; slot: number } | Refusal> {
  const v = requireWritable(viewer);
  return refusalOf(async () => {
    const game = await currentGame(db);
    if (!game) throw new GameError("game_not_open", "no game is open");
    try {
      return await db.transaction(async (tx) => {
        const t = tx as unknown as Db;
        const id = await createTeam(t, now, {
          gameId: game.id,
          userId: v.userId,
          name: data.name,
        });
        const [profile] = await t
          .select()
          .from(profiles)
          .where(eq(profiles.userId, v.userId));
        if (!profile) throw new Error(`createTeamAction: no profile`);
        await syncProfileAutoLeagues(t, now, { gameId: game.id, profile });
        const [team] = await t
          .select({ slot: teams.slot })
          .from(teams)
          .where(eq(teams.id, id));
        return { ok: true as const, slot: team!.slot };
      });
    } catch (error) {
      // Two creates raced for the last slot, and this one lost.
      if (isUniqueViolation(error)) {
        throw new GameError("no_free_slot", "that team slot was just taken");
      }
      throw error;
    }
  });
}

/** The viewer's own team, or `team_not_owned`. */
async function ownTeam(db: Db, userId: string, teamId: string) {
  const [team] = await db
    .select({ status: teams.status })
    .from(teams)
    .where(and(eq(teams.id, teamId), eq(teams.userId, userId)));
  if (!team) throw new GameError("team_not_owned", "not your team");
  return team;
}

/** Renames one of the viewer's active teams. */
export function renameTeamAction(
  db: Db,
  now: Date,
  viewer: Viewer | null,
  data: z.infer<typeof renameTeamInput>,
): Promise<{ ok: true } | Refusal> {
  const v = requireWritable(viewer);
  return refusalOf(async () => {
    const team = await ownTeam(db, v.userId, data.teamId);
    if (team.status === "retired") {
      throw new GameError("team_retired", "a retired team keeps its name");
    }
    await renameTeam(db, now, { teamId: data.teamId, name: data.name });
    return { ok: true as const };
  });
}

/**
 * Removes one of the viewer's teams: deleted before its first lock, retired
 * after it (DM 3.6), so league history holds.
 */
export function removeTeamAction(
  db: Db,
  now: Date,
  viewer: Viewer | null,
  data: z.infer<typeof removeTeamInput>,
): Promise<{ ok: true; removed: "deleted" | "retired" } | Refusal> {
  const v = requireWritable(viewer);
  return refusalOf(async () => {
    await ownTeam(db, v.userId, data.teamId);
    const removed = await removeTeam(db, now, data.teamId);
    return { ok: true as const, removed };
  });
}
