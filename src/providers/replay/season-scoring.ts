/**
 * The 2026 season scored (M4 Task 10, the M4 exit): the real season on a
 * simulated clock through the whole pipeline, for the teams of a script.
 * Results arrive through the poll, events finish through `finalize_check`,
 * scoring runs through `score_session` and `game_finalize`, and the game locks
 * and opens on its own jobs. The script's `resultsIn` and `completeEvent`
 * stand-ins, which the M3 replay needs, are skipped here.
 *
 * Wired like `replayWeekend` (harness.ts) over `createReplayFetch`, with the
 * script's moves as the clock loop's actions, as in `replaySeasonGame`.
 */
import {
  and,
  asc,
  count,
  eq,
  inArray,
  isNotNull,
  lte,
  max,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import {
  events,
  gameEvents,
  jobs,
  priceUpdateRuns,
  scoringRuns,
  sessions,
  sessionResultState,
  teamEventTotals,
} from "@/db/schema";
import { checkGameInvariants } from "@/game/invariants";
import { createGameHandlers, planGameJobs } from "@/game/jobs";
import { openGame } from "@/game/lineups";
import { checkScoringInvariants } from "@/game/scoring-invariants";
import { publishDueTimes } from "@/jobs/due-times";
import { scoreSessionPayload } from "@/jobs/kinds";
import { planEventJobs } from "@/jobs/plan-event";
import type { TickDb, TickDeps } from "@/jobs/tick";
import { fixedClock, virtualTimer, type Clock } from "@/lib/clock";
import { runReplayClock, setSimulatedClock } from "@/replay/clock-loop";
import {
  applyGameAction,
  newGameScriptRun,
  type GameScript,
} from "@/replay/game-script";
import type { Injection } from "@/replay/injections";
import { SCORED_KINDS } from "@/results/validate";
import { createPipelineHandlers } from "../pipeline";
import { createPipelineClients } from "../pipeline/clients";
import { createReplayFetch, type ReplaySession } from "./fixture-fetch";
import { memoryStore, type SeededGame } from "./season-game";

const SEASON = 2026;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
/** The window opens this long before round 1's lock... */
const BEFORE_FIRST_LOCK_MS = 24 * HOUR_MS;
/** ...and closes an hour after the last round's +48 h finalize. */
const AFTER_LAST_RACE_MS = 49 * HOUR_MS;
const PUBLISH_DELAY_MS = 30 * MINUTE_MS;

/** The script's stand-ins for the pipeline, which here is the real one. */
const STAND_INS = new Set(["resultsIn", "completeEvent"]);

/** A seeded game that also resolves the drivers and constructors staff name. */
export interface SeededScoringGame extends SeededGame {
  driverId: (key: string) => Promise<string>;
  constructorId: (key: string) => Promise<string>;
}

export interface SeasonScoringOptions {
  seed: (db: TickDb) => Promise<SeededScoringGame>;
  /** The root that holds `jolpica/`, `openf1/` and `seats-2026.json`. */
  fixturesDir: string;
  /** The replay stops after this round's +48 h finalize. */
  throughRound: number;
  injections?: Injection[];
  /**
   * Anything else done at a given instant (a test's league, a snapshot). Runs
   * like a script move, with the clock there.
   */
  actions?: Array<{
    at: string;
    run: (now: Date, ctx: { gameId: string }) => Promise<void>;
  }>;
}

export interface SeasonScoringReport {
  /** Game events that ended `final`. */
  eventsFinal: number;
  /** Sessions with a current run. */
  sessionsScored: number;
  /** Live runs that succeeded. */
  runs: number;
  /** Times a run was asked for and its inputs matched the current run's. */
  skippedRuns: number;
  /** Price updates written, one per event but the last. */
  priceUpdates: number;
  /** Each team's running total at the end, by its label. */
  totals: Record<string, number>;
  /** `checkGameInvariants` and `checkScoringInvariants`; empty when both held. */
  violations: string[];
}

/**
 * Replays the season into `db` (an empty, migrated database) through
 * `throughRound`, and reports how it ended.
 *
 * Setup, as `replaySeasonGame` has it: `seed` imports the reference data and
 * seeds the game; the clock is set to 24 hours before round 1's lock, where
 * the game opens. Then the pipeline's jobs are planned for each round through
 * `throughRound`, and the due-times file is published.
 *
 * `runReplayClock` (`jump`) runs to an hour after that round's +48 h finalize,
 * with every handler real, the calendar sync included. Each round's results
 * appear half an hour after its session's scheduled end and stay the same,
 * unless `injections` change them. A cancelled round's jobs do nothing, so
 * its recorded results are never read.
 *
 * A move that fails, or a job that fails, throws: the replay stops there.
 */
export async function replaySeasonScoring(
  db: TickDb,
  script: GameScript,
  options: SeasonScoringOptions,
): Promise<SeasonScoringReport> {
  const { fixturesDir, throughRound } = options;

  // --- Setup ---------------------------------------------------------------
  const seeded = await options.seed(db);
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
    .where(eq(gameEvents.gameId, gameId))
    .orderBy(asc(events.round));
  const first = calendar.find((e) => e.sequence === 1);
  if (!first) throw new Error(`replay: game ${gameId} has no first event`);
  const replayed = calendar.filter((e) => e.round <= throughRound);

  const [last] = await db
    .select({ end: max(sessions.scheduledEnd) })
    .from(sessions)
    .innerJoin(events, eq(events.id, sessions.eventId))
    .where(and(lte(events.round, throughRound), eq(sessions.kind, "race")));
  if (!last?.end) throw new Error(`replay: no race through ${throughRound}`);
  const from = new Date(first.lockAt.getTime() - BEFORE_FIRST_LOCK_MS);
  const until = new Date(
    Math.ceil((last.end.getTime() + AFTER_LAST_RACE_MS) / MINUTE_MS) *
      MINUTE_MS,
  );

  await setSimulatedClock(db, from);
  await openGame(db, from, gameId);
  await planGameJobs(db, from, gameId);
  for (const { eventId } of replayed) await planEventJobs(db, eventId);
  const store = memoryStore();
  await publishDueTimes(db, store, from);

  // --- Providers: the real clients over the recorded fixtures --------------
  const served = await db
    .select({
      round: events.round,
      kind: sessions.kind,
      scheduledEnd: sessions.scheduledEnd,
    })
    .from(sessions)
    .innerJoin(events, eq(events.id, sessions.eventId))
    .where(
      and(
        lte(events.round, throughRound),
        ne(sessions.status, "cancelled"),
        inArray(sessions.kind, [...SCORED_KINDS]),
      ),
    );
  const rounds = new Map<number, ReplaySession[]>();
  for (const { round, ...session } of served) {
    rounds.set(round, [...(rounds.get(round) ?? []), session]);
  }
  let tickClock: Clock = fixedClock(from);
  const replayFetch = createReplayFetch({
    fixturesDir,
    season: SEASON,
    rounds,
    now: () => tickClock.now(),
    publishDelayMs: PUBLISH_DELAY_MS,
    injections: options.injections ?? [],
  });

  // --- The script ----------------------------------------------------------
  const eventOfRound = new Map(calendar.map((e) => [e.round, e.eventId]));
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
      const eventId = eventOfRound.get(round);
      if (!eventId) throw new Error(`replay: no round ${round}`);
      return eventId;
    },
    driverId: seeded.driverId,
    constructorId: seeded.constructorId,
  });
  const moves = script.actions
    .filter((action) => !STAND_INS.has(action.kind))
    .map((action) => ({
      at: new Date(action.at),
      run: async (now: Date) => {
        await applyGameAction(db, now, run, action);
        await publishDueTimes(db, store, now);
      },
    }));
  const extras = (options.actions ?? []).map((action) => ({
    at: new Date(action.at),
    run: async (now: Date) => {
      await action.run(now, { gameId });
      await publishDueTimes(db, store, now);
    },
  }));

  // --- The season ----------------------------------------------------------
  const deps: TickDeps = {
    db: () => db,
    store,
    // Built inside each wake, on that tick's database and clock, as in
    // production and in `replayWeekend`.
    handlers: async (tickDb, clock) => {
      tickClock = clock;
      return {
        ...createPipelineHandlers(
          await createPipelineClients({
            db: tickDb,
            clock,
            timer: virtualTimer(clock),
            fetch: replayFetch,
          }),
        ),
        ...createGameHandlers(),
      };
    },
    mode: "replay",
  };
  await runReplayClock({
    db,
    deps,
    from,
    until,
    step: "jump",
    actions: [...moves, ...extras],
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
  // Read before the checks, though the forced re-score leaves no trace.
  const [final] = await db
    .select({ n: count() })
    .from(gameEvents)
    .where(and(eq(gameEvents.gameId, gameId), eq(gameEvents.status, "final")));
  const [scored] = await db
    .select({ n: count() })
    .from(scoringRuns)
    .where(
      and(eq(scoringRuns.gameId, gameId), eq(scoringRuns.isCurrent, true)),
    );
  const [runs] = await db
    .select({ n: count() })
    .from(scoringRuns)
    .where(
      and(
        eq(scoringRuns.gameId, gameId),
        eq(scoringRuns.mode, "live"),
        eq(scoringRuns.status, "succeeded"),
      ),
    );
  const [updates] = await db
    .select({ n: count() })
    .from(priceUpdateRuns)
    .where(eq(priceUpdateRuns.gameId, gameId));

  const totals: Record<string, number> = {};
  const labels = new Map([...run.teams].map(([label, id]) => [id, label]));
  const rows = await db
    .select({
      teamId: teamEventTotals.teamId,
      cumulative: teamEventTotals.cumulativePoints,
    })
    .from(teamEventTotals)
    .where(eq(teamEventTotals.gameId, gameId))
    .orderBy(asc(teamEventTotals.eventSequence));
  for (const row of rows) totals[labels.get(row.teamId)!] = row.cumulative;

  return {
    eventsFinal: final!.n,
    sessionsScored: scored!.n,
    runs: runs!.n,
    skippedRuns: await countSkippedRuns(db, gameId),
    priceUpdates: updates!.n,
    totals,
    violations: [
      ...(await checkGameInvariants(db, gameId)),
      ...(await checkScoringInvariants(db, gameId, { now: until })),
    ],
  };
}

/**
 * A skipped run leaves no row, so this works them out from what ran. Each
 * `score_session` `assets` job either started a run, which queued that run's
 * `teams` job, or skipped; every other live run is one `game_finalize` ran
 * inline, and it asks once for each session with results in a final event.
 */
async function countSkippedRuns(db: TickDb, gameId: string): Promise<number> {
  const scoreJobs = await db
    .select({ payload: jobs.payload })
    .from(jobs)
    .where(and(eq(jobs.kind, "score_session"), eq(jobs.status, "succeeded")));
  const steps = scoreJobs
    .map((job) => scoreSessionPayload.parse(job.payload))
    .filter((payload) => payload.gameId === gameId);
  const assetJobs = steps.filter((p) => p.step === "assets").length;
  const jobRuns = new Set(
    steps.filter((p) => p.step === "teams").map((p) => p.runId),
  ).size;

  const [live] = await db
    .select({ n: count() })
    .from(scoringRuns)
    .where(and(eq(scoringRuns.gameId, gameId), eq(scoringRuns.mode, "live")));
  const [asked] = await db
    .select({ n: count() })
    .from(sessions)
    .innerJoin(
      gameEvents,
      and(
        eq(gameEvents.eventId, sessions.eventId),
        eq(gameEvents.gameId, gameId),
      ),
    )
    .innerJoin(
      sessionResultState,
      eq(sessionResultState.sessionId, sessions.id),
    )
    .where(
      and(
        eq(gameEvents.status, "final"),
        inArray(sessions.kind, [...SCORED_KINDS]),
        ne(sessions.status, "cancelled"),
        sql`${sessionResultState.status} in ('provisional', 'final')`,
      ),
    );
  const inlineRuns = live!.n - jobRuns;
  return assetJobs - jobRuns + (asked!.n - inlineRuns);
}
