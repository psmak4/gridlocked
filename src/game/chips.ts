import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  chipPlays,
  events,
  gameEvents,
  lineupPicks,
  lineupVersions,
  rulesetVersions,
  sessions,
  teamEventStates,
  teams,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { newId } from "@/lib/ids";
import { GameError, refusal } from "./errors";
import type { LineupPick } from "./lineups";
import { CHIP_EFFECTS, rulesetParamsSchema } from "./ruleset";

// Chips (DM 3.9): a team plays each once a season, at most one per race, and
// never takes one back. The database decides whether a play counts (the code,
// the window, the unlock rule and the x3 Boost target, at commit); the checks
// here only give the friendlier early answer. The effects on points are M4's;
// M3 records the plays, and the lock and the lineup rules follow them. Reads
// reference data and results, never writes them (DM 0.5).

const effectSchema = z.enum(CHIP_EFFECTS).nullable();

/** A chip a team has played for an event, with what it does. */
export interface PlayedChip {
  id: string;
  code: string;
  /** From the event's ruleset; null if it no longer has the code. */
  effect: z.infer<typeof effectSchema>;
  /** The x3 Boost driver. */
  targetAssetId: string | null;
}

/**
 * The chip each team has played for an event, by team id (one per race); a
 * team with none, or only a refunded one, is left out.
 */
export async function playedChips(
  db: Db,
  input: { eventId: string; teamIds: string[] },
): Promise<Map<string, PlayedChip>> {
  const { eventId, teamIds } = input;
  if (teamIds.length === 0) return new Map();
  const rows = await db
    .select({
      teamId: chipPlays.teamId,
      id: chipPlays.id,
      code: chipPlays.chipCode,
      targetAssetId: chipPlays.targetAssetId,
      // The database's own reading of the ruleset, as its checks use.
      effect: sql<unknown>`chip_effect(${chipPlays.gameId}, ${chipPlays.eventId}, ${chipPlays.chipCode})`,
    })
    .from(chipPlays)
    .where(
      and(
        eq(chipPlays.eventId, eventId),
        inArray(chipPlays.teamId, teamIds),
        eq(chipPlays.status, "played"),
      ),
    );
  return new Map(
    rows.map((row) => [
      row.teamId,
      {
        id: row.id,
        code: row.code,
        effect: effectSchema.parse(row.effect),
        targetAssetId: row.targetAssetId,
      },
    ]),
  );
}

/**
 * Runs the deferred checks now, inside the caller's try, so a refusal is
 * mapped even when the transaction is nested in a caller's; then back to
 * deferred for whatever else the caller does (as `saveLineup` does).
 */
async function checkNow(db: Db, triggers: string[]) {
  const names = sql.raw(triggers.map((name) => `"${name}"`).join(", "));
  await db.execute(sql`set constraints ${names} immediate`);
  await db.execute(sql`set constraints ${names} deferred`);
}

/**
 * Plays a chip for the game's open event and returns the play's id. The x3
 * Boost (`triple_boost`) needs `targetAssetId`: a driver in the team's latest
 * lineup for the event (or its base) that doesn't have the 2x Boost; no other
 * chip takes one. Late Call (`final_fix`) is played with its swap, by
 * `saveFinalFix`, never here.
 *
 * Each refusal is a `GameError` and writes nothing: `chip_window_closed`
 * outside the event's window, `chip_unavailable` for a code the ruleset
 * doesn't have, a chip played already this season or another one for this
 * race, or one that unlocks after the team's first event, and `composition`
 * for a missing or wrong x3 Boost target.
 */
