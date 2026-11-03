import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  notInArray,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import {
  events,
  gameEvents,
  games,
  lineupPicks,
  rulesetVersions,
  teamEventStates,
  teams,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { lockedLineups } from "./lineups";
import { priceList } from "./prices";
import { rulesetParamsSchema } from "./ruleset";
import {
  carryOverOut,
  freeTransfers,
  netTransfers,
  transferPenalty,
} from "./transfers";

// The per-event lock record (DM 3.8): one `team_event_states` row per team that
// took part. Reads reference data, never writes it (DM 0.5). Every value comes
// from versions saved before `lock_at`, the event's prices and the team's
// earlier rows, so a late or repeated run writes what an on-time one would
// (lock correctness doesn't depend on the lock job).

/** Teams per batch: about 1,000 per job (DM 2.10, 3.12). */
const BATCH = 1000;
/** An event in one of these has its lock record written. */
const LOCKED_OR_LATER = ["locked", "scored", "final"] as const;

/** One team's standing going into the event (`team_base_state`). */
const baseRowSchema = z.object({
  team_id: z.string(),
  base_version_id: z.string().nullable(),
  bank: z.number().int().nullable(),
  carry_in: z.number().int(),
  is_first: z.boolean(),
  purchasing_power: z.number().int(),
});

/**
 * Writes the lock record for one batch of an event's teams, and returns how
 * many rows it wrote, the last team it looked at and whether the event is
 * done. A batch is up to `limit` `active` teams of the game after
 * `afterTeamId`, in id order; the next batch starts after `lastTeamId`.
 *
 * Each team with a locked lineup (`lockedLineup`: what it saved, or its base)
 * gets one row; a team with neither, or a retired one, gets none. A row that is
 * already there is left as it is, so running a batch again writes nothing. A
 * team's first row sets its `first_event_id`. The batch that finds no more
 * teams sets the event `locked` and an `open` game `running`.
 *
 * Refused while `now` is before `lock_at`, while an earlier event of the game
 * (by sequence, not cancelled) hasn't locked, and for an event that is neither
 * `open` nor already `locked`. A bank below 0 outside a Limitless week is a
 * broken rule (the save check prevents it), and fails the batch.
 */
export async function lockEvent(
  db: Db,
  now: Date,
  input: {
    gameId: string;
    eventId: string;
    afterTeamId?: string;
    limit?: number;
  },
): Promise<{ written: number; lastTeamId: string | null; done: boolean }> {
  const { gameId, eventId, afterTeamId, limit = BATCH } = input;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`lockEvent: limit ${limit} is not a positive integer`);
  }
  return db.transaction(async (tx) => {
    const [event] = await tx
      .select({
        status: gameEvents.status,
        sequence: gameEvents.sequence,
        rulesetVersionId: gameEvents.rulesetVersionId,
        params: rulesetVersions.params,
        lockAt: events.lockAt,
      })
      .from(gameEvents)
      .innerJoin(events, eq(events.id, gameEvents.eventId))
      .innerJoin(
        rulesetVersions,
        eq(rulesetVersions.id, gameEvents.rulesetVersionId),
      )
      .where(
        and(eq(gameEvents.gameId, gameId), eq(gameEvents.eventId, eventId)),
      );
    if (!event)
      throw new Error(`lockEvent: game ${gameId} has no event ${eventId}`);
    if (now.getTime() < event.lockAt.getTime()) {
      throw new Error(
        `lockEvent: event ${eventId} is before its lock_at (${event.lockAt.toISOString()}); it is ${now.toISOString()}`,
      );
    }
    // Events lock in order, so a team's earlier rows are there when its next
    // one is computed (team_base_state reads them).
    if (event.sequence !== null) {
      const [waiting] = await tx
        .select({ eventId: gameEvents.eventId, status: gameEvents.status })
        .from(gameEvents)
        .where(
          and(
            eq(gameEvents.gameId, gameId),
            lt(gameEvents.sequence, event.sequence),
            notInArray(gameEvents.status, [...LOCKED_OR_LATER, "cancelled"]),
          ),
        )
        .orderBy(asc(gameEvents.sequence))
        .limit(1);
      if (waiting) {
        throw new Error(
          `lockEvent: event ${eventId} can't lock before the earlier event ${waiting.eventId}, which is ${waiting.status}`,
        );
      }
    }
    if (event.status !== "open" && event.status !== "locked") {
      throw new Error(
        `lockEvent: event ${eventId} is ${event.status}, not open or locked`,
      );
    }
    const params = rulesetParamsSchema.parse(event.params);

    // Locked in id order: a save still committing for one of these teams
    // finishes first (saveLineup holds the same row), and is then seen.
    const batch = await tx
      .select({ id: teams.id })
      .from(teams)
      .where(
        and(
          eq(teams.gameId, gameId),
          eq(teams.status, "active"),
          afterTeamId === undefined ? undefined : gt(teams.id, afterTeamId),
        ),
      )
      .orderBy(asc(teams.id))
      .limit(limit + 1)
      .for("update");
    const more = batch.length > limit;
    const ids = batch.slice(0, limit).map((row) => row.id);

    const lineups = await lockedLineups(tx, { eventId, teamIds: ids });
    const taking = ids.filter((id) => lineups.has(id));
    let written = 0;
    if (taking.length > 0) {
      // Both functions are the database's: the same sums the save check made.
      const { rows } = (await tx.execute(sql`
        select "teams"."id" as team_id, b.base_version_id, b.bank, b.carry_in,
               b.is_first, team_purchasing_power("teams"."id", ${eventId}::uuid) as purchasing_power
        from "teams" cross join lateral team_base_state("teams"."id", ${eventId}::uuid) b
        where ${inArray(teams.id, taking)}
      `)) as { rows: unknown[] };
      const bases = new Map(
        z
          .array(baseRowSchema)
          .parse(rows)
          .map((base) => [base.team_id, base]),
      );
      const baseIds = [...bases.values()]
        .map((b) => b.base_version_id)
        .filter((id): id is string => id !== null);
      const owned = new Map<string, string[]>();
      if (baseIds.length > 0) {
        for (const pick of await tx
          .select()
          .from(lineupPicks)
          .where(inArray(lineupPicks.lineupVersionId, baseIds))) {
          const list = owned.get(pick.lineupVersionId) ?? [];
          list.push(pick.assetId);
          owned.set(pick.lineupVersionId, list);
        }
      }
      const prices = await priceList(tx, { gameId, eventId });

      const states = taking.map((teamId) => {
        const lineup = lineups.get(teamId)!;
        const base = bases.get(teamId);
        if (!base)
          throw new Error(`lockEvent: no base state for team ${teamId}`);
        const assetIds = lineup.picks.map((p) => p.assetId);
        let spent = 0;
        for (const assetId of assetIds) {
          const price = prices.get(assetId);
          if (price === undefined) {
            throw new Error(
              `lockEvent: asset ${assetId} has no price at event ${eventId}`,
            );
          }
          spent += price;
        }
        // Wildcard joins this with Task 7's chips.
        const limitless = lineup.kind === "limitless";
        const free = freeTransfers(params, {
          isFirstEvent: base.is_first,
          carryIn: base.carry_in,
          unlimited: limitless,
        });
        const made = netTransfers(
          base.base_version_id ? (owned.get(base.base_version_id) ?? []) : [],
          assetIds,
        );
        const bank = base.purchasing_power - spent;
        if (bank < 0 && !limitless) {
          throw new Error(
            `lockEvent: team ${teamId} would bank ${bank} at event ${eventId} (spent ${spent} of ${base.purchasing_power}): the budget rule is broken`,
          );
        }
        return {
          teamId,
          eventId,
          gameId,
          baseVersionId: base.base_version_id,
          lockedVersionId: lineup.versionId,
          isFirstEvent: base.is_first,
          purchasingPower: base.purchasing_power,
          spent,
          bank,
          transfersMade: made,
          freeTransfers: free,
          carryOverOut: carryOverOut(params, { free, made }),
          transferPenalty: transferPenalty(params, { free, made }),
          rulesetVersionId: event.rulesetVersionId,
          createdAt: now,
          updatedAt: now,
        };
      });
      const inserted = await tx
        .insert(teamEventStates)
        .values(states)
        .onConflictDoNothing()
        .returning({ teamId: teamEventStates.teamId });
      written = inserted.length;
      await tx
        .update(teams)
        .set({ firstEventId: eventId, updatedAt: now })
        .where(and(inArray(teams.id, taking), isNull(teams.firstEventId)));
    }

    if (!more) {
      await tx
        .update(gameEvents)
        .set({ status: "locked", updatedAt: now })
        .where(
          and(
            eq(gameEvents.gameId, gameId),
            eq(gameEvents.eventId, eventId),
            eq(gameEvents.status, "open"),
          ),
        );
      await tx
        .update(games)
        .set({ status: "running", updatedAt: now })
        .where(and(eq(games.id, gameId), eq(games.status, "open")));
    }
    return { written, lastTeamId: ids.at(-1) ?? null, done: !more };
  });
}
