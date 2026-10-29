/**
 * The 2026 replay harness (HLD §12, M2 Task 11b): one race weekend replayed
 * from the recorded fixtures on a simulated clock, through the real job
 * queue, the real handlers and the real scheduler tick.
 *
 * Layout: the clock loop, the injections and the report are provider-free and
 * live in `src/replay`. This file is the one place that wires them to the
 * providers (the fixture-serving fetch and `createPipelineHandlers`), so it
 * sits under `src/providers/replay`, where the provider-boundary lint rule
 * allows it.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { and, asc, eq, sql } from "drizzle-orm";
import { events, seasons, sessions } from "@/db/schema";
import { publishDueTimes, type DueStore } from "@/jobs/due-times";
import { planEventJobs } from "@/jobs/plan-event";
import type { TickDb, TickDeps } from "@/jobs/tick";
import { fixedClock, virtualTimer, type Clock } from "@/lib/clock";
import { localDate } from "@/reference/sync-event-entries";
import {
  runReplayClock,
  setSimulatedClock,
  type ReplayStep,
} from "@/replay/clock-loop";
import { applyAdminAction, type AdminAction } from "@/replay/admin";
import type { Injection } from "@/replay/injections";
import { buildReport, type ReplayReport } from "@/replay/report";
import { SCORED_KINDS } from "@/results/validate";
import { parseJolpicaCalendar } from "../jolpica/calendar";
import { importReference2026 } from "../import/import-season";
import { createPipelineHandlers } from "../pipeline";
import { createPipelineClients } from "../pipeline/clients";
import { createReplayFetch } from "./fixture-fetch";

export type { ReplayReport };

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
/** The +48 h finalize check, and an hour after it. */
const WINDOW_AFTER_RACE_MS = 49 * HOUR_MS;
const DEFAULT_PUBLISH_DELAY_MINUTES = 30;

export interface ReplayOptions {
  season: 2026;
  round: number;
  /** The root that holds `jolpica/`, `openf1/` and `seats-2026.json`. */
  fixturesDir: string;
  inject?: Injection[];
  /** What an admin does while it runs (a held session, then its resolution). */
  admin?: AdminAction[];
  /** Results appear this long after a session's scheduled end. Default 30. */
  publishDelayMinutes?: number;
  /** `jump` (default) skips minutes with nothing due; `minute` visits every one. */
  step?: ReplayStep;
  /**
   * Narrow the window (an ISO instant, whole minute). Defaults: Friday 00:00
   * local time of the weekend, and the race end plus 49 hours.
   */
  from?: string;
  until?: string;
}

/** The suffix a session's results are recorded under (`r18-results.json`). */
const FIXTURE_SUFFIX: Record<string, string> = {
  race: "results",
  sprint: "sprint",
  qualifying: "qualifying",
};

const memoryStore = (): DueStore => {
  const objects = new Map<string, string>();
  return {
    async get(key) {
      return objects.get(key) ?? null;
    },
    async put(key, body) {
      objects.set(key, body);
    },
  };
};

/** Midnight of the local date `day` in `timeZone`, as a UTC instant. */
async function localMidnight(
  db: TickDb,
  day: string,
  timeZone: string,
): Promise<Date> {
  const { rows } = await db.execute(sql`
    select to_char(
      (${day}::timestamp at time zone ${timeZone}) at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS"Z"'
    ) as at
  `);
  return new Date((rows[0] as { at: string }).at);
}

/**
 * Replays one weekend of the season into `db` (an empty, migrated database)
 * and reports how it ended.
 *
 * Setup, as production would have it before the weekend: the simulated clock
 * is set to Friday 00:00 local time at the circuit; the calendar, drivers,
 * constructors, seats and entries are loaded from the fixtures
 * (`importReference2026`; no results are imported); scored sessions that have
 * no recorded results are cancelled (the reference data's own way to say "not
 * happening", and listed in the report); the event's jobs are planned with
 * `planEventJobs`, and the due-times file is published.
 *
 * Then, for each simulated minute, the clock is written to
 * `settings.simulated_clock` and `tick` runs in replay mode with that minute
 * as `scheduledAt` (plus `safetyTick` at :07 every six hours). Provider calls
 * go through the real clients to a fetch that serves the recorded bodies as
 * time passes (see `createReplayFetch`).
 */