export async function playChip(
  db: Db,
  now: Date,
  input: { teamId: string; chipCode: string; targetAssetId?: string },
): Promise<string> {
  const { teamId, chipCode, targetAssetId } = input;
  try {
    return await db.transaction(async (tx) => {
      // Takes turns with the team's saves, so the x3 target is checked
      // against the lineup as it stands.
      const [team] = await tx
        .select()
        .from(teams)
        .where(eq(teams.id, teamId))
        .for("update");
      if (!team) throw new Error(`playChip: no team ${teamId}`);

      const open = await tx
        .select({
          eventId: gameEvents.eventId,
          lockAt: events.lockAt,
          params: rulesetVersions.params,
        })
        .from(gameEvents)
        .innerJoin(events, eq(events.id, gameEvents.eventId))
        .innerJoin(
          rulesetVersions,
          eq(rulesetVersions.id, gameEvents.rulesetVersionId),
        )
        .where(
          and(
            eq(gameEvents.gameId, team.gameId),
            eq(gameEvents.status, "open"),
          ),
        );
      if (open.length > 1) {
        throw new Error(
          `playChip: game ${team.gameId} has several open events`,
        );
      }
      const [event] = open;
      if (!event || now.getTime() >= event.lockAt.getTime()) {
        throw new GameError(
          "chip_window_closed",
          "chips can't be played for now",
        );
      }
      const chip = rulesetParamsSchema
        .parse(event.params)
        .chips.find((c) => c.code === chipCode);
      if (!chip) {
        throw new GameError("chip_unavailable", `there is no chip ${chipCode}`);
      }
      if (chip.effect === "final_fix") {
        throw new Error(
          `playChip: ${chipCode} is played with its swap, by saveFinalFix`,
        );
      }
      if (chip.effect === "triple_boost" && targetAssetId === undefined) {
        throw new GameError(
          "composition",
          `${chip.name} needs a driver to target`,
        );
      }
      if (chip.effect !== "triple_boost" && targetAssetId !== undefined) {
        throw new Error(`playChip: ${chipCode} takes no target`);
      }

      const id = newId();
      // played_at is left to the database.
      await tx.insert(chipPlays).values({
        id,
        teamId,
        gameId: team.gameId,
        chipCode,
        eventId: event.eventId,
        targetAssetId: targetAssetId ?? null,
        status: "played",
      });
      await checkNow(tx, ["chip_plays_check"]);
      return id;
    });
  } catch (error) {
    throw refusal(error);
  }
}

/**
 * Plays Late Call (`final_fix`) for the game's latest locked event, with its
 * one swap, in one transaction: the chip, a `final_fix` version from the race
 * session (the locked lineup with `outAssetId` swapped for `inAssetId`; the
 * Boost moves to the incoming driver if the outgoing one had it), and the
 * event's lock record pointing at both. Earlier sessions still count the
 * locked lineup, and the next event's base is the locked one too (DM 3.8).
 *
 * The window is the database's: from qualifying's results arriving to the
 * race's scheduled start (`chip_window_closed` outside it). Also refused:
 * `chip_unavailable` at the team's first event, for a team with no lock
 * record there, or when it has played a chip for the race or Late Call this
 * season; `composition` for an asset it doesn't have, one it has already, or
 * a swap of a driver for a constructor; `over_budget` beyond the event's
 * purchasing power. A refusal writes nothing.
 */
