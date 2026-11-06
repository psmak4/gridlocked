/**
 * The 2026 season replay of the game rules (M3 Task 9, the M3 exit): the whole
 * season on a simulated clock, with the game's lock and open jobs on the real
 * scheduler tick, for the teams of a script. It checks the rules over what the
 * season left (`checkGameInvariants`).
 *
 * Wired like `replayWeekend` (harness.ts): the clock loop and the script are
 * provider-free and live in `src/replay`; this file puts them together with
 * the game's setup. The game is seeded by the caller (`seed`), which also
 * resolves the script's asset keys, since only the test helpers read provider
 * ids.
 */
import {
  and,
  count,
  eq,
  inArray,
  isNotNull,
  max,
  notInArray,
  or,
} from "drizzle-orm";
import {
  chipPlays,
  events,
  gameEvents,
  jobs,
  sessions,
  teamEventStates,
} from "@/db/schema";
import { checkGameInvariants } from "@/game/invariants";
import { planGameEvents } from "@/game/games";
import { createGameHandlers, planGameJobs } from "@/game/jobs";
import { openGame } from "@/game/lineups";
import { publishDueTimes, type DueStore } from "@/jobs/due-times";
import type { JobHandler } from "@/jobs/runner";
import type { TickDb, TickDeps } from "@/jobs/tick";
import { runReplayClock, setSimulatedClock } from "@/replay/clock-loop";
import {
  applyGameAction,
  newGameScriptRun,
  type GameScript,
} from "@/replay/game-script";

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
/** The window opens this long before round 1's lock... */
const BEFORE_FIRST_LOCK_MS = 24 * HOUR_MS;
/** ...and closes this long after the season's last race. */
const AFTER_LAST_RACE_MS = 72 * HOUR_MS;

/** A seeded game, and the pool asset each of the script's keys names. */
export interface SeededGame {
  gameId: string;
  assetId: (key: string) => Promise<string>;
}

export interface SeasonGameReport {
  /** Game events that locked: every one but the cancelled. */
  eventsLocked: number;
  eventsCancelled: number;
  /** Lock records (`team_event_states`) written. */
  states: number;
  /** Chip plays, refunded ones included. */
  chipPlays: number;
  /** The script's `expectRefused` moves, each refused as it said. */
  refused: number;
  /** `checkGameInvariants` over the season; empty when the rules held. */
  violations: string[];
}