export async function replayWeekend(
  db: TickDb,
  opts: ReplayOptions,
): Promise<ReplayReport> {
  const { season, round, fixturesDir } = opts;

  // --- The weekend's start: Friday 00:00 where the circuit is --------------
  const calendar = parseJolpicaCalendar(
    JSON.parse(
      await readFile(join(fixturesDir, "jolpica", `${season}.json`), "utf8"),
    ),
  );
  const planned = calendar.find((e) => e.round === round);
  if (!planned) throw new Error(`replay: no round ${round} in ${season}`);
  if (!planned.circuit.timezone) {
    throw new Error(`replay: round ${round} has no circuit time zone`);
  }
  const firstStart = new Date(
    Math.min(...planned.sessions.map((s) => s.start.getTime())),
  );
  const weekendStart = await localMidnight(
    db,
    localDate(firstStart, planned.circuit.timezone),
    planned.circuit.timezone,
  );

  // --- Setup ---------------------------------------------------------------
  await setSimulatedClock(db, weekendStart);
  await importReference2026(db, fixedClock(weekendStart), fixturesDir);

  const [event] = await db
    .select({ id: events.id, seasonId: events.seasonId })
    .from(events)
    .innerJoin(seasons, eq(seasons.id, events.seasonId))
    .where(and(eq(seasons.year, season), eq(events.round, round)));
  if (!event) throw new Error(`replay: round ${round} was not imported`);
  const seasonRow = { id: event.seasonId };
  const eventSessions = await db
    .select()
    .from(sessions)
    .where(eq(sessions.eventId, event.id))
    .orderBy(asc(sessions.scheduledStart), asc(sessions.sequence));

  const recorded = (kind: string) =>
    existsSync(
      join(
        fixturesDir,
        "jolpica",
        String(season),
        `r${String(round).padStart(2, "0")}-${FIXTURE_SUFFIX[kind]}.json`,
      ),
    );
  const scored = eventSessions.filter(
    (s) => SCORED_KINDS.includes(s.kind) && s.status !== "cancelled",
  );
  const cancelledSessions: string[] = [];
  for (const s of scored.filter((s) => !recorded(s.kind))) {
    await db
      .update(sessions)
      .set({ status: "cancelled", updatedAt: weekendStart })
      .where(eq(sessions.id, s.id));
    cancelledSessions.push(s.kind);
  }
  const running = scored.filter((s) => recorded(s.kind));

  await planEventJobs(db, event.id);
  const store = memoryStore();
  await publishDueTimes(db, store, weekendStart);

  // --- The window ----------------------------------------------------------
  const raceEnd = Math.max(
    ...eventSessions
      .filter((s) => s.kind === "race")
      .map((s) => s.scheduledEnd.getTime()),
  );
  const from = opts.from ? new Date(opts.from) : weekendStart;
  const until = opts.until
    ? new Date(opts.until)
    : new Date(raceEnd + WINDOW_AFTER_RACE_MS);
  if (from.getTime() < weekendStart.getTime()) {
    throw new Error("replay: `from` is before the weekend starts");
  }

  // --- Providers: the real clients over the recorded fixtures --------------
  // The handlers are built inside each wake, on that tick's database and
  // clock, as in production. The fetch is built once and reads the clock of
  // the tick that is running.
  let tickClock: Clock = fixedClock(from);
  const replayFetch = createReplayFetch({
    fixturesDir,
    season,
    round,
    now: () => tickClock.now(),
    sessions: running.map((s) => ({
      kind: s.kind,
      scheduledEnd: s.scheduledEnd,
    })),
    publishDelayMs:
      (opts.publishDelayMinutes ?? DEFAULT_PUBLISH_DELAY_MINUTES) * MINUTE_MS,
    injections: opts.inject ?? [],
  });

  const deps: TickDeps = {
    db: () => db,
    store,
    // The configured provider limits apply here too. Time inside a tick
    // stands still, so a limiter that has to wait sleeps on a virtual timer,
    // which moves forward without waiting.
    handlers: async (tickDb, clock) => {
      tickClock = clock;
      return createPipelineHandlers(
        await createPipelineClients({
          db: tickDb,
          clock,
          timer: virtualTimer(clock),
          fetch: replayFetch,
        }),
      );
    },
    mode: "replay",
  };
  const loop = await runReplayClock({
    db,
    deps,
    from,
    until,
    step: opts.step ?? "jump",
    actions: (opts.admin ?? []).map((action) => {
      const session = eventSessions.find((s) => s.kind === action.session);
      if (!session) {
        throw new Error(`replay: the event has no ${action.session} session`);
      }
      return {
        at: new Date(action.at),
        run: (now: Date) =>
          applyAdminAction(
            db,
            now,
            {
              seasonId: seasonRow.id,
              eventId: event.id,
              sessionId: session.id,
            },
            action,
          ),
      };
    }),
  });

  return buildReport(db, event.id, {
    wakeTicks: loop.wakeTicks,
    cancelledSessions,
  });
}
