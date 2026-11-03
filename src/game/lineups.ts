import { and, asc, desc, eq, inArray, lte, lt, sql } from "drizzle-orm";
import {
  events,
  gameEvents,
  games,
  lineupPicks,
  lineupVersions,
  poolAssets,
  teams,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { newId } from "@/lib/ids";
import { GameError, type GameErrorCode } from "./errors";
import { priceList } from "./prices";

// Lineups (DM 3.7): every save is a new version, and the database decides
// whether a save came in time. Reads reference data, never writes it (DM 0.5).

export interface LineupPick {
  assetId: string;
  isBoost: boolean;
}

/** The SQLSTATE each lineup trigger raises (game_rules_4), and what it means. */
const REFUSALS: Record<string, GameErrorCode> = {
  GL001: "window_closed",
  GL002: "composition",
  GL003: "asset_unavailable",
  GL004: "over_budget",
};

/**
 * Turns a database refusal into a `GameError`. Drivers wrap the Postgres error
 * as the `cause` of their own, so the SQLSTATE is looked for down the chain.
 * Anything else is returned as it came.
 */
function refusal(error: unknown): unknown {
  for (
    let e: unknown = error;
    e instanceof Error || (typeof e === "object" && e !== null);
    e = (e as { cause?: unknown }).cause
  ) {
    const code = (e as { code?: unknown }).code;
    const mapped = typeof code === "string" ? REFUSALS[code] : undefined;
    if (mapped) {
      const message = e instanceof Error ? e.message : mapped;
      return new GameError(mapped, message.replace(/^lineup: /, ""));
    }
  }
  return error;
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
 * Saves a complete lineup for the game's open event as a new `regular`
 * version, never changing an earlier one. `basedOnVersionId` is the version
 * the user was editing, or null for a blank start; `staleBase` is true when it
 * isn't the team's latest version, because another device saved since. The
 * save still goes through.
 *
 * The checks that matter are the database's, made at the end of this call's
 * transaction (even when it is nested in a caller's): the window against the
 * clock at that moment, the squad and Boost against the ruleset, and the
 * assets. Each refusal is a `GameError` (`window_closed`,
 * `composition`, `asset_unavailable`) and writes nothing. The check here
 * against `now` only gives the friendlier early answer, and a repeated asset
 * is `composition` before it reaches the key.
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

      const versionId = newId();
      // saved_at is left to the database.
      await tx.insert(lineupVersions).values({
        id: versionId,
        teamId,
        forEventId: event.eventId,
        kind: "regular",
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

/**
 * The lineup that counts for an event (DM 3.7): the team's latest `regular` or
 * `limitless` version for it saved before its `lock_at`, latest by
 * `(saved_at, id)`. Null when it has none. (The base carried forward from
 * earlier events is added with budgets.)
 */
export async function lockedLineup(
  db: Db,
  input: { teamId: string; eventId: string },
): Promise<{ versionId: string; picks: LineupPick[] } | null> {
  const [event] = await db
    .select({ lockAt: events.lockAt })
    .from(events)
    .where(eq(events.id, input.eventId));
  if (!event) throw new Error(`lockedLineup: no event ${input.eventId}`);

  const [version] = await db
    .select({ id: lineupVersions.id })
    .from(lineupVersions)
    .where(
      and(
        eq(lineupVersions.teamId, input.teamId),
        eq(lineupVersions.forEventId, input.eventId),
        inArray(lineupVersions.kind, ["regular", "limitless"]),
        lt(lineupVersions.savedAt, event.lockAt),
      ),
    )
    .orderBy(desc(lineupVersions.savedAt), desc(lineupVersions.id))
    .limit(1);
  if (!version) return null;

  const picks = await db
    .select({ assetId: lineupPicks.assetId, isBoost: lineupPicks.isBoost })
    .from(lineupPicks)
    .where(eq(lineupPicks.lineupVersionId, version.id))
    .orderBy(asc(lineupPicks.assetId));
  return { versionId: version.id, picks };
}
