import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import {
  events,
  gameEvents,
  games,
  lineupPicks,
  type LINEUP_KINDS,
  lineupVersions,
  poolAssets,
  teams,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { newId } from "@/lib/ids";
import { playedChips } from "./chips";
import { GameError, refusal } from "./errors";
import { priceList } from "./prices";

// Lineups (DM 3.7): every save is a new version, and the database decides
// whether a save came in time. Reads reference data, never writes it (DM 0.5).

export interface LineupPick {
  assetId: string;
  isBoost: boolean;
}

/**
 * Opens a game for play: the game goes from `setup` to `open` and its
 * sequence-1 event to `open`, so teams can be created and lineups saved. The
 * event must have a price for every active asset added from it or earlier. An
 * error, writing nothing, if the game isn't in `setup` or a price is missing.
 */
export async function openGame(
  db: Db,
  now: Date,
  gameId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [game] = await tx
      .select()
      .from(games)
      .where(eq(games.id, gameId))
      .for("update");
    if (!game) throw new Error(`openGame: no game ${gameId}`);
    if (game.status !== "setup") {
      throw new Error(
        `openGame: game ${gameId} is ${game.status}, not in setup`,
      );
    }
    const [first] = await tx
      .select()
      .from(gameEvents)
      .where(and(eq(gameEvents.gameId, gameId), eq(gameEvents.sequence, 1)));
    if (!first) {
      throw new Error(`openGame: game ${gameId} has no first event`);
    }

    const prices = await priceList(tx, { gameId, eventId: first.eventId });
    const needed = await tx
      .select({ id: poolAssets.id })
      .from(poolAssets)
      .innerJoin(
        gameEvents,
        and(
          eq(gameEvents.gameId, poolAssets.gameId),
          eq(gameEvents.eventId, poolAssets.addedFromEventId),
        ),
      )
      .where(
        and(
          eq(poolAssets.gameId, gameId),
          eq(poolAssets.status, "active"),
          lte(gameEvents.sequence, 1),
        ),
      );
    const missing = needed.filter((asset) => !prices.has(asset.id));
    if (missing.length > 0) {
      throw new Error(
        `openGame: ${missing.length} active assets have no price for the first event`,
      );
    }

    await tx
      .update(games)
      .set({ status: "open", updatedAt: now })
      .where(eq(games.id, gameId));
    await tx
      .update(gameEvents)
      .set({ status: "open", updatedAt: now })
      .where(
        and(
          eq(gameEvents.gameId, gameId),
          eq(gameEvents.eventId, first.eventId),
        ),
      );
  });
}

/**
 * Saves a complete lineup for the game's open event as a new version, never
 * changing an earlier one: `limitless` when the team has played Blank Cheque
 * (Limitless) for the event, otherwise `regular`. `basedOnVersionId` is the version
 * the user was editing, or null for a blank start; `staleBase` is true when it
 * isn't the team's latest version, because another device saved since. The
 * save still goes through.
 *
 * The checks that matter are the database's, made at the end of this call's
 * transaction (even when it is nested in a caller's): the window against the
 * clock at that moment, the squad and Boost against the ruleset, the assets
 * (a withdrawn one only if the team owns it), and the cost against the team's
 * purchasing power at this event's prices (DM 3.8). Each refusal is a
 * `GameError` (`window_closed`, `composition`, `asset_unavailable`,
 * `over_budget`) and writes nothing. With the x3 Boost played, a lineup that
 * drops its target or puts the 2x Boost on it is `composition` too. The check
 * here against `now` only gives the friendlier early answer, and a repeated
 * asset is `composition` before it reaches the key.
 */
