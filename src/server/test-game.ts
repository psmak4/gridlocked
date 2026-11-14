/**
 * Local builds only (`VITE_LOCAL_DB=1`): the fantasy e2e harness (M6 Task 3).
 * The routes `/api/test/game` and `/api/test/clock` import this file
 * dynamically behind the flag, so a deployed build never contains it.
 *
 * The fantasy e2e server is started with `CLOCK_MODE=replay`, so every request
 * reads "now" from `settings.simulated_clock`. Seeding resets the local
 * database, seeds the 2026 game from the recorded fixtures with our own
 * starting prices and opens it at the given instant; moving the clock runs the
 * real scheduler tick to a later instant, so the lock, the polls, the
 * scoring, the finalize and the price jobs run on the recorded results.
 *
 * One process has one clock, so the calls are run one at a time.
 * `test-hook-game` marks this code for the CI build check.
 *
 * It wires the replay to the providers, as the replay harness does: the one
 * file in src/server that may import src/providers (eslint.config.mjs).
 */
import path from "node:path";
import { count, eq, sql } from "drizzle-orm";
import {
  assetPrices,
  events,
  gameEvents,
  games,
  poolAssets,
  priceUpdateRuns,
  scoringRuns,
  sessions,
} from "@/db/schema";
import { resolveClock } from "@/lib/resolve-clock";
import { startLiveReplay, type LiveReplay } from "@/providers/replay/live-game";
import { seedGame2026 } from "@/providers/replay/seed-2026";
import { withDb } from "./db";
import { resetLocalDb } from "./local-db";

export const TEST_GAME_HOOK = "test-hook-game";

/** The recorded fixtures, from the working directory (the build moves this file). */
const fixturesDir = () => path.join(process.cwd(), "tests/fixtures");

let live: { gameId: string; replay: LiveReplay } | undefined;
let queue: Promise<unknown> = Promise.resolve();

/** Runs `fn` after every call before it has finished. */
function oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

/** Resets the database and seeds and opens the 2026 game at `at`. */
export function seedTestGame(at: Date): Promise<{ gameId: string }> {
  return oneAtATime(() =>
    withDb(async (db) => {
      live = undefined;
      await resetLocalDb(db);
      const { gameId, assetId } = await seedGame2026(db, at, fixturesDir());
      const replay = await startLiveReplay(db, {
        gameId,
        at,
        fixturesDir: fixturesDir(),
        assetId,
      });
      live = { gameId, replay };
      return { gameId };
    }),
  );
}

/** A refusal the route answers with `status` instead of a 500. */
export class HarnessError extends Error {
  constructor(
    readonly status: 400 | 409,
    message: string,
  ) {
    super(message);
  }
}

/** Moves the clock to `to`, running every job due on the way. */
export function moveTestClock(
  to: Date,
): Promise<{ now: string; jobsRun: number }> {
  return oneAtATime(async () => {
    if (!live) throw new HarnessError(409, "Seed the game first");
    if (to.getTime() < live.replay.now.getTime()) {
      throw new HarnessError(400, "The clock never moves back");
    }
    const { jobsRun } = await live.replay.advance(to);
    return { now: live.replay.now.toISOString(), jobsRun };
  });
}

/**
 * The seeded game and each of its rounds, for the harness's own spec: the
 * status, the pool, how many of the pool are priced, and how many sessions
 * have a current scoring run.
 */
export function testGameState() {
  return oneAtATime(() =>
    withDb(async (db) => {
      const now = (await resolveClock({ mode: "replay", db })).now();
      if (!live) {
        return {
          gameId: null,
          now: now.toISOString(),
          status: null,
          priceUpdates: 0,
          rounds: [],
        };
      }
      const { gameId } = live;
      const [game] = await db
        .select({ status: games.status })
        .from(games)
        .where(eq(games.id, gameId));
      const [pool] = await db
        .select({ n: count() })
        .from(poolAssets)
        .where(eq(poolAssets.gameId, gameId));
      const [updates] = await db
        .select({ n: count() })
        .from(priceUpdateRuns)
        .where(eq(priceUpdateRuns.gameId, gameId));
      const rounds = await db
        .select({
          round: events.round,
          status: gameEvents.status,
          prices: sql<number>`(
            select count(*)::int
            from ${assetPrices}
            join ${poolAssets} on ${poolAssets.id} = ${assetPrices.assetId}
            where ${poolAssets.gameId} = ${gameId}
              and ${assetPrices.eventId} = ${gameEvents.eventId}
          )`,
          scoredSessions: sql<number>`(
            select count(*)::int
            from ${scoringRuns}
            join ${sessions} on ${sessions.id} = ${scoringRuns.sessionId}
            where ${scoringRuns.gameId} = ${gameId}
              and ${scoringRuns.isCurrent}
              and ${sessions.eventId} = ${gameEvents.eventId}
          )`,
        })
        .from(gameEvents)
        .innerJoin(events, eq(events.id, gameEvents.eventId))
        .where(eq(gameEvents.gameId, gameId))
        .orderBy(events.round);
      return {
        gameId,
        now: now.toISOString(),
        status: game!.status,
        priceUpdates: updates!.n,
        rounds: rounds.map((r) => ({
          ...r,
          pool: pool!.n,
          prices: Number(r.prices),
          scoredSessions: Number(r.scoredSessions),
        })),
      };
    }),
  );
}
