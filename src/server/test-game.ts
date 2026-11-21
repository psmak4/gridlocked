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
import { and, asc, count, desc, eq, gt, isNull, sql } from "drizzle-orm";
import {
  assetPrices,
  constructors,
  drivers,
  events,
  gameEvents,
  games,
  lineupPicks,
  lineupVersions,
  poolAssets,
  priceUpdateRuns,
  scoringRuns,
  seatAssignments,
  profiles,
  sessions,
  teams,
  users,
} from "@/db/schema";
import { SYSTEM_USER_ID } from "@/identity/system";
import { openReviewItem } from "@/reference/review";
import { addOverride } from "@/results/overrides";
import { saveLineup } from "@/game/lineups";
import { withdrawPoolAsset } from "@/game/pool";
import { createTeam } from "@/game/teams";
import { joinLeague } from "@/leagues/leagues";
import { newId } from "@/lib/ids";
import { resolveClock } from "@/lib/resolve-clock";
import { setSimulatedClock } from "@/replay/clock-loop";
import { startLiveReplay, type LiveReplay } from "@/providers/replay/live-game";
import { seedGame2026 } from "@/providers/replay/seed-2026";
import { withDb } from "./db";
import {
  localChatArchiveFiles,
  localChatArchiveStore,
  resetLocalDb,
} from "./local-db";

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
      localChatArchiveFiles.clear();
      const { gameId, assetId } = await seedGame2026(db, at, fixturesDir());
      const replay = await startLiveReplay(db, {
        gameId,
        at,
        fixturesDir: fixturesDir(),
        assetId,
        chatArchiveStore: localChatArchiveStore,
      });
      live = { gameId, replay };
      return { gameId };
    }),
  );
}

