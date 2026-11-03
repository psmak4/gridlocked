import { and, asc, eq, ne } from "drizzle-orm";
import {
  events,
  gameEvents,
  games,
  rulesetVersions,
  teamEventStates,
  type GAME_EVENT_STATUSES,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { newId } from "@/lib/ids";
import { refundChips } from "./chips";
import { carryPrices } from "./prices";
import { rulesetParamsSchema, type RulesetParams } from "./ruleset";

// Games and their calendar (DM 3.1, 3.3). Reads reference data, never writes
// it (DM 0.5).

type GameEventStatus = (typeof GAME_EVENT_STATUSES)[number];

/** A game event in one of these statuses is never changed by planning. */
const FROZEN: readonly GameEventStatus[] = ["locked", "scored", "final"];

/**
 * Creates a `season_fantasy` game in `setup` for a season, with ruleset
 * version 1 effective from the season's first non-cancelled event (by lock
 * time), then plans its events. `params` is checked against the schema first.
 * A second game for the same season and type is refused by the database.
 */
export async function createGame(
  db: Db,
  now: Date,
  input: {
    seasonId: string;
    slug: string;
    name: string;
    params: RulesetParams;
    notes: string;
  },
): Promise<{ gameId: string; rulesetVersionId: string }> {
  const params = rulesetParamsSchema.parse(input.params);
  return db.transaction(async (tx) => {
    const [first] = await tx
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.seasonId, input.seasonId),
          ne(events.status, "cancelled"),
        ),
      )
      .orderBy(asc(events.lockAt), asc(events.round))
      .limit(1);
    if (!first) {
      throw new Error(`createGame: season ${input.seasonId} has no events`);
    }

    const gameId = newId();
    await tx.insert(games).values({
      id: gameId,
      seasonId: input.seasonId,
      gameType: "season_fantasy",
      slug: input.slug,
      name: input.name,
      status: "setup",
      createdAt: now,
      updatedAt: now,
    });
    const rulesetVersionId = newId();
    await tx.insert(rulesetVersions).values({
      id: rulesetVersionId,
      gameId,
      version: 1,
      effectiveFromEventId: first.id,
      params,
      notes: input.notes,
      publishedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await planGameEvents(tx, now, gameId);
    return { gameId, rulesetVersionId };
  });
}

/**
 * Brings a game's `game_events` in line with its season's calendar, one row
 * per event:
 * - `sequence` is 1..n by `lock_at` over non-cancelled events (ties by round);
 *   a cancelled event has `sequence` null and status `cancelled`;
 * - `ruleset_version_id` is the version whose effective-from event has the
 *   latest `lock_at` at or before this event's. An event before every version
 *   takes the earliest one, so the column is never empty;
 * - a row whose lock has started is never changed: one that is `locked` or
 *   later, whose `lock_at` is at or before `now`, or that has a lock record
 *   row already (the lock job writes in batches), whatever its status. Its
 *   sequence stays, and the events still open for planning take the other
 *   numbers, in lock order. So a race called off after qualifying keeps its
 *   lock record and its chips (DM 3.9), and an event called off mid-lock
 *   still locks: only an event cancelled before its lock is cancelled here.
 *
 * An event cancelled before its lock, in the same transaction (DM 3.9): its
 * row becomes `cancelled`, its chips are refunded (`refundChips`), and if it
 * was the open event, the next upcoming one opens at once, with its prices
 * carried first for every asset that has none (`carryPrices`: the cancelled
 * event's, so prices don't change). Nothing locks for it, and lineups saved
 * for it count at the next lock (`lockedLineup`).
 *
 * Writes only what differs, so running it again changes nothing. Call it when
 * a game is created, a version is added and whenever the calendar changes.
 * Runs for one game take turns (the game row is held).
 */