export async function saveFinalFix(
  db: Db,
  now: Date,
  input: { teamId: string; outAssetId: string; inAssetId: string },
): Promise<{ versionId: string; chipPlayId: string }> {
  const { teamId, outAssetId, inAssetId } = input;
  try {
    return await db.transaction(async (tx) => {
      const [team] = await tx
        .select()
        .from(teams)
        .where(eq(teams.id, teamId))
        .for("update");
      if (!team) throw new Error(`saveFinalFix: no team ${teamId}`);

      // The race weekend under way: the game's latest event that has locked.
      const [event] = await tx
        .select({
          eventId: gameEvents.eventId,
          params: rulesetVersions.params,
        })
        .from(gameEvents)
        .innerJoin(
          rulesetVersions,
          eq(rulesetVersions.id, gameEvents.rulesetVersionId),
        )
        .where(
          and(
            eq(gameEvents.gameId, team.gameId),
            inArray(gameEvents.status, ["locked", "scored"]),
          ),
        )
        .orderBy(desc(gameEvents.sequence))
        .limit(1);
      const [race] = event
        ? await tx
            .select({
              id: sessions.id,
              scheduledStart: sessions.scheduledStart,
            })
            .from(sessions)
            .where(
              and(
                eq(sessions.eventId, event.eventId),
                eq(sessions.kind, "race"),
              ),
            )
            .orderBy(asc(sessions.sequence))
            .limit(1)
        : [];
      if (!event || !race || now.getTime() >= race.scheduledStart.getTime()) {
        throw new GameError(
          "chip_window_closed",
          "Late Call can't be played for now",
        );
      }
      const chip = rulesetParamsSchema
        .parse(event.params)
        .chips.find((c) => c.effect === "final_fix");
      if (!chip) {
        throw new GameError("chip_unavailable", "this game has no Late Call");
      }

      const [state] = await tx
        .select({ lockedVersionId: teamEventStates.lockedVersionId })
        .from(teamEventStates)
        .where(
          and(
            eq(teamEventStates.teamId, teamId),
            eq(teamEventStates.eventId, event.eventId),
          ),
        );
      if (!state) {
        throw new GameError(
          "chip_unavailable",
          `${chip.name} is for a team that took part in this event`,
        );
      }
      const locked: LineupPick[] = await tx
        .select({ assetId: lineupPicks.assetId, isBoost: lineupPicks.isBoost })
        .from(lineupPicks)
        .where(eq(lineupPicks.lineupVersionId, state.lockedVersionId))
        .orderBy(asc(lineupPicks.assetId));
      if (!locked.some((p) => p.assetId === outAssetId)) {
        throw new GameError("composition", "that asset isn't in the lineup");
      }
      if (locked.some((p) => p.assetId === inAssetId)) {
        throw new GameError(
          "composition",
          "that asset is in the lineup already",
        );
      }
      // The incoming asset takes the outgoing one's place, Boost and all.
      const picks = locked.map((p) =>
        p.assetId === outAssetId ? { ...p, assetId: inAssetId } : p,
      );

      const chipPlayId = newId();
      await tx.insert(chipPlays).values({
        id: chipPlayId,
        teamId,
        gameId: team.gameId,
        chipCode: chip.code,
        eventId: event.eventId,
        status: "played",
      });
      const versionId = newId();
      await tx.insert(lineupVersions).values({
        id: versionId,
        teamId,
        forEventId: event.eventId,
        kind: "final_fix",
        effectiveFromSessionId: race.id,
        basedOnVersionId: state.lockedVersionId,
      });
      await tx
        .insert(lineupPicks)
        .values(picks.map((p) => ({ lineupVersionId: versionId, ...p })));
      await tx
        .update(teamEventStates)
        .set({ finalFixVersionId: versionId, chipPlayId, updatedAt: now })
        .where(
          and(
            eq(teamEventStates.teamId, teamId),
            eq(teamEventStates.eventId, event.eventId),
          ),
        );
      await checkNow(tx, [
        "chip_plays_check",
        "lineup_versions_check",
        "lineup_picks_check",
      ]);
      return { versionId, chipPlayId };
    });
  } catch (error) {
    throw refusal(error);
  }
}

/**
 * The system's refund (DM 3.9): every chip played for an event goes from
 * `played` to `refunded`, so the team can play it again later. Only for an
 * event that was cancelled, which the database insists on. Returns how many
 * were refunded; running it again refunds none.
 */
export async function refundChips(
  db: Db,
  now: Date,
  input: { gameId: string; eventId: string },
): Promise<number> {
  const refunded = await db
    .update(chipPlays)
    .set({ status: "refunded", updatedAt: now })
    .where(
      and(
        eq(chipPlays.gameId, input.gameId),
        eq(chipPlays.eventId, input.eventId),
        eq(chipPlays.status, "played"),
      ),
    )
    .returning({ id: chipPlays.id });
  return refunded.length;
}
