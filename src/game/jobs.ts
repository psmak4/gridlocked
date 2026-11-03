import { and, asc, eq, ne, sql } from "drizzle-orm";
import {
  events,
  gameEvents,
  jobs,
  rulesetVersions,
  sessions,
  type GAME_EVENT_STATUSES,
} from "@/db/schema";
import type { Db } from "@/db/types";
import {
  gameLockAfterKey,
  gameLockKey,
  gameLockPayload,
  gameLockWaitKey,
  gameOpenKey,
  gameOpenPayload,
  gameOpenRecheckKey,
  type GameLockPayload,
  type GameOpenPayload,
} from "@/jobs/kinds";
import { enqueue } from "@/jobs/queue";
import type { JobHandler } from "@/jobs/runner";
import { getSetting } from "@/settings";
import { lockEvent } from "./lock";
import { carryPrices } from "./prices";
import { rulesetParamsSchema } from "./ruleset";

// The game's two jobs on the scheduler tick (HLD §3.3): locking an event at its
// `lock_at` and opening the next one. Both are only a trigger: what the lock
// writes and when the lineups close come from the database, so a job that
// runs late changes nothing about the result (rule 3). They read reference
// data and never write it.

type GameEventStatus = (typeof GAME_EVENT_STATUSES)[number];

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** A lock job that must wait for the event before it looks again after this. */
const LOCK_WAIT_MS = 5 * MINUTE_MS;

/** An event in one of these has had its lock record written. */
const LOCKED_OR_LATER: readonly GameEventStatus[] = [
  "locked",
  "scored",
  "final",
];
const isLockedOrLater = (status: GameEventStatus) =>
  LOCKED_OR_LATER.includes(status);

/**
 * Writes a game's calendar-driven jobs as `pending` rows with future `run_at`
 * (DM 2.10), all through `enqueue` so planning again only moves them:
 * - `game_lock:<game>:<event>` at `lock_at` for every `upcoming` or `open`
 *   event;
 * - `game_open:<game>:<event>` for every `upcoming` event after the first, at
 *   the end of the previous event's race plus the largest `finalizer_checks`
 *   delay, when that event has been finalized or is about to be.
 *
 * An event that has locked, or been cancelled, gets nothing. Call it whenever
 * the calendar is synced.
 */
export async function planGameJobs(db: Db, gameId: string): Promise<void> {
  const calendar = await db
    .select({
      eventId: gameEvents.eventId,
      status: gameEvents.status,
      lockAt: events.lockAt,
    })
    .from(gameEvents)
    .innerJoin(events, eq(events.id, gameEvents.eventId))
    .where(
      and(eq(gameEvents.gameId, gameId), ne(gameEvents.status, "cancelled")),
    )
    .orderBy(asc(gameEvents.sequence));
  const { afterHours } = await getSetting(db, "finalizer_checks");
  const settleMs = Math.max(...afterHours) * HOUR_MS;

  // When each event's weekend ends: its last race, else its last session.
  const ends = new Map<string, { race?: number; any: number }>();
  for (const s of await db
    .select({
      eventId: sessions.eventId,
      kind: sessions.kind,
      end: sessions.scheduledEnd,
    })
    .from(sessions)
    .where(ne(sessions.status, "cancelled"))) {
    const seen = ends.get(s.eventId) ?? { any: 0 };
    seen.any = Math.max(seen.any, s.end.getTime());
    if (s.kind === "race")
      seen.race = Math.max(seen.race ?? 0, s.end.getTime());
    ends.set(s.eventId, seen);
  }

  await db.transaction(async (tx) => {
    for (const [i, event] of calendar.entries()) {
      if (event.status !== "upcoming" && event.status !== "open") continue;
      const lock: GameLockPayload = { gameId, eventId: event.eventId };
      await enqueue(tx, {
        kind: "game_lock",
        dedupeKey: gameLockKey(gameId, event.eventId),
        runAt: event.lockAt,
        payload: lock,
      });
      // A lock job that put itself off (or went on to a next batch) has a key
      // of its own: the pending one, whichever it is, moves with `lock_at`.
      await tx
        .update(jobs)
        .set({ runAt: event.lockAt })
        .where(
          and(
            eq(jobs.kind, "game_lock"),
            eq(jobs.status, "pending"),
            sql`${jobs.payload}->>'gameId' = ${gameId}`,
            sql`${jobs.payload}->>'eventId' = ${event.eventId}`,
          ),
        );

      const previous = calendar[i - 1];
      if (event.status !== "upcoming" || !previous) continue;
      const weekend = ends.get(previous.eventId);
      const over = weekend?.race ?? weekend?.any ?? previous.lockAt.getTime();
      const open: GameOpenPayload = { gameId, eventId: event.eventId };
      await enqueue(tx, {
        kind: "game_open",
        dedupeKey: gameOpenKey(gameId, event.eventId),
        runAt: new Date(over + settleMs),
        payload: open,
      });
    }
  });
}

/**
 * The event's own row (with the `window` of its ruleset version) and the events
 * before it, latest first.
 */
