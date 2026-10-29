/**
 * The replay's clock (HLD §12). Time moves by writing `settings.simulated_clock`
 * (that IS the replay clock: `resolveClock` in replay mode and `app_now()`
 * both read it), then calling the real scheduler `tick` with the simulated
 * minute as `scheduledAt`, exactly as the cron trigger would. At minute 7 of
 * every sixth hour the safety tick runs as well.
 *
 * Two ways to move:
 * - `minute`: every minute from `from` to `until`, inclusive.
 * - `jump`: the same, but straight to the next minute that has something to
 *   do: the due-times file's `next_due_at` (rounded up to a minute) or the
 *   next safety tick. A tick that finds `next_due_at` in the future only
 *   reads the file, so skipping those ticks changes nothing in the database.
 *
 * `actions` are things done to the database at a given minute (an admin
 * resolving an item): each runs once, at the first visited minute that is not
 * before its time, after the clock is written and before the tick. `jump`
 * visits that minute too.
 *
 * Nothing here reads the time, and nothing here knows a provider exists.
 */
import { sql } from "drizzle-orm";
import { DUE_KEY, parseDueFile } from "@/jobs/due-times";
import { safetyTick, tick, type TickDeps } from "@/jobs/tick";
import type { ClockDb } from "@/lib/resolve-clock";

const MINUTE_MS = 60_000;
const SAFETY_EVERY_HOURS = 6;
const SAFETY_MINUTE = 7;

export type ReplayStep = "jump" | "minute";

/** `settings.simulated_clock` = `{"at": "<ISO UTC>"}`; the row app_now() reads. */
export async function setSimulatedClock(db: ClockDb, at: Date): Promise<void> {
  const value = JSON.stringify({ at: at.toISOString() });
  await db.execute(sql`
    insert into settings (key, value, updated_at)
    values ('simulated_clock', ${value}::jsonb, ${at.toISOString()}::timestamptz)
    on conflict (key) do update
      set value = excluded.value, updated_at = excluded.updated_at
  `);
}

/** Minute 7 of hours 0, 6, 12 and 18 UTC: seven past, every sixth hour. */
export function isSafetyMinute(at: Date): boolean {
  return (
    at.getUTCMinutes() === SAFETY_MINUTE &&
    at.getUTCHours() % SAFETY_EVERY_HOURS === 0
  );
}

/** The first safety minute strictly after `after`. */
function nextSafetyMinute(after: Date): Date {
  const hour = 60 * MINUTE_MS;
  let t = Math.floor(after.getTime() / hour) * hour + SAFETY_MINUTE * MINUTE_MS;
  while (t <= after.getTime() || !isSafetyMinute(new Date(t))) t += hour;
  return new Date(t);
}

export interface ClockLoopOptions {
  /** Where `simulated_clock` is written. */
  db: ClockDb;
  /** `deps.mode` must be `replay`. */
  deps: TickDeps;
  /** First and last simulated minute, inclusive. Whole minutes. */
  from: Date;
  until: Date;
  step: ReplayStep;
  /** Called with each simulated minute before it is written, so a caller's own clock can follow. */
  onMinute?: (at: Date) => void;
  /** Run once each, at their minute (see above). Actions after `until` never run. */
  actions?: Array<{ at: Date; run: (at: Date) => Promise<void> }>;
}

export interface ClockLoopResult {
  /** Calls to `tick`. */
  ticks: number;
  /** Ticks that opened the database: a wake or a republish. */
  wakeTicks: number;
  safetyTicks: number;
}

export async function runReplayClock(
  opts: ClockLoopOptions,
): Promise<ClockLoopResult> {
  const { deps, from, until, step } = opts;
  if (deps.mode !== "replay") {
    throw new Error("runReplayClock: the tick must run in replay mode");
  }
  if (from.getTime() % MINUTE_MS !== 0 || until.getTime() % MINUTE_MS !== 0) {
    throw new Error("runReplayClock: from and until must be whole minutes");
  }

  const result: ClockLoopResult = { ticks: 0, wakeTicks: 0, safetyTicks: 0 };
  const setClock = async (at: Date) => {
    opts.onMinute?.(at);
    await setSimulatedClock(opts.db, at);
  };

  const pending = [...(opts.actions ?? [])].sort(
    (a, b) => a.at.getTime() - b.at.getTime(),
  );
  let minute = from;
  while (minute.getTime() <= until.getTime()) {
    await setClock(minute);
    while (pending.length > 0 && pending[0]!.at.getTime() <= minute.getTime()) {
      await pending.shift()!.run(minute);
    }
    const outcome = await tick(deps, minute);
    result.ticks++;
    if (outcome.action === "wake" || outcome.action === "republished") {
      result.wakeTicks++;
    }
    if (isSafetyMinute(minute)) {
      await safetyTick(deps, minute);
      result.safetyTicks++;
    }

    let next = minute.getTime() + MINUTE_MS;
    if (step === "jump") {
      const due = parseDueFile(await deps.store.get(DUE_KEY));
      const nextDue =
        due.ok && due.file.next_due_at !== null
          ? Math.ceil(Date.parse(due.file.next_due_at) / MINUTE_MS) * MINUTE_MS
          : Infinity;
      const nextAction =
        pending.length > 0
          ? Math.ceil(pending[0]!.at.getTime() / MINUTE_MS) * MINUTE_MS
          : Infinity;
      next = Math.min(
        Math.max(next, nextDue),
        nextSafetyMinute(minute).getTime(),
        Math.max(next, nextAction),
      );
    }
    minute = new Date(next);
  }

  // Both modes end with the clock at the end of the window.
  await setClock(until);
  return result;
}
