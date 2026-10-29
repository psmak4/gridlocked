/**
 * The scheduler tick (HLD §4.5, M1 result). The Neon Function entry point
 * (Task 12) calls `tick` every minute and `safetyTick` every six hours, and
 * passes the trigger's scheduled instant. Nothing here reads the time.
 */
import type { Db } from "@/db/types";
import { systemTimer, type Clock, type Timer } from "@/lib/clock";
import {
  assertClockMode,
  resolveClock,
  type ClockDb,
  type ClockMode,
} from "@/lib/resolve-clock";
import {
  decideTick,
  DUE_KEY,
  parseDueFile,
  publishDueTimes,
  type DueFile,
  type DueStore,
} from "./due-times";
import { reapExpired } from "./queue";
import { runDue, type JobHandler } from "./runner";
import { ensureCalendarSync } from "./sync-calendar";

/** A database that can run jobs (Drizzle) and the clock queries (raw SQL). */
export type TickDb = Db & ClockDb;

export type TickDeps = {
  /**
   * A factory, so a tick that sleeps never opens a connection (and never
   * wakes Postgres).
   */
  db: () => TickDb;
  store: DueStore;
  /**
   * Builds the job handlers for one wake, on the tick's own database and
   * clock (the one `resolveClock` gave `runDue`), so the provider clients,
   * the request log and the jobs' writes share one connection and one instant
   * (HLD decision 20). Called once, after the clock check and only when jobs
   * are going to run, so a sleeping tick never builds (or connects) anything.
   * May be async: building the provider clients reads settings and the
   * recent request log.
   */
  handlers: (
    db: TickDb,
    clock: Clock,
    wake: WakeBudget,
  ) => Record<string, JobHandler> | Promise<Record<string, JobHandler>>;
  /**
   * Real time, for the wake's time budget (`TickOptions.deadlineMs`). Defaults
   * to the system timer. It is not the clock: that is frozen at the scheduled
   * minute.
   */
  timer?: Timer;
  mode: ClockMode;
  /** Where a store read failure is reported. Defaults to `console.error`. */
  log?: (message: string) => void;
};

/** What a wake tells the handler factory about its time budget. */
export type WakeBudget = {
  timer: Timer;
  /** The timer's epoch ms by which the wake must be done; unset = no limit. */
  deadlineAt?: number;
};

export type TickOptions = {
  leaseMs: number;
  maxJobs: number;
  /**
   * Real-time budget for one wake: the runner claims no new job after it, and
   * the provider clients start no call and sleep no wait past it.
   */
  deadlineMs?: number;
};

/** Handlers must finish within the lease (there is no heartbeat yet). */
export const DEFAULT_TICK_OPTIONS: TickOptions = {
  leaseMs: 5 * 60_000,
  // The M1 burst of 20 jobs due in one minute ran in 246 ms.
  maxJobs: 50,
};

export type TickResult =
  | { action: "sleep" }
  | { action: "skip"; reason: "store_unreadable" }
  | { action: "republished"; reason: "missing" | "malformed"; file: DueFile }
  | {
      action: "wake";
      run: { ran: number; failed: number; lost: number };
      file: DueFile;
    };

/**
 * Reads the due-times file and decides with no database connection. A sleeping
 * tick never opens one. Otherwise:
 *
 * - `wake`: checks the clock mode once, runs the due jobs, and always
 *   republishes the file, because the jobs that ran (and the ones they
 *   enqueued) have moved the next due time.
 * - a missing or malformed file: wakes the database once and rebuilds the file
 *   from the job table (`republished`). It does not run jobs in that tick; the
 *   rebuilt file lists whatever is already due, so the next minute's tick wakes
 *   and runs them. With the safety tick only every six hours, skipping here
 *   would stall all due work, polling mid-race included, for up to six hours.
 * - the store cannot be read at all (a 5xx, the network, a timeout): it cannot
 *   be written either, so the tick logs and skips without waking anything.
 *
 * `scheduledAt` is the instant the sleep decision compares the file with, and
 * in system mode the clock the jobs run on. In replay mode the due times are
 * simulated, so the caller must pass the SIMULATED minute as `scheduledAt`
 * (the replay harness does). A real cron on a replay deployment would pass
 * real time and wake every minute while the simulated clock is behind it.
 *
 * If the clock check or the run throws, the file is left alone: it still says
 * "due", so the next tick tries again.
 */
export async function tick(
  deps: TickDeps,
  scheduledAt: Date,
  opts: TickOptions = DEFAULT_TICK_OPTIONS,
): Promise<TickResult> {
  let text: string | null;
  try {
    text = await deps.store.get(DUE_KEY);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    (deps.log ?? console.error)(`tick: cannot read ${DUE_KEY}: ${detail}`);
    return { action: "skip", reason: "store_unreadable" };
  }

  const decision = decideTick(parseDueFile(text), scheduledAt);
  if (decision.action === "sleep") return decision;

  const timer = deps.timer ?? systemTimer;
  const deadlineAt =
    opts.deadlineMs === undefined ? undefined : timer.now() + opts.deadlineMs;
  const db = deps.db();
  await assertClockMode(db, deps.mode);
  const clock = await resolveClock({ mode: deps.mode, db, scheduledAt });
  if (decision.action === "skip") {
    const file = await publishDueTimes(db, deps.store, clock.now());
    (deps.log ?? console.error)(
      `tick: republished due-times file (${decision.reason})`,
    );
    return { action: "republished", reason: decision.reason, file };
  }
  const handlers = await deps.handlers(db, clock, { timer, deadlineAt });
  const run = await runDue(db, clock, handlers, {
    maxJobs: opts.maxJobs,
    leaseMs: opts.leaseMs,
    timer,
    deadlineMs:
      deadlineAt === undefined
        ? undefined
        : Math.max(0, deadlineAt - timer.now()),
  });
  const file = await publishDueTimes(db, deps.store, clock.now());
  return { action: "wake", run, file };
}

/**
 * The backstop, every six hours (minute 7 of every sixth hour): dead-letters
 * jobs whose last attempt died, makes sure a calendar sync is pending for the
 * current season (`ensureCalendarSync`; the sync re-enqueues itself each day,
 * and this restarts a chain that was lost), then rebuilds the file from the
 * job table. It repairs a missing or malformed file and any republish a
 * caller forgot.
 */
export async function safetyTick(
  deps: Pick<TickDeps, "db" | "store" | "mode">,
  scheduledAt: Date,
): Promise<DueFile> {
  const db = deps.db();
  await assertClockMode(db, deps.mode);
  const clock = await resolveClock({ mode: deps.mode, db, scheduledAt });
  await reapExpired(db, clock.now());
  await ensureCalendarSync(db, clock.now());
  return publishDueTimes(db, deps.store, clock.now());
}
