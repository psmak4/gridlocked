/**
 * The 2026 game on a simulated clock that moves when asked: the fantasy e2e
 * server's replay (M6 Task 3). It is wired as `replaySeasonScoring` is, with
 * every handler real (the pipeline over the recorded fixtures, and the
 * game's lock, open, scoring, finalize and price jobs) and the scoring
 * script's staff moves, but instead of running the season in one go,
 * `advance` runs the clock to the next instant a test asks for.
 *
 * The due-times file is kept in memory, so one `LiveReplay` belongs to one
 * process and one database.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { events, gameEvents, jobs, providerIds, sessions } from "@/db/schema";
import { createGameHandlers, planGameJobs } from "@/game/jobs";
import { openGame } from "@/game/lineups";
import { publishDueTimes } from "@/jobs/due-times";
import { planEventJobs } from "@/jobs/plan-event";
import type { TickDb, TickDeps } from "@/jobs/tick";
import { fixedClock, virtualTimer, type Clock } from "@/lib/clock";
import { runReplayClock, setSimulatedClock } from "@/replay/clock-loop";
import {
  applyGameAction,
  gameScriptSchema,
  newGameScriptRun,
  type GameAction,
} from "@/replay/game-script";
import { SCORED_KINDS } from "@/results/validate";
import { createPipelineHandlers } from "../pipeline";
import { createPipelineClients } from "../pipeline/clients";
import { createReplayFetch, type ReplaySession } from "./fixture-fetch";
import { memoryStore } from "./season-game";

const SEASON = 2026;
const MINUTE_MS = 60_000;
const PUBLISH_DELAY_MS = 30 * MINUTE_MS;

/**
 * What staff do in the scoring script (`scores-2026-script.json`): enter the
 * drivers Jolpica left out of qualifying, cancel a round, fix a price,
 * withdraw a driver, enter a substitute, patch a result. The replay does them
 * at their times, so the season plays as the M4 replay plays it. The script's
 * teams and their moves are left out: a spec makes its own.
 */
const STAFF_KINDS: ReadonlySet<GameAction["kind"]> = new Set([
  "noTimeResult",
  "cancelEvent",
  "adminPrice",
  "withdraw",
  "substitution",
  "resultPatch",
]);

export interface LiveReplay {
  /** The simulated instant the clock stands at. */
  readonly now: Date;
  /**
   * Runs the clock from where it stands to `to` (a whole minute, not before
   * it), with every job due on the way. Returns how many job runs there
   * were; a job that fails throws.
   */
  advance(to: Date): Promise<{ jobsRun: number }>;
}

const isWholeMinute = (at: Date) => at.getTime() % MINUTE_MS === 0;

/**
 * Opens the seeded game `gameId` at `at` (a whole minute, before round 1's
 * lock), plans its jobs and every round's pipeline jobs, and sets the clock
 * there.
 */
