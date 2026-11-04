import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
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
  gameFinalizeSweepKey,
  gameLockAfterKey,
  gameLockKey,
  gameLockPayload,
  gameLockSweepKey,
  gameLockWaitKey,
  gameOpenKey,
  gameOpenPayload,
  gameOpenRecheckKey,
  gameOpenSweepKey,
  type GameFinalizePayload,
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
export const LOCKED_OR_LATER = ["locked", "scored", "final"] as const;
export const isLockedOrLater = (status: GameEventStatus) =>
  (LOCKED_OR_LATER as readonly GameEventStatus[]).includes(status);

/**
 * Writes a game's calendar-driven jobs as `pending` rows with future `run_at`
 * (DM 2.10), all through `enqueue` so planning again only moves them:
 * - `game_lock:<game>:<event>` at `lock_at` for every `upcoming` or `open`
 *   event;
 * - `game_open:<game>:<event>` for every `upcoming` event after the first, at
 *   the end of the previous event's race plus the largest `finalizer_checks`
 *   delay, when that event has been finalized or is about to be;
 * - `game_lock:<game>:<event>:sweep:<yyyy-mm-dd>` (the UTC day of `now`), due
 *   at `now`, for an `open` event whose `lock_at` has passed and that has no
 *   `game_lock` job pending, running or waiting to retry: its lock chain died
 *   (a job dead after its last attempt is never re-queued under its own key).
 *   The sweep is an ordinary lock job, so it picks the lock up where it was;
 * - `game_open:<game>:<event>:sweep:<yyyy-mm-dd>` likewise, due at `now`, for
 *   an `upcoming` event whose planned open time has passed and that has no
 *   `game_open` job pending, running or waiting to retry. It is an ordinary
 *   open job, so its order and timing checks are the same;
 * - `game_finalize:<game>:<event>:sweep:<yyyy-mm-dd>` likewise, due at `now`,
 *   for a `locked` or `scored` game event whose event is `completed` and that
 *   has no `game_finalize` job pending, running or waiting to retry: its job
 *   died, or it locked after its event completed, so it never had one. It is
 *   an ordinary finalize job, and a retry of one that committed does nothing.
 *
 * An event that is `final`, or cancelled, gets nothing, nor does one that has
 * locked and whose event isn't `completed`. Call it whenever the calendar is
 * synced, which the daily `sync_calendar` job does for every game of its
 * season.
 */