/** Resets the database with no game, the clock at `at`: before a game opens. */
export function clearTestGame(at: Date): Promise<void> {
  return oneAtATime(() =>
    withDb(async (db) => {
      live = undefined;
      await resetLocalDb(db);
      await setSimulatedClock(db, at);
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
 * Withdraws the driver with `code` (e.g. "VER") from the open event, as
 * staff would: a pool change under an open builder (M6 Review Focus 4).
 */
export function withdrawTestDriver(code: string): Promise<{ assetId: string }> {
  return oneAtATime(() =>
    withDb(async (db) => {
      if (!live) throw new HarnessError(409, "Seed the game first");
      const { gameId } = live;
      const now = (await resolveClock({ mode: "replay", db })).now();
      const [open] = await db
        .select({ eventId: gameEvents.eventId })
        .from(gameEvents)
        .where(
          and(eq(gameEvents.gameId, gameId), eq(gameEvents.status, "open")),
        );
      if (!open) throw new HarnessError(409, "No event is open");
      const [asset] = await db
        .select({ id: poolAssets.id })
        .from(poolAssets)
        .innerJoin(drivers, eq(drivers.id, poolAssets.driverId))
        .where(and(eq(poolAssets.gameId, gameId), eq(drivers.code, code)));
      if (!asset) throw new HarnessError(400, `No driver ${code} in the pool`);
      await withdrawPoolAsset(db, now, {
        assetId: asset.id,
        fromEventId: open.eventId,
        reason: "Fantasy e2e: a pool change under an open builder",
        actor: { kind: "admin", label: "e2e" },
      });
      return { assetId: asset.id };
    }),
  );
}

/**
 * Disqualifies the driver with `code` from the latest race that has results,
 * as a `patch` override with nothing re-scored (M8 Task 8): the stored lines
 * are then stale, so a scoring dry run has a change to show. A staff
 * correction would queue its own re-score.
 */
export function staleTestOverride(
  code: string,
): Promise<{ sessionId: string }> {
  return oneAtATime(() =>
    withDb(async (db) => {
      if (!live) throw new HarnessError(409, "Seed the game first");
      const now = (await resolveClock({ mode: "replay", db })).now();
      const [race] = await db
        .select({ id: sessions.id })
        .from(sessions)
        .innerJoin(scoringRuns, eq(scoringRuns.sessionId, sessions.id))
        .where(and(eq(sessions.kind, "race"), eq(scoringRuns.isCurrent, true)))
        .orderBy(desc(sessions.scheduledStart))
        .limit(1);
      if (!race) throw new HarnessError(409, "No race is scored yet");
      const [driver] = await db
        .select({ id: drivers.id })
        .from(drivers)
        .where(eq(drivers.code, code));
      if (!driver) throw new HarnessError(400, `No driver ${code}`);
      await addOverride(db, now, {
        sessionId: race.id,
        driverId: driver.id,
        kind: "patch",
        fields: { classification: "disqualified", position: null },
        reason: "Fantasy e2e: a result change nothing has re-scored",
        createdBy: SYSTEM_USER_ID,
      });
      return { sessionId: race.id };
    }),
  );
}

/**
 * Opens a team change in the review queue for the next event that hasn't
 * locked: the driver with `code` seen at constructor `team` (its slug), as
 * the roster check would find it. Something for the queue to resolve.
 */
export function teamChangeTestReview(input: {
  code: string;
  team: string;
}): Promise<{ eventId: string }> {
  return oneAtATime(() =>
    withDb(async (db) => {
      if (!live) throw new HarnessError(409, "Seed the game first");
      const now = (await resolveClock({ mode: "replay", db })).now();
      const [event] = await db
        .select({ id: events.id, seasonId: events.seasonId })
        .from(events)
        .where(and(eq(events.status, "scheduled"), gt(events.lockAt, now)))
        .orderBy(asc(events.lockAt))
        .limit(1);
      if (!event) throw new HarnessError(409, "No event is still to lock");
      const [driver] = await db
        .select({ id: drivers.id })
        .from(drivers)
        .where(eq(drivers.code, input.code));
      const [team] = await db
        .select({ id: constructors.id })
        .from(constructors)
        .where(eq(constructors.slug, input.team));
      if (!driver || !team)
        throw new HarnessError(400, "No such driver or team");
      const [seat] = await db
        .select({ constructorId: seatAssignments.constructorId })
        .from(seatAssignments)
        .where(
          and(
            eq(seatAssignments.driverId, driver.id),
            eq(seatAssignments.role, "race"),
            isNull(seatAssignments.validTo),
          ),
        );
      await openReviewItem(db, now, {
        kind: "team_change",
        seasonId: event.seasonId,
        eventId: event.id,
        driverId: driver.id,
        details: {
          driverId: driver.id,
          constructorId: team.id,
          expectedConstructorId: seat?.constructorId ?? null,
        },
        dedupeKey: `test:team_change:${event.id}:${driver.id}`,
      });
      return { eventId: event.id };
    }),
  );
}

/**
 * Adds `count` accounts, each with a team saved for the open event, for a
 * table long enough to page (M6 Task 13). Each team copies the latest saved
 * lineup in the game, with the Boost moved round its drivers so the totals
 * differ, and joins the league with `joinCode` when given.
 */
export function addTestCrowd(input: {
  count: number;
  joinCode?: string;
}): Promise<{ teams: number }> {
  return oneAtATime(() =>
    withDb(async (db) => {
      if (!live) throw new HarnessError(409, "Seed the game first");
      const { gameId } = live;
      const now = (await resolveClock({ mode: "replay", db })).now();
      const [template] = await db
        .select({ id: lineupVersions.id })
        .from(lineupVersions)
        .innerJoin(teams, eq(teams.id, lineupVersions.teamId))
        .where(eq(teams.gameId, gameId))
        .orderBy(desc(lineupVersions.savedAt))
        .limit(1);
      if (!template) throw new HarnessError(409, "Save a team first");
      const picks = await db
        .select({ assetId: lineupPicks.assetId, driverId: poolAssets.driverId })
        .from(lineupPicks)
        .innerJoin(poolAssets, eq(poolAssets.id, lineupPicks.assetId))
        .where(eq(lineupPicks.lineupVersionId, template.id));
      // The Boost is a driver's.
      const boostable = picks.filter((p) => p.driverId !== null);
      for (let i = 0; i < input.count; i++) {
        const userId = newId();
        const username = `crowd_${userId.replaceAll("-", "").slice(-12)}`;
        await db.insert(users).values({
          id: userId,
          name: username,
          email: `${username}@example.test`,
          emailVerified: true,
          role: "user",
          username,
          displayUsername: username,
          createdAt: now,
          updatedAt: now,
        });
        await db.insert(profiles).values({
          userId,
          status: "active",
          avatarSeed: userId,
          createdAt: now,
          updatedAt: now,
        });
        const teamId = await createTeam(db, now, {
          gameId,
          userId,
          name: `Crowd ${i + 1}`,
        });
        await saveLineup(db, now, {
          teamId,
          picks: picks.map((p) => ({
            assetId: p.assetId,
            isBoost: p.assetId === boostable[i % boostable.length]!.assetId,
          })),
          basedOnVersionId: null,
        });
        if (input.joinCode) {
          await joinLeague(db, now, {
            joinCode: input.joinCode,
            teamId,
            userId,
          });
        }
      }
      return { teams: input.count };
    }),
  );
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
