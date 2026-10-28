/**
 * The shared clock (HLD decision 20). Entry points (cron jobs, route
 * handlers) resolve "now" exactly once, then pass the resulting Clock or Date
 * down. Domain code never reads the time itself.
 *
 * - `system`: real time (or the cron trigger's scheduled instant).
 * - `replay`: the instant stored in the `simulated_clock` setting, read via
 *   the SQL function `app_now()`.
 *
 * A mismatch between the mode and the setting is a deployment error and
 * throws a ClockModeError so nothing runs against the wrong time.
 */
import { sql, type SQL } from "drizzle-orm";
import { fixedClock, systemClock, type Clock } from "./clock";

export type ClockMode = "system" | "replay";

/** Anything that can run a Drizzle `sql` query and return its rows. */
export interface ClockDb {
  execute(query: SQL): Promise<{ rows: unknown[] }>;
}

export class ClockModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClockModeError";
  }
}

export function clockModeFromEnv(
  env: Record<string, string | undefined>,
): ClockMode {
  const value = env.CLOCK_MODE;
  if (value === undefined) return "system";
  if (value === "system" || value === "replay") return value;
  throw new Error(
    `Invalid CLOCK_MODE "${value}": expected "system" or "replay"`,
  );
}

export async function assertClockMode(
  db: ClockDb,
  mode: ClockMode,
): Promise<void> {
  const { rows } = await db.execute(
    sql`select 1 from settings where key = 'simulated_clock'`,
  );
  const isSet = rows.length > 0;
  if (mode === "system" && isSet) {
    throw new ClockModeError("simulated_clock is set but CLOCK_MODE is system");
  }
  if (mode === "replay" && !isSet) {
    throw new ClockModeError(
      "CLOCK_MODE is replay but simulated_clock is not set",
    );
  }
}

export async function resolveClock(opts: {
  mode: ClockMode;
  db: ClockDb;
  scheduledAt?: Date;
}): Promise<Clock> {
  const { mode, db, scheduledAt } = opts;
  if (mode === "system") {
    return fixedClock(scheduledAt ?? systemClock.now());
  }
  await assertClockMode(db, "replay");
  // Formatted as ISO 8601 UTC in SQL so the result does not depend on how the
  // driver parses timestamptz values.
  const { rows } = await db.execute(
    sql`select to_char(app_now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as now`,
  );
  const value = (rows[0] as { now?: unknown } | undefined)?.now;
  if (typeof value !== "string") {
    throw new ClockModeError("app_now() returned no value");
  }
  return fixedClock(new Date(value));
}