export async function startLiveReplay(
  db: TickDb,
  opts: {
    gameId: string;
    at: Date;
    fixturesDir: string;
    /** The seeded game's pool asset for a Jolpica key (`seedGame2026`). */
    assetId: (key: string) => Promise<string>;
  },
): Promise<LiveReplay> {
  const { gameId, at, fixturesDir } = opts;
  if (!isWholeMinute(at)) {
    throw new Error("startLiveReplay: `at` must be a whole minute");
  }

  await setSimulatedClock(db, at);
  await openGame(db, at, gameId);
  await planGameJobs(db, at, gameId);
  const calendar = await db
    .select({ eventId: gameEvents.eventId })
    .from(gameEvents)
    .where(eq(gameEvents.gameId, gameId));
  for (const { eventId } of calendar) await planEventJobs(db, eventId);
  const store = memoryStore();
  await publishDueTimes(db, store, at);

  // Every round's scored sessions are served, each half an hour after its
  // scheduled end, as `replaySeasonScoring` serves them.
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
        ne(sessions.status, "cancelled"),
        inArray(sessions.kind, [...SCORED_KINDS]),
      ),
    );
  const rounds = new Map<number, ReplaySession[]>();
  for (const { round, ...session } of served) {
    rounds.set(round, [...(rounds.get(round) ?? []), session]);
  }
  let tickClock: Clock = fixedClock(at);
  const replayFetch = createReplayFetch({
    fixturesDir,
    season: SEASON,
    rounds,
    now: () => tickClock.now(),
    publishDelayMs: PUBLISH_DELAY_MS,
    injections: [],
  });

  const deps: TickDeps = {
    db: () => db,
    store,
    // Built inside each wake, on that tick's database and clock, as in
    // production and in `replaySeasonScoring`.
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

  // --- The staff's moves --------------------------------------------------
  const script = gameScriptSchema.parse(
    JSON.parse(
      readFileSync(join(fixturesDir, "scores-2026-script.json"), "utf8"),
    ),
  );
  const eventOfRound = new Map(
    (
      await db
        .select({ round: events.round, eventId: gameEvents.eventId })
        .from(gameEvents)
        .innerJoin(events, eq(events.id, gameEvents.eventId))
        .where(eq(gameEvents.gameId, gameId))
    ).map((row) => [row.round, row.eventId]),
  );
  const entityId =
    (entityType: "driver" | "constructor") =>
    async (key: string): Promise<string> => {
      const [row] = await db
        .select({ id: providerIds.entityId })
        .from(providerIds)
        .where(
          and(
            eq(providerIds.provider, "jolpica"),
            eq(providerIds.entityType, entityType),
            eq(providerIds.providerKey, key),
          ),
        );
      if (!row) throw new Error(`replay: no ${entityType} ${key}`);
      return row.id;
    };
  const scriptRun = newGameScriptRun({
    gameId,
    assetId: opts.assetId,
    eventOf: (round) => {
      const eventId = eventOfRound.get(round);
      if (!eventId) throw new Error(`replay: no round ${round}`);
      return eventId;
    },
    driverId: entityId("driver"),
    constructorId: entityId("constructor"),
  });
  // In time order; each runs once, in the first `advance` that reaches it.
  const pending = script.actions
    .filter((action) => STAFF_KINDS.has(action.kind))
    .map((action) => ({ at: new Date(action.at), action }))
    .sort((a, b) => a.at.getTime() - b.at.getTime());

  // Every claim of a job adds an attempt, so the sum counts the runs.
  const attempts = async () => {
    const [row] = await db
      .select({ n: sql<string>`coalesce(sum(${jobs.attempts}), 0)` })
      .from(jobs);
    return Number(row!.n);
  };

  let now = at;
  return {
    get now() {
      return now;
    },
    async advance(to) {
      if (!isWholeMinute(to)) {
        throw new Error("advance: `to` must be a whole minute");
      }
      if (to.getTime() < now.getTime()) {
        throw new Error("advance: the clock never moves back");
      }
      const before = await attempts();
      const due = pending.filter((p) => p.at.getTime() <= to.getTime());
      pending.splice(0, due.length);
      await runReplayClock({
        db,
        deps,
        from: now,
        until: to,
        step: "jump",
        // A move may queue or move a job, so the due-times file is published
        // after each, as for an admin action.
        actions: due.map(({ at: moveAt, action }) => ({
          at: moveAt,
          run: async (moveNow: Date) => {
            await applyGameAction(db, moveNow, scriptRun, action);
            await publishDueTimes(db, store, moveNow);
          },
        })),
      });
      now = to;
      // Nothing fails on the recorded results, so a failure is a bug to see.
      const failed = await db
        .select({ key: jobs.dedupeKey, error: jobs.lastError })
        .from(jobs)
        .where(inArray(jobs.status, ["failed", "dead"]));
      if (failed.length > 0) {
        throw new Error(
          `advance: ${failed.length} jobs failed: ${failed
            .map((j) => `${j.key} (${j.error})`)
            .join("; ")}`,
        );
      }
      return { jobsRun: (await attempts()) - before };
    },
  };
}