export async function planGameEvents(
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
    if (!game) throw new Error(`planGameEvents: no game ${gameId}`);

    const calendar = await tx
      .select()
      .from(events)
      .where(eq(events.seasonId, game.seasonId))
      .orderBy(asc(events.lockAt), asc(events.round));
    const existing = new Map(
      (
        await tx.select().from(gameEvents).where(eq(gameEvents.gameId, gameId))
      ).map((row) => [row.eventId, row]),
    );

    // The versions, by the lock time of the event each takes effect from.
    const versions = (
      await tx
        .select({
          id: rulesetVersions.id,
          version: rulesetVersions.version,
          from: events.lockAt,
        })
        .from(rulesetVersions)
        .innerJoin(events, eq(events.id, rulesetVersions.effectiveFromEventId))
        .where(eq(rulesetVersions.gameId, gameId))
    ).sort(
      (a, b) => a.from.getTime() - b.from.getTime() || a.version - b.version,
    );
    if (versions.length === 0) {
      throw new Error(`planGameEvents: game ${gameId} has no ruleset version`);
    }
    const versionFor = (lockAt: Date): string => {
      let chosen = versions[0]!;
      for (const v of versions) {
        if (v.from.getTime() <= lockAt.getTime()) chosen = v;
      }
      return chosen.id;
    };

    // A row is frozen once its lock has started, whatever its status: from
    // `lock_at` the lineups are fixed, and the lock job writes in batches,
    // marking the event `locked` only with the last. So an event cancelled
    // after its lock_at, or with a batch written, still locks (DM 3.9).
    const started = new Set(
      (
        await tx
          .selectDistinct({ eventId: teamEventStates.eventId })
          .from(teamEventStates)
          .where(eq(teamEventStates.gameId, gameId))
      ).map((row) => row.eventId),
    );
    const frozen = new Set(
      calendar
        .filter((event) => {
          const row = existing.get(event.id);
          return (
            row !== undefined &&
            (FROZEN.includes(row.status) ||
              event.lockAt.getTime() <= now.getTime() ||
              started.has(event.id))
          );
        })
        .map((event) => event.id),
    );

    // Frozen rows keep their numbers; the rest fill the gaps in lock order.
    const taken = new Set<number>();
    for (const row of existing.values()) {
      if (frozen.has(row.eventId) && row.sequence !== null) {
        taken.add(row.sequence);
      }
    }
    let next = 0;
    const nextSequence = (): number => {
      do next += 1;
      while (taken.has(next));
      return next;
    };

    const cancelledNow: { eventId: string; wasOpen: boolean }[] = [];
    for (const event of calendar) {
      const row = existing.get(event.id);
      if (frozen.has(event.id)) continue;

      const cancelled = event.status === "cancelled";
      const status: GameEventStatus = cancelled
        ? "cancelled"
        : row && row.status !== "cancelled"
          ? row.status
          : "upcoming";
      const sequence = cancelled ? null : nextSequence();
      const rulesetVersionId = versionFor(event.lockAt);

      if (!row) {
        await tx.insert(gameEvents).values({
          gameId,
          eventId: event.id,
          sequence,
          status,
          rulesetVersionId,
          createdAt: now,
          updatedAt: now,
        });
      } else if (
        row.sequence !== sequence ||
        row.status !== status ||
        row.rulesetVersionId !== rulesetVersionId
      ) {
        await tx
          .update(gameEvents)
          .set({ sequence, status, rulesetVersionId, updatedAt: now })
          .where(
            and(
              eq(gameEvents.gameId, gameId),
              eq(gameEvents.eventId, event.id),
            ),
          );
      }
      if (cancelled && row && row.status !== "cancelled") {
        cancelledNow.push({
          eventId: event.id,
          wasOpen: row.status === "open",
        });
      }
    }

    // Cancelled before its lock: the chips come back (the database allows a
    // refund only once the event is `cancelled`, as it now is).
    for (const { eventId } of cancelledNow) {
      await refundChips(tx, now, { gameId, eventId });
    }
    // The open event was cancelled: the window moves on to the next event
    // (the earlier ones have all locked, since this one was open).
    if (cancelledNow.some((c) => c.wasOpen)) {
      const [next] = await tx
        .select()
        .from(gameEvents)
        .where(
          and(eq(gameEvents.gameId, gameId), eq(gameEvents.status, "upcoming")),
        )
        .orderBy(asc(gameEvents.sequence))
        .limit(1);
      if (next) {
        await carryPrices(tx, now, { gameId, eventId: next.eventId });
        await tx
          .update(gameEvents)
          .set({ status: "open", updatedAt: now })
          .where(
            and(
              eq(gameEvents.gameId, gameId),
              eq(gameEvents.eventId, next.eventId),
            ),
          );
      }
    }
  });
}
