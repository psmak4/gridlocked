import { and, asc, eq, ne } from "drizzle-orm";
import {
  events,
  gameEvents,
  games,
  leagues,
  rulesetVersions,
  scoringRules,
  teamEventStates,
  type GAME_EVENT_STATUSES,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { newId } from "@/lib/ids";
import { openReviewItem } from "@/reference/review";
import { refundChips } from "./chips";
import { carryPrices } from "./prices";
import { scoringRuleSchema, type ScoringRule } from "@/scoring/rules";
import { rulesetParamsSchema, type RulesetParams } from "./ruleset";

// Games and their calendar (DM 3.1, 3.3). Reads reference data, never writes
// it (DM 0.5).

type GameEventStatus = (typeof GAME_EVENT_STATUSES)[number];

/** A game event in one of these statuses is never changed by planning. */
const FROZEN: readonly GameEventStatus[] = ["locked", "scored", "final"];

/**
 * Creates a `season_fantasy` game in `setup` for a season, with ruleset
 * version 1 effective from the season's first non-cancelled event (by lock
 * time), then plans its events. `params` and each of `rules` (stored with
 * version 1) are checked against their schemas first. The game also gets its
 * `global` league. A second game for the same season and type is refused by
 * the database.
 */
export async function createGame(
  db: Db,
  now: Date,
  input: {
    seasonId: string;
    slug: string;
    name: string;
    params: RulesetParams;
    rules: ScoringRule[];
    notes: string;
  },
): Promise<{ gameId: string; rulesetVersionId: string }> {
  const params = rulesetParamsSchema.parse(input.params);
  const rules = input.rules.map((rule) => scoringRuleSchema.parse(rule));
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
    // The game's one global league (DM 4.5): every active team is in it by
    // definition, so it has no membership rows.
    await tx.insert(leagues).values({
      id: newId(),
      gameId,
      kind: "global",
      name: "Global",
      slug: "global",
      status: "active",
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
    if (rules.length > 0) {
      await tx.insert(scoringRules).values(
        rules.map((rule) => ({
          id: newId(),
          rulesetVersionId,
          ...rule,
          createdAt: now,
          updatedAt: now,
        })),
      );
    }
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
 *   takes the earliest one, so the column is never empty. A rule change takes
 *   effect from an upcoming event: a version that would change the open
 *   event's version, or that starts from an event that is open or has locked,
 *   is dropped for the run (the rows keep their versions, and the rest is
 *   planned as normal), and a warning review item `ruleset_version_refused`
 *   (dedupe key `ruleset_version_refused:<game>:<version>`) asks an admin to
 *   look;
 * - a row whose lock has started is never changed: one that is `locked` or
 *   later, whose `lock_at` is at or before `now`, or that has a lock record
 *   row already (the lock job writes in batches), whatever its status. Its
 *   sequence stays, and the events still open for planning take the other
 *   numbers, in lock order. So a race called off after qualifying keeps its
 *   lock record and its chips (DM 3.9), and an event called off mid-lock
 *   still locks: only an event cancelled before its lock is cancelled here.
 *
 * An event cancelled in the game and then reinstated on the calendar stays
 * cancelled here once a later event of the game is `open` or has locked: the
 * window has moved past it. A warning review item `game_event_reinstated`
 * (dedupe key `game_event_reinstated:<game>:<event>`) asks an admin to look.
 * Reinstated before any later event opened, it is planned again as normal.
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
 * Runs for one game take turns (the game row is held). A row is written only
 * from the status this run read: if another writer (the lock job, which
 * doesn't hold the game row) changed it since, the run throws and writes
 * nothing, and planning again sees the new status.
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
          fromEventId: rulesetVersions.effectiveFromEventId,
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
    // Versions refused this run (below): they apply to no event.
    const dropped = new Set<string>();
    const versionFor = (lockAt: Date) => {
      const live = versions.filter((v) => !dropped.has(v.id));
      let chosen = live[0] ?? versions[0]!;
      for (const v of live) {
        if (v.from.getTime() <= lockAt.getTime()) chosen = v;
      }
      return chosen;
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

    // A game event the window has reached: open, or locked or later.
    const reached = (eventId: string) => {
      const status = existing.get(eventId)?.status;
      return (
        status === "open" || (status !== undefined && FROZEN.includes(status))
      );
    };

    // A version takes effect only from an upcoming event. One that would
    // change the version of the open event, or that starts from an event the
    // window has reached, would change rules lineups were already saved
    // under: it is dropped for this run, for an admin to look at, and the
    // rest is planned without it. Each drop can uncover an earlier version
    // that is refused too, so this runs until nothing more is.
    for (;;) {
      const refused = calendar
        .map((event) => {
          const row = existing.get(event.id);
          if (!row || frozen.has(event.id) || dropped.has(row.rulesetVersionId))
            return undefined;
          const v = versionFor(event.lockAt);
          if (v.id === row.rulesetVersionId || dropped.has(v.id))
            return undefined;
          return row.status === "open" || reached(v.fromEventId)
            ? { v, event, row }
            : undefined;
        })
        .find((found) => found !== undefined);
      if (!refused) break;
      const { v, event, row } = refused;
      dropped.add(v.id);
      await openReviewItem(tx, now, {
        kind: "ruleset_version_refused",
        seasonId: game.seasonId,
        eventId: v.fromEventId,
        details: {
          gameId,
          rulesetVersionId: v.id,
          version: v.version,
          fromEventStatus: existing.get(v.fromEventId)?.status ?? null,
          wouldApplyTo: event.id,
          wouldApplyToStatus: row.status,
        },
        dedupeKey: `ruleset_version_refused:${gameId}:${v.version}`,
      });
    }

    const cancelledNow: { eventId: string; wasOpen: boolean }[] = [];
    for (const [i, event] of calendar.entries()) {
      const row = existing.get(event.id);
      if (frozen.has(event.id)) continue;

      // Reinstated on the calendar after a later event opened: the window has
      // moved past it, and putting it back ahead of that event would leave
      // neither able to lock. It stays cancelled here, for an admin to look at.
      const passed =
        event.status !== "cancelled" &&
        row?.status === "cancelled" &&
        calendar.slice(i + 1).find((later) => reached(later.id));
      if (passed) {
        await openReviewItem(tx, now, {
          kind: "game_event_reinstated",
          seasonId: game.seasonId,
          eventId: event.id,
          details: {
            gameId,
            openEventId: passed.id,
            openEventStatus: existing.get(passed.id)!.status,
          },
          dedupeKey: `game_event_reinstated:${gameId}:${event.id}`,
        });
      }
      const cancelled = event.status === "cancelled" || Boolean(passed);
      const status: GameEventStatus = cancelled
        ? "cancelled"
        : row && row.status !== "cancelled"
          ? row.status
          : "upcoming";
      const sequence = cancelled ? null : nextSequence();
      // A row on a version dropped this run keeps it.
      const rulesetVersionId =
        row && dropped.has(row.rulesetVersionId)
          ? row.rulesetVersionId
          : versionFor(event.lockAt).id;

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
        // Only from the status read: the lock job doesn't hold the game row,
        // and its last batch may have locked the event since. Losing that
        // race rolls the whole run back, leaving the row as the lock left it
        // (the rest was planned around the status read); the caller plans
        // again.
        const [updated] = await tx
          .update(gameEvents)
          .set({ sequence, status, rulesetVersionId, updatedAt: now })
          .where(
            and(
              eq(gameEvents.gameId, gameId),
              eq(gameEvents.eventId, event.id),
              eq(gameEvents.status, row.status),
            ),
          )
          .returning({ eventId: gameEvents.eventId });
        if (!updated) {
          throw new Error(
            `planGameEvents: event ${event.id} of game ${gameId} is no longer ${row.status}; plan again`,
          );
        }
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
