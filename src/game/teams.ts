import { and, desc, eq } from "drizzle-orm";
import { games, rulesetVersions, TEAM_NAME_MAX, teams } from "@/db/schema";
import type { Db } from "@/db/types";
import { newId } from "@/lib/ids";
import { GameError } from "./errors";
import { rulesetParamsSchema } from "./ruleset";

// Teams (DM 3.6): up to `teamsPerUser` per user and game. Reads reference data,
// never writes it (DM 0.5).

/** Trims a name and checks its length, counted in characters. */
function cleanName(name: string): string {
  const trimmed = name.trim();
  const length = Array.from(trimmed).length;
  if (length < 1 || length > TEAM_NAME_MAX) {
    throw new GameError(
      "bad_name",
      `a team name is 1 to ${TEAM_NAME_MAX} characters`,
    );
  }
  return trimmed;
}

/**
 * Creates an `active` team for a user and returns its ID. It takes `slot`, or
 * the lowest free one. A retired team still holds its slot. Refused unless the
 * game is `open` or `running` (`game_not_open`), when every slot is taken or
 * `slot` is taken or out of range (`no_free_slot`), and when the trimmed name
 * is not 1 to 30 characters (`bad_name`). The database also enforces the slot
 * limit, and the key makes two creates for one slot race for it: the loser
 * fails with a unique violation.
 */
export async function createTeam(
  db: Db,
  now: Date,
  input: { gameId: string; userId: string; name: string; slot?: number },
): Promise<string> {
  const name = cleanName(input.name);
  return db.transaction(async (tx) => {
    const [game] = await tx
      .select()
      .from(games)
      .where(eq(games.id, input.gameId));
    if (!game) throw new Error(`createTeam: no game ${input.gameId}`);
    if (game.status !== "open" && game.status !== "running") {
      throw new GameError("game_not_open", "teams can't be created yet");
    }

    const [version] = await tx
      .select({ params: rulesetVersions.params })
      .from(rulesetVersions)
      .where(eq(rulesetVersions.gameId, input.gameId))
      .orderBy(desc(rulesetVersions.version))
      .limit(1);
    if (!version) {
      throw new Error(
        `createTeam: game ${input.gameId} has no ruleset version`,
      );
    }
    const { teamsPerUser } = rulesetParamsSchema.parse(version.params);

    const taken = new Set(
      (
        await tx
          .select({ slot: teams.slot })
          .from(teams)
          .where(
            and(eq(teams.gameId, input.gameId), eq(teams.userId, input.userId)),
          )
      ).map((row) => row.slot),
    );
    let slot = input.slot;
    if (slot === undefined) {
      for (let s = 1; s <= teamsPerUser; s++) {
        if (!taken.has(s)) {
          slot = s;
          break;
        }
      }
    }
    if (
      slot === undefined ||
      !Number.isInteger(slot) ||
      slot < 1 ||
      slot > teamsPerUser ||
      taken.has(slot)
    ) {
      throw new GameError("no_free_slot", "that team slot is not available");
    }

    const id = newId();
    await tx.insert(teams).values({
      id,
      gameId: input.gameId,
      userId: input.userId,
      slot,
      name,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    return id;
  });
}

/** Renames a team; the name is trimmed and checked like a new one. */
export async function renameTeam(
  db: Db,
  now: Date,
  input: { teamId: string; name: string },
): Promise<void> {
  const name = cleanName(input.name);
  const renamed = await db
    .update(teams)
    .set({ name, updatedAt: now })
    .where(eq(teams.id, input.teamId))
    .returning({ id: teams.id });
  if (renamed.length === 0) {
    throw new Error(`renameTeam: no team ${input.teamId}`);
  }
}

/**
 * Removes a team a user no longer wants. A team that has not locked yet (no
 * `first_event_id`) is deleted outright. Any other is retired, so league
 * history stays correct; a retired team keeps its slot, and retiring one again
 * changes nothing.
 */
export async function removeTeam(
  db: Db,
  now: Date,
  teamId: string,
): Promise<"deleted" | "retired"> {
  return db.transaction(async (tx) => {
    const [team] = await tx
      .select()
      .from(teams)
      .where(eq(teams.id, teamId))
      .for("update");
    if (!team) throw new Error(`removeTeam: no team ${teamId}`);
    if (team.firstEventId === null) {
      await tx.delete(teams).where(eq(teams.id, teamId));
      return "deleted";
    }
    if (team.status !== "retired") {
      await tx
        .update(teams)
        .set({ status: "retired", updatedAt: now })
        .where(eq(teams.id, teamId));
    }
    return "retired";
  });
}