export async function saveLineup(
  db: Db,
  now: Date,
  input: {
    teamId: string;
    picks: LineupPick[];
    basedOnVersionId: string | null;
  },
): Promise<{ versionId: string; staleBase: boolean }> {
  const { teamId, picks, basedOnVersionId } = input;
  if (new Set(picks.map((p) => p.assetId)).size !== picks.length) {
    throw new GameError("composition", "an asset can only be picked once");
  }
  try {
    return await db.transaction(async (tx) => {
      // Saves for one team take turns, so "latest" means the same to both.
      const [team] = await tx
        .select()
        .from(teams)
        .where(eq(teams.id, teamId))
        .for("update");
      if (!team) throw new Error(`saveLineup: no team ${teamId}`);

      const open = await tx
        .select({ eventId: gameEvents.eventId, lockAt: events.lockAt })
        .from(gameEvents)
        .innerJoin(events, eq(events.id, gameEvents.eventId))
        .where(
          and(
            eq(gameEvents.gameId, team.gameId),
            eq(gameEvents.status, "open"),
          ),
        );
      if (open.length > 1) {
        throw new Error(
          `saveLineup: game ${team.gameId} has several open events`,
        );
      }
      const [event] = open;
      if (!event || now.getTime() >= event.lockAt.getTime()) {
        throw new GameError("window_closed", "lineups are closed for now");
      }

      const [latest] = await tx
        .select({ id: lineupVersions.id })
        .from(lineupVersions)
        .where(eq(lineupVersions.teamId, teamId))
        .orderBy(desc(lineupVersions.savedAt), desc(lineupVersions.id))
        .limit(1);
      if (basedOnVersionId !== null) {
        const [based] = await tx
          .select({ id: lineupVersions.id })
          .from(lineupVersions)
          .where(
            and(
              eq(lineupVersions.id, basedOnVersionId),
              eq(lineupVersions.teamId, teamId),
            ),
          );
        if (!based) {
          throw new Error(
            `saveLineup: team ${teamId} has no version ${basedOnVersionId}`,
          );
        }
      }

      const chip = (
        await playedChips(tx, { eventId: event.eventId, teamIds: [teamId] })
      ).get(teamId);

      const versionId = newId();
      // saved_at is left to the database.
      await tx.insert(lineupVersions).values({
        id: versionId,
        teamId,
        forEventId: event.eventId,
        kind: chip?.effect === "limitless" ? "limitless" : "regular",
        basedOnVersionId,
      });
      if (picks.length > 0) {
        await tx.insert(lineupPicks).values(
          picks.map((p) => ({
            lineupVersionId: versionId,
            assetId: p.assetId,
            isBoost: p.isBoost,
          })),
        );
      }
      // The checks are deferred to commit. Run them here, inside the try, so a
      // refusal is mapped even when this transaction is nested in a caller's
      // (a savepoint, which commits only with the outer one). Then back to
      // deferred for whatever else the caller does.
      await tx.execute(
        sql`set constraints "lineup_versions_check", "lineup_picks_check" immediate`,
      );
      await tx.execute(
        sql`set constraints "lineup_versions_check", "lineup_picks_check" deferred`,
      );
      return {
        versionId,
        staleBase: (latest?.id ?? null) !== basedOnVersionId,
      };
    });
  } catch (error) {
    // The checks raise at the end of the transaction, inside the try.
    throw refusal(error);
  }
}

/** A team's lineup for an event, as it counts. */
export interface LockedLineup {
  versionId: string;
  kind: (typeof LINEUP_KINDS)[number];
  picks: LineupPick[];
}

/**
 * The lineup that counts for an event (DM 3.7): the team's latest `regular` or
 * `limitless` version for it saved before its `lock_at`, latest by
 * `(saved_at, id)`. With none, it is the latest `regular` version saved for an
 * event cancelled while its window was open, since the event before this one
 * locked (DM 3.9: a cancellation doesn't undo a team's changes); with none of
 * those either, the base carried forward from the team's earlier events
 * (`team_base_state`, DM 3.8). Null when it has none of these: the team never
 * saved a lineup that counted.
 */
export async function lockedLineup(
  db: Db,
  input: { teamId: string; eventId: string },
): Promise<LockedLineup | null> {
  const found = await lockedLineups(db, {
    eventId: input.eventId,
    teamIds: [input.teamId],
  });
  return found.get(input.teamId) ?? null;
}

/**
 * `lockedLineup` for many teams at once, by team id; a team with no lineup
 * that counts is left out. The lock job reads a batch of teams with it.
 */
export async function lockedLineups(
  db: Db,
  input: { eventId: string; teamIds: string[] },
): Promise<Map<string, LockedLineup>> {
  const { eventId, teamIds } = input;
  const found = new Map<string, LockedLineup>();
  if (teamIds.length === 0) return found;
  const [event] = await db
    .select({ id: events.id })
    .from(events)
    .where(eq(events.id, eventId));
  if (!event) throw new Error(`lockedLineup: no event ${eventId}`);

  // The database's own choice (team_locked_lineup), as the chip check makes it.
  const counting = await db
    .select({
      teamId: teams.id,
      versionId: sql<
        string | null
      >`team_locked_lineup(${teams.id}, ${eventId}::uuid)`,
    })
    .from(teams)
    .where(inArray(teams.id, teamIds));
  const ids = counting
    .map((row) => row.versionId)
    .filter((id): id is string => id !== null);
  if (ids.length === 0) return found;
  const kinds = new Map(
    (
      await db
        .select({ id: lineupVersions.id, kind: lineupVersions.kind })
        .from(lineupVersions)
        .where(inArray(lineupVersions.id, ids))
    ).map((v) => [v.id, v.kind]),
  );
  const picks = await db
    .select({
      versionId: lineupPicks.lineupVersionId,
      assetId: lineupPicks.assetId,
      isBoost: lineupPicks.isBoost,
    })
    .from(lineupPicks)
    .where(inArray(lineupPicks.lineupVersionId, ids))
    .orderBy(asc(lineupPicks.assetId));
  const byVersion = new Map<string, LineupPick[]>();
  for (const { versionId, assetId, isBoost } of picks) {
    const list = byVersion.get(versionId) ?? [];
    list.push({ assetId, isBoost });
    byVersion.set(versionId, list);
  }
  for (const { teamId, versionId } of counting) {
    if (versionId === null) continue;
    found.set(teamId, {
      versionId,
      kind: kinds.get(versionId)!,
      picks: byVersion.get(versionId) ?? [],
    });
  }
  return found;
}