export const memoryStore = (): DueStore => {
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

/**
 * Replays the season into `db` (an empty, migrated database) and reports how
 * it ended.
 *
 * Setup: `seed` imports the reference data and seeds the game with its
 * starting prices (`seedGame2026`); the simulated clock is set to 24 hours
 * before round 1's lock, and there the game opens (`openGame`), its jobs are
 * planned (`planGameJobs`) and the due-times file is published.
 *
 * Then `runReplayClock` (`jump`) runs to 72 hours after the last race, with
 * the script's moves as its actions, each at its `at` with the clock there.
 * Only the game's handlers run: `game_lock` and `game_open`, and for the
 * calendar sync the safety tick queues every day, the sync's part for the
 * game (`planGameEvents` then `planGameJobs`), since the calendar here
 * changes only by the script. A move may queue or move a job, so the
 * due-times file is published after each, as for an admin action.
 *
 * A move that fails, a refusal that doesn't come, or a game job that fails
 * throws: the replay stops there.
 */
export async function replaySeasonGame(
  db: TickDb,
  script: GameScript,
  setup: { seed: (db: TickDb) => Promise<SeededGame> },
): Promise<SeasonGameReport> {
  // --- Setup ---------------------------------------------------------------
  const seeded = await setup.seed(db);
  const { gameId } = seeded;
  const calendar = await db
    .select({
      eventId: gameEvents.eventId,
      sequence: gameEvents.sequence,
      round: events.round,
      lockAt: events.lockAt,
    })
    .from(gameEvents)
    .innerJoin(events, eq(events.id, gameEvents.eventId))
    .where(eq(gameEvents.gameId, gameId));
  const first = calendar.find((e) => e.sequence === 1);
  if (!first) throw new Error(`replay: game ${gameId} has no first event`);
  const [last] = await db
    .select({ end: max(sessions.scheduledEnd) })
    .from(sessions)
    .where(
      and(
        inArray(
          sessions.eventId,
          calendar.map((e) => e.eventId),
        ),
        eq(sessions.kind, "race"),
      ),
    );
  if (!last?.end) throw new Error(`replay: game ${gameId} has no race`);
  const from = new Date(first.lockAt.getTime() - BEFORE_FIRST_LOCK_MS);
  const until = new Date(
    Math.ceil((last.end.getTime() + AFTER_LAST_RACE_MS) / MINUTE_MS) *
      MINUTE_MS,
  );

  await setSimulatedClock(db, from);
  await openGame(db, from, gameId);
  await planGameJobs(db, from, gameId);
  const store = memoryStore();
  await publishDueTimes(db, store, from);

  // --- The script ----------------------------------------------------------
  const rounds = new Map(calendar.map((e) => [e.round, e.eventId]));
  const assets = new Map<string, Promise<string>>();
  const run = newGameScriptRun({
    gameId,
    assetId: (key) => {
      let id = assets.get(key);
      if (!id) {
        id = seeded.assetId(key);
        assets.set(key, id);
      }
      return id;
    },
    eventOf: (round) => {
      const eventId = rounds.get(round);
      if (!eventId) throw new Error(`replay: no round ${round}`);
      return eventId;
    },
  });

  // --- The season ----------------------------------------------------------
  const sync: JobHandler = async (_job, ctx) => {
    const now = ctx.clock.now();
    await planGameEvents(ctx.db as TickDb, now, gameId);
    await planGameJobs(ctx.db as TickDb, now, gameId);
  };
  const deps: TickDeps = {
    db: () => db,
    store,
    handlers: () => ({ ...createGameHandlers(), sync_calendar: sync }),
    mode: "replay",
  };
  await runReplayClock({
    db,
    deps,
    from,
    until,
    step: "jump",
    actions: script.actions.map((action) => ({
      at: new Date(action.at),
      run: async (now: Date) => {
        await applyGameAction(db, now, run, action);
        await publishDueTimes(db, store, now);
      },
    })),
  });

  // A job that failed once and then succeeded keeps its last error.
  const failed = await db
    .select({ key: jobs.dedupeKey, error: jobs.lastError })
    .from(jobs)
    .where(
      or(
        notInArray(jobs.status, ["succeeded", "pending"]),
        isNotNull(jobs.lastError),
      ),
    );
  if (failed.length > 0) {
    throw new Error(
      `replay: ${failed.length} jobs failed: ${failed
        .map((j) => `${j.key} (${j.error})`)
        .join("; ")}`,
    );
  }

  // --- The report ----------------------------------------------------------
  const statuses = await db
    .select({ status: gameEvents.status, n: count() })
    .from(gameEvents)
    .where(eq(gameEvents.gameId, gameId))
    .groupBy(gameEvents.status);
  const of = (wanted: string[]) =>
    statuses
      .filter((s) => wanted.includes(s.status))
      .reduce((sum, s) => sum + s.n, 0);
  const [states] = await db
    .select({ n: count() })
    .from(teamEventStates)
    .where(eq(teamEventStates.gameId, gameId));
  const [plays] = await db
    .select({ n: count() })
    .from(chipPlays)
    .where(eq(chipPlays.gameId, gameId));
  return {
    eventsLocked: of(["locked", "scored", "final"]),
    eventsCancelled: of(["cancelled"]),
    states: states!.n,
    chipPlays: plays!.n,
    refused: run.refused,
    violations: await checkGameInvariants(db, gameId),
  };
}