export async function planGameJobs(
  db: Db,
  now: Date,
  gameId: string,
): Promise<void> {
  const calendar = await db
    .select({
      eventId: gameEvents.eventId,
      status: gameEvents.status,
      lockAt: events.lockAt,
      eventStatus: events.status,
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
      // Finished with no finalize job left alive (the last one died, or it
      // locked after its event completed): a sweep runs the finalize, once a
      // day at most.
      if (
        (event.status === "locked" || event.status === "scored") &&
        event.eventStatus === "completed"
      ) {
        const [alive] = await tx
          .select({ id: jobs.id })
          .from(jobs)
          .where(
            and(
              eq(jobs.kind, "game_finalize"),
              sql`${jobs.payload}->>'gameId' = ${gameId}`,
              sql`${jobs.payload}->>'eventId' = ${event.eventId}`,
              inArray(jobs.status, ["pending", "running", "failed"]),
            ),
          )
          .limit(1);
        if (!alive) {
          const day = now.toISOString().slice(0, 10);
          const payload: GameFinalizePayload = {
            gameId,
            eventId: event.eventId,
            sweep: day,
          };
          await enqueue(tx, {
            kind: "game_finalize",
            dedupeKey: gameFinalizeSweepKey(gameId, event.eventId, day),
            runAt: now,
            payload,
          });
        }
      }
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
      const ofThisLock = [
        eq(jobs.kind, "game_lock"),
        sql`${jobs.payload}->>'gameId' = ${gameId}`,
        sql`${jobs.payload}->>'eventId' = ${event.eventId}`,
      ];
      await tx
        .update(jobs)
        .set({ runAt: event.lockAt })
        .where(and(...ofThisLock, eq(jobs.status, "pending")));

      // An open event past its lock with no lock job left alive (the last
      // one died): a sweep runs the lock handler again, once a day at most.
      if (event.status === "open" && event.lockAt.getTime() <= now.getTime()) {
        const [alive] = await tx
          .select({ id: jobs.id })
          .from(jobs)
          .where(
            and(
              ...ofThisLock,
              inArray(jobs.status, ["pending", "running", "failed"]),
            ),
          )
          .limit(1);
        if (!alive) {
          const day = now.toISOString().slice(0, 10);
          const payload: GameLockPayload = {
            gameId,
            eventId: event.eventId,
            sweep: day,
          };
          await enqueue(tx, {
            kind: "game_lock",
            dedupeKey: gameLockSweepKey(gameId, event.eventId, day),
            runAt: now,
            payload,
          });
        }
      }

      const previous = calendar[i - 1];
      if (event.status !== "upcoming" || !previous) continue;
      const weekend = ends.get(previous.eventId);
      const over = weekend?.race ?? weekend?.any ?? previous.lockAt.getTime();
      const opensAt = new Date(over + settleMs);
      const open: GameOpenPayload = { gameId, eventId: event.eventId };
      await enqueue(tx, {
        kind: "game_open",
        dedupeKey: gameOpenKey(gameId, event.eventId),
        runAt: opensAt,
        payload: open,
      });

      // Past its planned open with no open job left alive (the last one
      // died): a sweep runs the open handler again, once a day at most.
      if (opensAt.getTime() <= now.getTime()) {
        const [alive] = await tx
          .select({ id: jobs.id })
          .from(jobs)
          .where(
            and(
              eq(jobs.kind, "game_open"),
              sql`${jobs.payload}->>'gameId' = ${gameId}`,
              sql`${jobs.payload}->>'eventId' = ${event.eventId}`,
              inArray(jobs.status, ["pending", "running", "failed"]),
            ),
          )
          .limit(1);
        if (!alive) {
          const day = now.toISOString().slice(0, 10);
          const payload: GameOpenPayload = {
            gameId,
            eventId: event.eventId,
            sweep: day,
          };
          await enqueue(tx, {
            kind: "game_open",
            dedupeKey: gameOpenSweepKey(gameId, event.eventId, day),
            runAt: now,
            payload,
          });
        }
      }
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
      lockAt: events.lockAt,
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
 *   locked, and either that game event is `final`, so its formula prices are
 *   written, or the event's own lock is less than the ruleset's
 *   `window.openCutoffHours` away (24 in 2026). Prices are carried for every
 *   asset that has none (`carryPrices`), then the event is `open`, in one
 *   transaction. Until then it re-checks every `window.recheckHours` (6) under
 *   `…:<n>`. `finalizeGameEvent` also queues one as soon as the event before is
 *   `final`, under `…:final`, so the window needn't wait for a re-check.
 *
 * Every job that puts itself off carries its counter on (`wait`, `attempt`),
 * so a key it enqueues is never one an earlier job of the chain used. A lock
 * sweep's chain carries its day on (`sweep`), so its keys are never the dead
 * chain's either; it starts again from the first team, and a batch already
 * written writes nothing. An open sweep's re-checks carry its day the same
 * way.
 *
 * Both check the order before they write, so the database's guard on opening
 * out of order never reaches the job runtime.
 */
export function createGameHandlers(
  options: { batch?: number } = {},
): Record<"game_lock" | "game_open", JobHandler> {
  const lock: JobHandler = async (job, ctx) => {
    const db = ctx.db as Db;
    const { gameId, eventId, afterTeamId, wait, sweep } = gameLockPayload.parse(
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
        sweep,
      };
      await enqueue(db, {
        kind: "game_lock",
        dedupeKey: gameLockWaitKey(gameId, eventId, n, sweep),
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
        sweep,
      };
      await enqueue(db, {
        kind: "game_lock",
        dedupeKey: gameLockAfterKey(gameId, eventId, batch.lastTeamId, sweep),
        runAt: now,
        payload,
      });
    }
  };

  const open: JobHandler = async (job, ctx) => {
    const db = ctx.db as Db;
    const { gameId, eventId, attempt, sweep } = gameOpenPayload.parse(
      job.payload,
    );
    const now = ctx.clock.now();
    const { own, before, window } = await loadOrder(db, gameId, eventId);
    // Opened already (or locked, or cancelled), and the first event is opened
    // with the game (`openGame`).
    const previous = before.find((row) => row.status !== "cancelled");
    if (own.status !== "upcoming" || !previous) return;

    const recheck = async () => {
      const n = (attempt ?? 0) + 1;
      const payload: GameOpenPayload = { gameId, eventId, attempt: n, sweep };
      await enqueue(db, {
        kind: "game_open",
        dedupeKey: gameOpenRecheckKey(gameId, eventId, n, sweep),
        runAt: new Date(now.getTime() + window.recheckHours * HOUR_MS),
        payload,
      });
    };
    const locked = before.every(
      (row) => row.status === "cancelled" || isLockedOrLater(row.status),
    );
    const due =
      previous.status === "final" ||
      now.getTime() >= own.lockAt.getTime() - window.openCutoffHours * HOUR_MS;
    if (!locked || !due) return recheck();

    await db.transaction(async (tx) => {
      // The prices are the list the lineups are checked against: carried from
      // the last event for every asset with none, even after a full list was
      // published (`finalizeGameEvent` publishes the formula's before this
      // runs), since an owned asset withdrawn since still needs one.
      await carryPrices(tx, now, { gameId, eventId });
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
