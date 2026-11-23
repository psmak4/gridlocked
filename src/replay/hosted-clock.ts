/**
 * The replay clock for a hosted beta (M9 Task 5). On a replay database the
 * clock is `simulated_clock`, which the replay harness moves from a test
 * loop. A hosted replay moves by itself instead: the `replay_offset` setting
 * makes the replay's instant real time minus the offset, so a 2026 weekend
 * plays out over a real one, and staff can pause it or jump it forward.
 *
 * - The instant never moves back. `simulated_clock` is its floor: each tick
 *   moves it forward to the instant it runs on, and each offset change first
 *   holds it where the replay stands (`setSetting`). app_now() reads the
 *   same two rows, so pages and jobs agree.
 * - A jump stops one minute before the next lock it would pass, so a lock
 *   (and everything planned before it) still happens in order.
 * - The tick doesn't open the database to learn the instant: the due-times
 *   file carries the floor and the offset (`DueFile.replay`), and only a tick
 *   that wakes writes the clock.
 *
 * Nothing here reads the time: the real instant comes from the caller.
 */
import { and, gt, lte, min, ne } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { events } from "@/db/schema";
import type { Db } from "@/db/types";
import type { DueReplay } from "@/jobs/due-times";
import {
  ClockModeError,
  holdSimulatedClock,
  simulatedClockAt,
  type ClockDb,
} from "@/lib/resolve-clock";
import { getSetting, type SettingValue } from "@/settings";
import { setSetting } from "@/settings/write";
import { StaffError } from "@/staff/errors";
import type { StaffActor } from "@/staff/roster";

export type ReplayOffset = SettingValue<"replay_offset">;

const MINUTE_MS = 60_000;

/** The replay's instant: paused, the floor; running, real time minus the offset, never before the floor. */
export function replayInstant(
  offset: ReplayOffset,
  floor: Date,
  realNow: Date,
): Date {
  if (offset.mode === "paused") return floor;
  return new Date(
    Math.max(floor.getTime(), realNow.getTime() - offset.seconds * 1000),
  );
}

/** The same, from what the due-times file carries. */
export function fileInstant(replay: DueReplay, realNow: Date): Date {
  const floor = new Date(replay.floor);
  return replay.seconds === null
    ? floor
    : replayInstant(
        { mode: "running", seconds: replay.seconds },
        floor,
        realNow,
      );
}

/**
 * The instant a tick at `realNow` runs on, written to `simulated_clock` when
 * it moved. Throws ClockModeError on a database with a real clock.
 */
export async function hostedReplayNow(
  db: Db & ClockDb,
  realNow: Date,
): Promise<Date> {
  const floor = await simulatedClockAt(db);
  if (!floor) {
    throw new ClockModeError(
      "CLOCK_MODE is replay but simulated_clock is not set",
    );
  }
  const at = replayInstant(
    await getSetting(db, "replay_offset"),
    floor,
    realNow,
  );
  if (at.getTime() > floor.getTime()) await holdSimulatedClock(db, at);
  return at;
}

type Move<T> = (
  t: Db,
  state: { at: Date; offset: ReplayOffset; realNow: Date },
) => Promise<T>;

/** One offset change: the key's lock, then where the replay stands. */
function moveReplay<T>(db: Db, realNow: Date, move: Move<T>): Promise<T> {
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    await t.execute(
      sql`select pg_advisory_xact_lock(hashtext(${"setting:replay_offset"}))`,
    );
    const floor = await simulatedClockAt(t as Db & ClockDb);
    if (!floor) throw new StaffError("not_replay");
    const offset = await getSetting(t, "replay_offset");
    return move(t, {
      at: replayInstant(offset, floor, realNow),
      offset,
      realNow,
    });
  });
}

/** Whole seconds that put the replay's instant at `at` when it is `realNow`, or just before it. */
const secondsFor = (realNow: Date, at: Date) =>
  Math.ceil((realNow.getTime() - at.getTime()) / 1000);

/** Stops the clock where it stands. Gives back that instant. */
export function pauseReplay(
  db: Db,
  realNow: Date,
  actor: StaffActor,
  input: { reason: string },
): Promise<Date> {
  return moveReplay(db, realNow, async (t, { at, offset }) => {
    if (offset.mode === "paused") return at;
    await setSetting(t, at, actor, {
      key: "replay_offset",
      value: { mode: "paused", at: at.toISOString() },
      reason: input.reason,
    });
    return at;
  });
}

/** Starts the clock again from where it stopped. Gives back that instant. */
export function resumeReplay(
  db: Db,
  realNow: Date,
  actor: StaffActor,
  input: { reason: string },
): Promise<Date> {
  return moveReplay(db, realNow, async (t, { at, offset }) => {
    if (offset.mode === "running") return at;
    await setSetting(t, at, actor, {
      key: "replay_offset",
      value: { mode: "running", seconds: secondsFor(realNow, at) },
      reason: input.reason,
    });
    return at;
  });
}

export type JumpResult = {
  /** `jumped_to_lock`: a lock came first, so it stopped a minute before it. */
  status: "jumped" | "jumped_to_lock";
  at: Date;
};

/**
 * Moves the clock forward to `to`, or to one minute before the first lock
 * of an event that isn't cancelled on the way. Paused, it stays paused there.
 * Refused: `to` at or before where it stands (`clock_backwards`).
 */
export function jumpReplay(
  db: Db,
  realNow: Date,
  actor: StaffActor,
  input: { to: Date; reason: string },
): Promise<JumpResult> {
  return moveReplay(db, realNow, async (t, { at, offset }) => {
    if (input.to.getTime() <= at.getTime()) {
      throw new StaffError("clock_backwards");
    }
    const [next] = await t
      .select({ lockAt: min(events.lockAt) })
      .from(events)
      .where(
        and(
          gt(events.lockAt, at),
          lte(events.lockAt, input.to),
          ne(events.status, "cancelled"),
        ),
      );
    const lockAt = next?.lockAt ?? null;
    const land = lockAt
      ? new Date(Math.max(at.getTime(), lockAt.getTime() - MINUTE_MS))
      : input.to;
    await setSetting(t, land, actor, {
      key: "replay_offset",
      value:
        offset.mode === "paused"
          ? { mode: "paused", at: land.toISOString() }
          : { mode: "running", seconds: secondsFor(realNow, land) },
      reason: input.reason,
    });
    return { status: lockAt ? "jumped_to_lock" : "jumped", at: land };
  });
}