async function loadOrder(db: Db, gameId: string, eventId: string) {
  const rows = await db
    .select({
      eventId: gameEvents.eventId,
      sequence: gameEvents.sequence,
      status: gameEvents.status,
      pricesReadyAt: gameEvents.pricesReadyAt,
      lockAt: events.lockAt,
      eventStatus: events.status,
      params: rulesetVersions.params,
    })
    .from(gameEvents)
    .innerJoin(events, eq(events.id, gameEvents.eventId))
    .innerJoin(
      rulesetVersions,
      eq(rulesetVersions.id, gameEvents.rulesetVersionId),
    )
    .where(eq(gameEvents.gameId, gameId));
  const own = rows.find((row) => row.eventId === eventId);
  if (!own) throw new Error(`game ${gameId} has no event ${eventId}`);
  const before =
    own.sequence === null
      ? []
      : rows
          .filter(
            (row) => row.sequence !== null && row.sequence < own.sequence!,
          )
          .sort((a, b) => b.sequence! - a.sequence!);
  const { window } = rulesetParamsSchema.parse(own.params);
  return { own, before, window };
}

/**
 * The handlers for `game_lock` and `game_open`. `batch` is the number of teams
 * a lock job writes (`lockEvent`'s default, about 1,000, when absent).
 *
 * - **`game_lock`** puts itself off (a new job under a `…:wait:<n>` key, since
 *   its own key is running) when `lock_at` has moved later, when an earlier
 *   event hasn't locked yet (a few minutes) or when the event isn't open yet
 *   (its open job is on the way; it looks again every `window.recheckHours`). Otherwise it runs one `lockEvent` batch and
 *   queues `…:after:<lastTeamId>` until the event is locked.
 * - **`game_open`** opens an `upcoming` event once the event before it has
 *   locked, and either that event is `completed` or the event's own lock is
 *   less than the ruleset's `window.openCutoffHours` away (24 in 2026). Prices
 *   are carried when none were published, then the event is `open`, in one
 *   transaction. Until then it re-checks every `window.recheckHours` (6)
 *   under `…:<n>`.
 *
 * Every job that puts itself off carries its counter on (`wait`, `attempt`),
 * so a key it enqueues is never one an earlier job of the chain used.
 *
 * Both check the order before they write, so the database's guard on opening
 * out of order never reaches the job runtime.
 */
export function createGameHandlers(
  options: { batch?: number } = {},
): Record<"game_lock" | "game_open", JobHandler> {
  const lock: JobHandler = async (job, ctx) => {
    const db = ctx.db as Db;
    const { gameId, eventId, afterTeamId, wait } = gameLockPayload.parse(
      job.payload,
    );
    const now = ctx.clock.now();
    const { own, before, window } = await loadOrder(db, gameId, eventId);
    if (own.status === "cancelled" || isLockedOrLater(own.status)) return;

    const putOff = async (runAt: Date) => {
      const n = (wait ?? 0) + 1;
      const payload: GameLockPayload = {
        gameId,
        eventId,
        afterTeamId,
        wait: n,
      };
      await enqueue(db, {
        kind: "game_lock",
        dedupeKey: gameLockWaitKey(gameId, eventId, n),
        runAt,
        payload,
      });
    };
    if (now.getTime() < own.lockAt.getTime()) {
      return putOff(own.lockAt);
    }
    if (
      before.some(
        (row) => !isLockedOrLater(row.status) && row.status !== "cancelled",
      )
    ) {
      return putOff(new Date(now.getTime() + LOCK_WAIT_MS));
    }
    if (own.status !== "open") {
      return putOff(new Date(now.getTime() + window.recheckHours * HOUR_MS));
    }

    const batch = await lockEvent(db, now, {
      gameId,
      eventId,
      afterTeamId,
      limit: options.batch,
    });
    if (!batch.done) {
      if (batch.lastTeamId === null) {
        throw new Error(
          `game_lock: ${eventId} is not done and has no last team`,
        );
      }
      // `wait` goes on, so a later wait key can't repeat one already used.
      const payload: GameLockPayload = {
        gameId,
        eventId,
        afterTeamId: batch.lastTeamId,
        wait,
      };
      await enqueue(db, {
        kind: "game_lock",
        dedupeKey: gameLockAfterKey(gameId, eventId, batch.lastTeamId),
        runAt: now,
        payload,
      });
    }
  };

  const open: JobHandler = async (job, ctx) => {
    const db = ctx.db as Db;
    const { gameId, eventId, attempt } = gameOpenPayload.parse(job.payload);
    const now = ctx.clock.now();
    const { own, before, window } = await loadOrder(db, gameId, eventId);
    // Opened already (or locked, or cancelled), and the first event is opened
    // with the game (`openGame`).
    const previous = before.find((row) => row.status !== "cancelled");
    if (own.status !== "upcoming" || !previous) return;

    const recheck = async () => {
      const n = (attempt ?? 0) + 1;
      const payload: GameOpenPayload = { gameId, eventId, attempt: n };
      await enqueue(db, {
        kind: "game_open",
        dedupeKey: gameOpenRecheckKey(gameId, eventId, n),
        runAt: new Date(now.getTime() + window.recheckHours * HOUR_MS),
        payload,
      });
    };
    const locked = before.every(
      (row) => row.status === "cancelled" || isLockedOrLater(row.status),
    );
    const due =
      previous.eventStatus === "completed" ||
      now.getTime() >= own.lockAt.getTime() - window.openCutoffHours * HOUR_MS;
    if (!locked || !due) return recheck();

    await db.transaction(async (tx) => {
      // The prices are the list the lineups are checked against: carried from
      // the last event when none were published (M4 publishes the formula's
      // before this runs).
      if (own.pricesReadyAt === null) {
        await carryPrices(tx, now, { gameId, eventId });
      }
      await tx
        .update(gameEvents)
        .set({ status: "open", updatedAt: now })
        .where(
          and(
            eq(gameEvents.gameId, gameId),
            eq(gameEvents.eventId, eventId),
            eq(gameEvents.status, "upcoming"),
          ),
        );
    });
  };

  return { game_lock: lock, game_open: open };
}
