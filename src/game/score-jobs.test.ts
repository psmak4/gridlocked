import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import {
  lockRound,
  round2026,
  seedGame2026,
} from "../../tests/helpers/game-2026";
import { ingest } from "../../tests/helpers/ingest-2026";
import { allJobs, sessionOf } from "../../tests/helpers/pipeline-2026";
import {
  enterNoTimeDrivers,
  replayRound,
  replaySeasonGame,
} from "../../tests/helpers/replay-2026";
import { readFixture } from "../../tests/helpers/fixtures";
import { loadBody } from "../../tests/helpers/results-2026";
import {
  assetPrices,
  assetScoreLines,
  drivers,
  events,
  gameEvents,
  jobs,
  leagueStandings,
  priceUpdateRuns,
  reviewItems,
  scoringRuns,
  sessionResultState,
  sessions,
  teamEventStates,
  teamEventTotals,
} from "@/db/schema";
import { createTeam } from "./teams";
import { openGame, saveLineup, type LineupPick } from "./lineups";
import { planGameEvents } from "./games";
import { createGameHandlers, planGameJobs } from "./jobs";
import { clearSessionException, setSessionException } from "./cancellations";
import { startRun, writeAssetLines } from "./scoring-runs";
import {
  createScoreHandlers,
  enqueueScoring,
  finalizeGameEvent,
} from "./score-jobs";
import {
  gameFinalizeKey,
  scoreKey,
  scoreStepKey,
  type GameFinalizePayload,
  type ScoreSessionPayload,
} from "@/jobs/kinds";
import { enqueue } from "@/jobs/queue";
import { runDue } from "@/jobs/runner";
import { simulatedClock } from "@/lib/clock";
import { newId } from "@/lib/ids";
import { createLeague, joinLeague } from "@/leagues/leagues";
import { setSimulatedClock } from "@/replay/clock-loop";
import { gameScriptSchema } from "@/replay/game-script";
import { addOverride } from "@/results/overrides";
import { advanceStatus } from "@/results/status";
import { overrideResult } from "@/staff/results";
import type { StaffActor } from "@/staff/roster";

// The scoring pipeline (DM 4.8). The first part replays round 1 (Australia)
// through the real scheduler tick with a seeded game and two teams. Its
// qualifying is short of three drivers Jolpica omits, so staff enter them at
// QUALIFYING_ENTERED and it scores before the race. The second part runs the jobs directly, to reach what a
// weekend doesn't: retries, failures, batches and leagues.

/**
 * `assets`: the writeAssetLines failure of the last-attempt test. `afterFinish`
 * runs once, after an inline run finishes: what lands between `finalizeGameEvent`'s
 * inline runs and its transaction.
 */
const breaking = vi.hoisted(() => ({
  assets: false,
  afterFinish: null as null | (() => Promise<void>),
}));
vi.mock("./scoring-runs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./scoring-runs")>();
  return {
    ...actual,
    writeAssetLines: (...args: Parameters<typeof actual.writeAssetLines>) =>
      breaking.assets
        ? Promise.reject(new Error("the engine broke"))
        : actual.writeAssetLines(...args),
    finishRun: async (...args: Parameters<typeof actual.finishRun>) => {
      const finished = await actual.finishRun(...args);
      const hook = breaking.afterFinish;
      breaking.afterFinish = null;
      await hook?.();
      return finished;
    },
  };
});

const NOW = new Date("2026-02-01T09:00:00.000Z");
const HOUR = 3_600_000;
const LEASE = 300_000;
const ACTOR: StaffActor = { kind: "admin", label: "staff" };
// Round 1's race ends at 06:00Z and its results appear at 06:30Z.
const RACE_END = Date.parse("2026-03-08T06:00:00Z");
// Round 1's qualifying ends at 06:00Z and its results appear at 06:30Z.
const QUALIFYING_ENTERED = "2026-03-07T07:00:00Z";
const after = (hours: number) => new Date(RACE_END + hours * HOUR);
const iso = (hours: number) => after(hours).toISOString();
// 280 + 250 + 95 + 85 + 80 + 90 + 70 = 950, leaving 50 in the bank.
const DRIVERS = ["norris", "piastri", "hulkenberg", "hadjar", "bearman"];
const CONSTRUCTORS = ["haas", "audi"];
/** The override that takes a driver's race result away. */
const DSQ = { classification: "disqualified", position: null } as const;

describe("the scoring pipeline (DM 4.8)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let game: Awaited<ReturnType<typeof seedGame2026>>;
  let gameId: string;
  let round1: { id: string; lockAt: Date };
  let round2: { id: string; lockAt: Date };
  let teamA: string;
  let teamB: string;
  const users = new Map<string, string>();

  beforeEach(async () => {
    t = await createTestDb();
    breaking.assets = false;
    breaking.afterFinish = null;
    users.clear();
  });
  afterEach(async () => {
    await t.close();
  });

  const team = async (db: typeof t.db, at: Date, name: string) => {
    const userId = newId();
    const id = await createTeam(db, at, { gameId, userId, name });
    users.set(id, userId);
    return id;
  };
  const picksOf = async (boost: string): Promise<LineupPick[]> => [
    ...(await Promise.all(
      DRIVERS.map(async (key) => ({
        assetId: await game.assetId(key),
        isBoost: key === boost,
      })),
    )),
    ...(await Promise.all(
      CONSTRUCTORS.map(async (key) => ({
        assetId: await game.assetId(key),
        isBoost: false,
      })),
    )),
  ];
  /** The game, open, with teams A (Boost Norris) and B (Boost Hadjar) saved. */
  async function seedTeams(db: typeof t.db, at: Date) {
    game = await seedGame2026(db, at);
    gameId = game.gameId;
    round1 = await round2026(db, 1);
    round2 = await round2026(db, 2);
    await openGame(db, at, gameId);
    teamA = await team(db, at, "A");
    teamB = await team(db, at, "B");
    await saveLineup(db, at, {
      teamId: teamA,
      picks: await picksOf("norris"),
      basedOnVersionId: null,
    });
    await saveLineup(db, at, {
      teamId: teamB,
      picks: await picksOf("hadjar"),
      basedOnVersionId: null,
    });
  }
  /** Round 1 with the game seeded and its lock and open jobs planned. */
  const replay = (
    options: Parameters<typeof replayRound>[2] = {},
  ): ReturnType<typeof replayRound> =>
    replayRound(t.db, 1, {
      ...options,
      actions: [
        {
          at: QUALIFYING_ENTERED,
          run: (now) => enterNoTimeDrivers(t.db, now, 1),
        },
        ...(options.actions ?? []),
      ],
      setup: async (db, at) => {
        await seedTeams(db as typeof t.db, at);
        await planGameJobs(db, at, gameId);
      },
    });

  const raceId = async () => (await sessionOf(t.db, round1.id, "race")).id;
  const runs = async (sessionId?: string) =>
    t.db
      .select()
      .from(scoringRuns)
      .where(
        sessionId === undefined
          ? undefined
          : eq(scoringRuns.sessionId, sessionId),
      )
      .orderBy(asc(scoringRuns.id));
  const statusOf = async (eventId: string) =>
    (
      await t.db
        .select({ status: gameEvents.status })
        .from(gameEvents)
        .where(
          and(eq(gameEvents.gameId, gameId), eq(gameEvents.eventId, eventId)),
        )
    )[0]!.status;
  const totals = (eventId: string) =>
    t.db
      .select()
      .from(teamEventTotals)
      .where(eq(teamEventTotals.eventId, eventId))
      .orderBy(asc(teamEventTotals.teamId));
  /** The session's scoring jobs: every session's without one. */
  const scoreJobs = async (sessionId?: string) =>
    (await allJobs(t.db)).filter(
      (j) =>
        j.kind === "score_session" &&
        (sessionId === undefined ||
          (j.payload as ScoreSessionPayload).sessionId === sessionId),
    );
  const pricesFor = (eventId: string) =>
    t.db.select().from(assetPrices).where(eq(assetPrices.eventId, eventId));
  const driverId = async (slug: string) =>
    (
      await t.db
        .select({ id: drivers.id })
        .from(drivers)
        .where(eq(drivers.slug, slug))
    )[0]!.id;

  describe("round 1, replayed", () => {
    it("provisional results score the session through all three steps", async () => {
      // The poll after the results appear runs at 07:20Z.
      await replay({ until: iso(1.5) });
      const race = await raceId();

      const [run, ...more] = await runs(race);
      expect(more).toEqual([]);
      expect(run).toMatchObject({
        trigger: "results",
        mode: "live",
        status: "succeeded",
        isCurrent: true,
      });
      const jobs = await scoreJobs(race);
      expect(jobs.map((j) => j.status)).toEqual([
        "succeeded",
        "succeeded",
        "succeeded",
      ]);
      expect(new Set(jobs.map((j) => j.dedupeKey))).toEqual(
        new Set([
          expect.stringMatching(
            new RegExp(`^score:${gameId}:${race}:v\\d+$`),
          ) as string,
          scoreStepKey(run!.id, "teams"),
          scoreStepKey(run!.id, "standings"),
        ]),
      );
      const lines = await t.db
        .select()
        .from(assetScoreLines)
        .where(eq(assetScoreLines.sessionId, race));
      expect(lines.length).toBeGreaterThan(0);
      const rows = await totals(round1.id);
      expect(rows.map((r) => r.teamId)).toEqual([teamA, teamB].sort());
      expect(new Set(rows.map((r) => r.status))).toEqual(
        new Set(["provisional"]),
      );
      // Their lineups differ only in the Boost, so their points do too.
      expect(rows[0]!.points).not.toBe(rows[1]!.points);
    });

    it("the event becomes scored, then final after the +48h check", async () => {
      await replay({
        actions: [
          {
            at: iso(47),
            run: async () => {
              expect(await statusOf(round1.id)).toBe("scored");
              expect(
                new Set((await totals(round1.id)).map((r) => r.status)),
              ).toEqual(new Set(["provisional"]));
            },
          },
        ],
      });

      expect(await statusOf(round1.id)).toBe("final");
      expect(new Set((await totals(round1.id)).map((r) => r.status))).toEqual(
        new Set(["final"]),
      );
      const [job] = (await allJobs(t.db)).filter(
        (j) => j.kind === "game_finalize",
      );
      expect(job).toMatchObject({
        dedupeKey: gameFinalizeKey(gameId, round1.id),
        status: "succeeded",
        runAt: after(48),
      });
      // Nothing changed since the race was scored: no second run.
      expect(await runs(await raceId())).toHaveLength(1);
    });

    it("a session under review isn't scored, and resolving it scores once", async () => {
      await replay({
        admin: [
          { at: "2026-03-08T05:00:00Z", kind: "block", session: "race" },
          { at: iso(3), kind: "resolve", session: "race" },
        ],
        actions: [
          {
            at: iso(2.5),
            run: async () => {
              const race = await raceId();
              expect(await runs(race)).toEqual([]);
              expect(await scoreJobs(race)).toEqual([]);
              // Scored only as far as qualifying: no team has race points.
              expect(await statusOf(round1.id)).toBe("scored");
              for (const row of await totals(round1.id)) {
                expect(Object.keys(row.pointsBySession)).not.toContain(race);
              }
            },
          },
        ],
        // The +6 h check moves it to provisional, which queues the run.
        until: iso(7),
      });

      expect(await runs(await raceId())).toMatchObject([
        { status: "succeeded", trigger: "results" },
      ]);
      expect(await statusOf(round1.id)).toBe("scored");
    });

    it("an override re-scores, and its totals move", async () => {
      let before = new Map<string, number>();
      await replay({
        actions: [
          {
            at: iso(3),
            run: async (now) => {
              before = new Map(
                (await totals(round1.id)).map((r) => [r.teamId, r.points]),
              );
              // Both teams own Norris, whose positions gained now count from
              // the back. A session under review wouldn't be scored, so this
              // has to be a change the validator accepts.
              const { changed } = await overrideResult(t.db, now, {
                sessionId: await raceId(),
                driverId: await driverId("norris"),
                fields: { pit_lane_start: true },
                reason: "Disqualified after the race",
                actor: ACTOR,
              });
              expect(changed).toBe(true);
            },
          },
        ],
        until: iso(4),
      });

      expect(await runs(await raceId())).toMatchObject([
        { status: "succeeded", trigger: "results", isCurrent: false },
        { status: "succeeded", trigger: "override", isCurrent: true },
      ]);
      for (const row of await totals(round1.id)) {
        expect(row.points).toBeGreaterThan(before.get(row.teamId)!);
      }
    });

    it("a session exception re-scores with no lines", async () => {
      await replay({
        actions: [
          {
            at: iso(3),
            run: async (now) => {
              const race = await raceId();
              for (const row of await totals(round1.id)) {
                expect(row.pointsBySession).toHaveProperty(race);
                expect(row.pointsBySession[race]).not.toBe(0);
              }
              await setSessionException(t.db, now, {
                gameId,
                sessionId: await raceId(),
                policy: "skip",
                reason: "Abandoned and voided",
                actor: ACTOR,
              });
            },
          },
        ],
        until: iso(4),
      });

      const race = await raceId();
      expect(await runs(race)).toMatchObject([
        { trigger: "results", isCurrent: false },
        { trigger: "exception", status: "succeeded", isCurrent: true },
      ]);
      expect(
        await t.db
          .select()
          .from(assetScoreLines)
          .where(eq(assetScoreLines.sessionId, race)),
      ).toEqual([]);
      // Only qualifying counts now, and neither team's race is in its total.
      const qualifying = await sessionOf(t.db, round1.id, "qualifying");
      for (const row of await totals(round1.id)) {
        expect(row.pointsBySession[race] ?? 0).toBe(0);
        expect(row.points).toBe(row.pointsBySession[qualifying.id]);
      }
      const [job] = (await scoreJobs()).filter((j) =>
        j.dedupeKey.includes(":x:"),
      );
      expect(job).toMatchObject({ status: "succeeded" });
    });

    it("the next window opens as soon as the event is final, with formula prices", async () => {
      // An hour past the check: well before round 2's 24-hour cutoff.
      await replay({ until: iso(48.5) });

      expect(await statusOf(round2.id)).toBe("open");
      const prices = await pricesFor(round2.id);
      expect(prices.length).toBeGreaterThan(0);
      expect(new Set(prices.map((p) => p.source))).toEqual(
        new Set(["formula"]),
      );
      const [update] = await t.db.select().from(priceUpdateRuns);
      expect(update).toMatchObject({
        gameId,
        afterEventId: round1.id,
        ranBy: "system",
      });
      expect(
        (await allJobs(t.db)).find(
          (j) => j.dedupeKey === `game_open:${gameId}:${round2.id}:final`,
        ),
      ).toMatchObject({ status: "succeeded", runAt: after(48) });
      expect(
        await t.db
          .select()
          .from(reviewItems)
          .where(eq(reviewItems.kind, "prices_carried")),
      ).toEqual([]);
    });

    it("an event final after the next window opened carries prices, and opens prices_carried", async () => {
      // Held in review past the cutoff: round 2 opens first, on carried prices.
      const cutoff = Date.parse("2026-03-12T03:30:00Z");
      const resolveAt = new Date(cutoff + 12 * HOUR);
      await replay({
        admin: [
          { at: "2026-03-08T05:00:00Z", kind: "block", session: "race" },
          { at: resolveAt.toISOString(), kind: "resolve", session: "race" },
        ],
        actions: [
          {
            at: new Date(resolveAt.getTime() - HOUR).toISOString(),
            run: async () => {
              expect(await statusOf(round2.id)).toBe("open");
            },
          },
        ],
        until: new Date(resolveAt.getTime() + 7 * HOUR).toISOString(),
      });

      expect(await statusOf(round1.id)).toBe("final");
      const prices = await pricesFor(round2.id);
      expect(new Set(prices.map((p) => p.source))).toEqual(
        new Set(["carried"]),
      );
      expect(await t.db.select().from(priceUpdateRuns)).toEqual([]);
      expect(
        await t.db
          .select()
          .from(reviewItems)
          .where(eq(reviewItems.kind, "prices_carried")),
      ).toMatchObject([
        {
          severity: "warning",
          status: "open",
          eventId: round1.id,
          dedupeKey: `prices_carried:${gameId}:${round1.id}`,
        },
      ]);
    });

    it("the daily calendar sync sweeps a dead game_finalize, and the event goes final", async () => {
      await replay({
        actions: [
          {
            // Dead under its own key, so finalizing can't queue it again.
            at: iso(47),
            run: async (now) => {
              const { id } = await enqueue(t.db, {
                kind: "game_finalize",
                dedupeKey: gameFinalizeKey(gameId, round1.id),
                runAt: now,
                payload: { gameId, eventId: round1.id },
              });
              await t.db
                .update(jobs)
                .set({ status: "dead", finishedAt: now })
                .where(eq(jobs.id, id));
            },
          },
        ],
        // The sync after the +48 h check is at 06:00Z the next day at the latest.
        until: iso(73),
      });

      const sweeps = (await allJobs(t.db)).filter(
        (j) =>
          j.dedupeKey.includes("game_finalize") &&
          j.dedupeKey.includes(":sweep:"),
      );
      expect(sweeps).toMatchObject([{ status: "succeeded" }]);
      expect(await statusOf(round1.id)).toBe("final");
      expect(new Set((await totals(round1.id)).map((r) => r.status))).toEqual(
        new Set(["final"]),
      );
      expect(await t.db.select().from(priceUpdateRuns)).toHaveLength(1);
    });

    it("the same results twice queue one run", async () => {
      await replay({
        actions: [
          {
            at: iso(25),
            run: async (now) => {
              const race = await raceId();
              const [state] = await t.db
                .select({ version: sessionResultState.version })
                .from(sessionResultState)
                .where(eq(sessionResultState.sessionId, race));
              // The +2, +6 and +24 h checks saw the same version: same key.
              expect(
                await enqueueScoring(t.db, now, {
                  sessionId: race,
                  stamp: `v${state!.version}`,
                  trigger: "results",
                }),
              ).toBe(0);
            },
          },
        ],
        until: iso(26),
      });

      expect(await runs(await raceId())).toHaveLength(1);
      expect(
        (await scoreJobs(await raceId())).filter((j) =>
          j.dedupeKey.startsWith(`score:${gameId}:`),
        ),
      ).toHaveLength(1);
    });
  });

  // The whole season: about 30 s on CI, past the project default.
  it("the M3 season replay still passes", async () => {
    const script = gameScriptSchema.parse(readFixture("game-2026-script.json"));
    const report = await replaySeasonGame(t.db, script, {
      seed: (db) => seedGame2026(db, NOW),
    });
    expect(report.violations).toEqual([]);
    expect(report.refused).toBe(
      script.actions.filter((a) => a.kind === "expectRefused").length,
    );
    expect(report.eventsLocked).toBe(
      (await t.db.select().from(events)).length - report.eventsCancelled,
    );
  }, 120_000);

  describe("the jobs, run directly", () => {
    const clock = simulatedClock(NOW);
    let race: { id: string; scheduledEnd: Date };
    let scoredAt: Date;

    /** Both clocks: the one the handlers read and the database's. */
    async function at(instant: Date) {
      clock.set(instant);
      await setSimulatedClock(t.db, instant);
    }
    const run = (handlers = createScoreHandlers(), maxJobs = 20) =>
      runDue(t.db, clock, handlers, { maxJobs, leaseMs: LEASE });
    /** Results for the session, moved on to provisional, as the poll does. */
    const resultsIn = async () => {
      await ingest(
        t.db,
        scoredAt,
        race.id,
        "race",
        loadBody("jolpica/2026/r01-results.json"),
      );
      return advanceStatus(t.db, scoredAt, race.id);
    };
    const queueResults = async () => {
      const { resultsVersion } = await resultsIn();
      return enqueueScoring(t.db, scoredAt, {
        sessionId: race.id,
        stamp: `v${resultsVersion}`,
        trigger: "results",
      });
    };
    const queueStep = (
      payload: ScoreSessionPayload,
      key: string,
      maxAttempts?: number,
    ) =>
      enqueue(t.db, {
        kind: "score_session",
        dedupeKey: key,
        runAt: scoredAt,
        payload,
        maxAttempts,
      });
    const runOf = async (id: string) =>
      (await t.db.select().from(scoringRuns).where(eq(scoringRuns.id, id)))[0]!;
    /** A live run that has written its asset lines, with no job behind it. */
    const startedRun = async () => {
      const started = await startRun(t.db, scoredAt, {
        gameId,
        sessionId: race.id,
        trigger: "results",
        mode: "live",
      });
      if (!("runId" in started)) throw new Error("skipped");
      return started.runId;
    };
    /** A private league of both teams. */
    async function league() {
      const owner = newId();
      const { leagueId, joinCode } = await createLeague(t.db, scoredAt, {
        gameId,
        ownerUserId: owner,
        kind: "private",
        name: "League",
      });
      for (const teamId of [teamA, teamB]) {
        await joinLeague(t.db, scoredAt, {
          joinCode,
          teamId,
          userId: users.get(teamId)!,
        });
      }
      return leagueId;
    }
    const cancelGameEvent = () =>
      t.db
        .update(gameEvents)
        .set({ status: "cancelled", sequence: null })
        .where(
          and(eq(gameEvents.gameId, gameId), eq(gameEvents.eventId, round1.id)),
        );

    beforeEach(async () => {
      await at(NOW);
      await seedTeams(t.db, NOW);
      const lockAt = await lockRound(t.db, gameId, round1.id);
      race = await sessionOf(t.db, round1.id, "race");
      scoredAt = new Date(race.scheduledEnd.getTime() + HOUR);
      await at(lockAt);
      await at(scoredAt);
    });

    describe("the game_finalize sweep", () => {
      const all = () => ({ ...createGameHandlers(), ...createScoreHandlers() });
      const dayOf = (at: Date) => at.toISOString().slice(0, 10);
      const sweepKey = (at: Date) =>
        `${gameFinalizeKey(gameId, round1.id)}:sweep:${dayOf(at)}`;
      const finalizeJobs = async () =>
        (await allJobs(t.db)).filter((j) => j.kind === "game_finalize");
      const completeEvent = () =>
        t.db
          .update(events)
          .set({ status: "completed" })
          .where(eq(events.id, round1.id));
      /** Round 1 scored, its event completed and its finalize job queued. */
      async function scoredAndCompleted() {
        await queueResults();
        await run();
        await completeEvent();
        return enqueue(t.db, {
          kind: "game_finalize",
          dedupeKey: gameFinalizeKey(gameId, round1.id),
          runAt: scoredAt,
          payload: {
            gameId,
            eventId: round1.id,
          } satisfies GameFinalizePayload,
          maxAttempts: 1,
        });
      }
      const later = () => new Date(scoredAt.getTime() + 24 * HOUR);

      it("a dead game_finalize is swept, and the event goes final", async () => {
        await scoredAndCompleted();
        const broken = {
          ...all(),
          game_finalize: () => Promise.reject(new Error("the database went")),
        };
        expect(await run(broken)).toMatchObject({ failed: 1 });
        expect(await finalizeJobs()).toMatchObject([{ status: "dead" }]);
        expect(await statusOf(round1.id)).toBe("scored");

        await at(later());
        await planGameJobs(t.db, later(), gameId);

        expect(
          (await finalizeJobs()).find((j) => j.dedupeKey === sweepKey(later())),
        ).toMatchObject({
          status: "pending",
          runAt: later(),
          payload: {
            gameId,
            eventId: round1.id,
            sweep: dayOf(later()),
          },
        });
        expect(await run(all())).toMatchObject({ failed: 0 });
        expect(await statusOf(round1.id)).toBe("final");
        expect(new Set((await totals(round1.id)).map((r) => r.status))).toEqual(
          new Set(["final"]),
        );
        expect(await t.db.select().from(priceUpdateRuns)).toHaveLength(1);
      });

      it("a game event that locked after its event completed, so never had a job, is swept", async () => {
        await queueResults();
        await run();
        await completeEvent();
        expect(await finalizeJobs()).toEqual([]);

        await at(later());
        await planGameJobs(t.db, later(), gameId);
        await run(all());

        expect(await statusOf(round1.id)).toBe("final");
      });

      it("a pending game_finalize isn't doubled", async () => {
        await scoredAndCompleted();
        await at(later());
        await planGameJobs(t.db, later(), gameId);
        expect(await finalizeJobs()).toHaveLength(1);
      });

      it("one waiting to retry isn't doubled", async () => {
        const { id } = await scoredAndCompleted();
        await t.db
          .update(jobs)
          .set({ status: "failed" })
          .where(eq(jobs.id, id));
        await at(later());
        await planGameJobs(t.db, later(), gameId);
        expect(await finalizeJobs()).toHaveLength(1);
      });

      it("planning again the same day queues nothing more", async () => {
        await queueResults();
        await run();
        await completeEvent();
        await planGameJobs(t.db, scoredAt, gameId);
        await planGameJobs(t.db, scoredAt, gameId);
        expect(await finalizeJobs()).toHaveLength(1);
      });

      it("a game event that's already final isn't swept", async () => {
        await queueResults();
        await run();
        await completeEvent();
        await finalizeGameEvent(t.db, scoredAt, { gameId, eventId: round1.id });

        await at(later());
        await planGameJobs(t.db, later(), gameId);

        expect(await finalizeJobs()).toEqual([]);
      });

      it("an event still to complete isn't swept", async () => {
        await queueResults();
        await run();
        await at(later());
        await planGameJobs(t.db, later(), gameId);
        expect(await finalizeJobs()).toEqual([]);
      });

      describe("an event cancelled after its lock (DM 3.9)", () => {
        const cancelEvent = () =>
          t.db
            .update(events)
            .set({ status: "cancelled" })
            .where(eq(events.id, round1.id));
        /** The daily sync: the game follows the calendar, then plans. */
        const sync = async () => {
          await at(later());
          await planGameEvents(t.db, later(), gameId);
          await planGameJobs(t.db, later(), gameId);
        };

        it("what was scored reaches final, and prices the next event by the formula", async () => {
          await queueResults();
          await run();
          await cancelEvent();
          await sync();

          expect(await run(all())).toMatchObject({ failed: 0 });

          expect(await statusOf(round1.id)).toBe("final");
          expect(
            new Set((await totals(round1.id)).map((r) => r.status)),
          ).toEqual(new Set(["final"]));
          expect(
            new Set((await pricesFor(round2.id)).map((p) => p.source)),
          ).toEqual(new Set(["formula"]));
          expect(await t.db.select().from(priceUpdateRuns)).toHaveLength(1);
          expect(await statusOf(round2.id)).toBe("open");
        });

        it("with nothing scored it reaches final, and the next window opens at once", async () => {
          await cancelEvent();
          await sync();
          // Days short of the 24-hour cutoff, which is the only other way in.
          expect(later().getTime()).toBeLessThan(
            round2.lockAt.getTime() - 24 * HOUR,
          );

          expect(await run(all())).toMatchObject({ failed: 0 });

          expect(await statusOf(round1.id)).toBe("final");
          expect(await t.db.select().from(priceUpdateRuns)).toEqual([]);
          expect(await runs()).toEqual([]);
          expect(await statusOf(round2.id)).toBe("open");
          expect(
            new Set((await pricesFor(round2.id)).map((p) => p.source)),
          ).toEqual(new Set(["carried"]));
          expect(
            (await totals(round1.id)).map((r) => [r.status, r.points]),
          ).toEqual([
            ["final", 0],
            ["final", 0],
          ]);
        });

        it("every session cancelled with it changes neither", async () => {
          await queueResults();
          await run();
          await cancelEvent();
          await t.db
            .update(sessions)
            .set({ status: "cancelled" })
            .where(eq(sessions.eventId, round1.id));
          await sync();

          expect(await run(all())).toMatchObject({ failed: 0 });

          expect(await statusOf(round1.id)).toBe("final");
          expect(
            new Set((await pricesFor(round2.id)).map((p) => p.source)),
          ).toEqual(new Set(["formula"]));
        });

        it("planning again the same day queues nothing more", async () => {
          await cancelEvent();
          await sync();
          await sync();
          expect(await finalizeJobs()).toMatchObject([
            { dedupeKey: sweepKey(later()) },
          ]);
        });

        it("a pending game_finalize isn't doubled", async () => {
          await enqueue(t.db, {
            kind: "game_finalize",
            dedupeKey: gameFinalizeKey(gameId, round1.id),
            runAt: later(),
            payload: {
              gameId,
              eventId: round1.id,
            } satisfies GameFinalizePayload,
          });
          await cancelEvent();
          await sync();
          expect(await finalizeJobs()).toHaveLength(1);
        });

        it("an event cancelled before its lock isn't swept", async () => {
          await t.db
            .update(events)
            .set({ status: "cancelled" })
            .where(eq(events.id, round2.id));
          await sync();
          expect(await statusOf(round2.id)).toBe("cancelled");
          expect(await finalizeJobs()).toEqual([]);
        });
      });
    });

    describe("enqueueScoring", () => {
      it("queues nothing for a session with no results or one under review", async () => {
        expect(
          await enqueueScoring(t.db, scoredAt, {
            sessionId: race.id,
            stamp: "v0",
            trigger: "results",
          }),
        ).toBe(0);
        await resultsIn();
        await t.db
          .update(sessionResultState)
          .set({ status: "under_review" })
          .where(eq(sessionResultState.sessionId, race.id));
        expect(
          await enqueueScoring(t.db, scoredAt, {
            sessionId: race.id,
            stamp: "v1",
            trigger: "results",
          }),
        ).toBe(0);
        expect(await scoreJobs()).toEqual([]);
      });

      it("queues one job per running game whose event has locked, carrying its trigger", async () => {
        const { resultsVersion } = await resultsIn();
        expect(
          await enqueueScoring(t.db, scoredAt, {
            sessionId: race.id,
            stamp: `v${resultsVersion}`,
            trigger: "results",
          }),
        ).toBe(1);
        const [job] = await scoreJobs();
        expect(job).toMatchObject({
          dedupeKey: scoreKey(gameId, race.id, `v${resultsVersion}`),
          runAt: scoredAt,
          payload: {
            gameId,
            sessionId: race.id,
            trigger: "results",
            step: "assets",
          },
        });
      });

      it("queues nothing for an event the game hasn't locked", async () => {
        const china = await sessionOf(t.db, round2.id, "race");
        await t.db
          .insert(sessionResultState)
          .values({ sessionId: china.id, status: "provisional" });
        expect(
          await enqueueScoring(t.db, scoredAt, {
            sessionId: china.id,
            stamp: "v1",
            trigger: "results",
          }),
        ).toBe(0);
      });

      it("with gameId, limits itself to that game", async () => {
        await resultsIn();
        expect(
          await enqueueScoring(t.db, scoredAt, {
            sessionId: race.id,
            stamp: "x:one",
            trigger: "exception",
            gameId: newId(),
          }),
        ).toBe(0);
      });
    });

    describe("score_session", () => {
      it("writes the teams in as many jobs as the batch size says", async () => {
        await queueResults();
        await run(createScoreHandlers({ batchSize: 1 }));

        const [scored] = await runs(race.id);
        const ids = (
          await t.db
            .select({ id: teamEventStates.teamId })
            .from(teamEventStates)
            .where(eq(teamEventStates.eventId, round1.id))
            .orderBy(asc(teamEventStates.teamId))
        ).map((r) => r.id);
        expect(ids).toHaveLength(2);
        const keys = (await scoreJobs()).map((j) => j.dedupeKey);
        expect(keys).toContain(scoreStepKey(scored!.id, "teams"));
        expect(keys).toContain(scoreStepKey(scored!.id, "teams", ids[0]));
        expect(keys).toContain(scoreStepKey(scored!.id, "standings"));
        expect((await scoreJobs()).map((j) => j.status)).toEqual(
          keys.map(() => "succeeded"),
        );
        expect(scored).toMatchObject({ status: "succeeded" });
        expect(await totals(round1.id)).toHaveLength(2);
      });

      it("a job run again after its run finished stops quietly", async () => {
        await queueResults();
        await run();
        const [scored] = await runs(race.id);
        const before = await totals(round1.id);
        const again: ScoreSessionPayload = {
          gameId,
          sessionId: race.id,
          trigger: "results",
          runId: scored!.id,
          step: "teams",
        };
        await queueStep(again, "again:teams");
        await queueStep({ ...again, step: "standings" }, "again:standings");

        expect(await run()).toEqual({ ran: 2, failed: 0, lost: 0 });
        expect(await totals(round1.id)).toEqual(before);
      });

      it("the assets step run twice starts one run that counts", async () => {
        await queueResults();
        const [job] = await scoreJobs();
        await run(createScoreHandlers(), 1);
        // The job ran again before its next step did.
        await queueStep(job!.payload as ScoreSessionPayload, "again:assets");
        await run();

        const all = await runs(race.id);
        expect(all.map((r) => r.status)).toEqual(["superseded", "succeeded"]);
        expect(all[1]).toMatchObject({ isCurrent: true });
        expect(await statusOf(round1.id)).toBe("scored");
      });

      it("the same inputs skip, and nothing after the assets step runs", async () => {
        await queueResults();
        await run();
        const steps = (await scoreJobs()).length;
        const before = await totals(round1.id);
        await enqueueScoring(t.db, scoredAt, {
          sessionId: race.id,
          stamp: "v99",
          trigger: "results",
        });

        expect(await run()).toEqual({ ran: 1, failed: 0, lost: 0 });
        expect(await runs(race.id)).toHaveLength(1);
        expect(await scoreJobs()).toHaveLength(steps + 1);
        expect(await totals(round1.id)).toEqual(before);
      });

      it("a superseded run stops, and doesn't move the game event", async () => {
        await resultsIn();
        const old = await startedRun();
        expect(await writeAssetLines(t.db, scoredAt, old)).toBe("written");
        await startedRun();
        await queueStep(
          {
            gameId,
            sessionId: race.id,
            trigger: "results",
            runId: old,
            step: "standings",
          },
          "old:standings",
        );

        expect(await run()).toEqual({ ran: 1, failed: 0, lost: 0 });
        expect(await statusOf(round1.id)).toBe("locked");
        expect(await totals(round1.id)).toEqual([]);
      });

      it("a new live run marks the earlier running one superseded", async () => {
        await resultsIn();
        const first = await startedRun();
        const later = new Date(scoredAt.getTime() + 60_000);
        const started = await startRun(t.db, later, {
          gameId,
          sessionId: race.id,
          trigger: "results",
          mode: "live",
        });

        expect(started).toHaveProperty("runId");
        expect(await runOf(first)).toMatchObject({
          status: "superseded",
          finishedAt: later,
        });
      });

      it("a dry run leaves the running live run alone", async () => {
        await resultsIn();
        const live = await startedRun();
        await startRun(t.db, scoredAt, {
          gameId,
          sessionId: race.id,
          trigger: "results",
          mode: "dry_run",
        });
        expect(await runOf(live)).toMatchObject({ status: "running" });
      });

      it("a step that throws on its last attempt marks its run failed", async () => {
        await resultsIn();
        // Its asset lines were never written, so the team step refuses it.
        const runId = await startedRun();
        const payload: ScoreSessionPayload = {
          gameId,
          sessionId: race.id,
          trigger: "results",
          runId,
          step: "teams",
        };
        await queueStep(payload, "last:try", 1);

        expect(await run()).toEqual({ ran: 0, failed: 1, lost: 0 });
        expect(await runOf(runId)).toMatchObject({
          status: "failed",
          finishedAt: scoredAt,
        });
        expect(
          (await scoreJobs()).find((j) => j.dedupeKey === "last:try"),
        ).toMatchObject({ status: "dead" });
      });

      it("a step that throws with attempts left keeps its run running", async () => {
        await resultsIn();
        const runId = await startedRun();
        await queueStep(
          {
            gameId,
            sessionId: race.id,
            trigger: "results",
            runId,
            step: "teams",
          },
          "first:try",
        );

        expect(await run()).toEqual({ ran: 0, failed: 1, lost: 0 });
        expect(await runOf(runId)).toMatchObject({ status: "running" });
      });

      it("the assets step failing on its last attempt marks the run it started failed", async () => {
        await resultsIn();
        await queueStep(
          { gameId, sessionId: race.id, trigger: "results", step: "assets" },
          "last:assets",
          1,
        );
        breaking.assets = true;

        expect(await run()).toEqual({ ran: 0, failed: 1, lost: 0 });
        expect(await runs(race.id)).toMatchObject([{ status: "failed" }]);
      });

      it("a job finding its game event cancelled returns quietly", async () => {
        await resultsIn();
        const runId = await startedRun();
        expect(await writeAssetLines(t.db, scoredAt, runId)).toBe("written");
        const base: ScoreSessionPayload = {
          gameId,
          sessionId: race.id,
          trigger: "results",
          step: "assets",
        };
        await queueStep(base, "c:assets");
        await queueStep({ ...base, runId, step: "teams" }, "c:teams");
        await queueStep({ ...base, runId, step: "standings" }, "c:standings");
        await cancelGameEvent();

        expect(await run()).toEqual({ ran: 3, failed: 0, lost: 0 });
        expect(await runs(race.id)).toHaveLength(1);
        expect(await runOf(runId)).toMatchObject({ status: "running" });
      });

      it("clearing an exception re-scores too, under a key of its own", async () => {
        await queueResults();
        await setSessionException(t.db, scoredAt, {
          gameId,
          sessionId: race.id,
          policy: "skip",
          reason: "Voided",
          actor: ACTOR,
        });
        await run();
        await clearSessionException(t.db, scoredAt, {
          gameId,
          sessionId: race.id,
          reason: "Reinstated",
          actor: ACTOR,
        });
        await run();

        expect((await runs(race.id)).map((r) => r.trigger)).toEqual([
          "results",
          "exception",
          "exception",
        ]);
        expect(
          (await scoreJobs()).filter((j) => j.dedupeKey.includes(":x:")),
        ).toHaveLength(2);
        expect((await totals(round1.id))[0]!.points).not.toBe(0);
      });

      it("a job whose session has gone under review since it was queued does nothing", async () => {
        await queueResults();
        await t.db
          .update(sessionResultState)
          .set({ status: "under_review" })
          .where(eq(sessionResultState.sessionId, race.id));

        expect(await run()).toEqual({ ran: 1, failed: 0, lost: 0 });
        expect(await runs(race.id)).toEqual([]);
      });
    });

    describe("finalizeGameEvent", () => {
      const finalize = (now = scoredAt, batchSize?: number) =>
        finalizeGameEvent(t.db, now, {
          gameId,
          eventId: round1.id,
          batchSize,
        });

      it("leaves final totals and final standings", async () => {
        const leagueId = await league();
        await queueResults();
        await run();
        expect(
          new Set(
            (
              await t.db
                .select()
                .from(leagueStandings)
                .where(eq(leagueStandings.leagueId, leagueId))
            ).map((r) => r.status),
          ),
        ).toEqual(new Set(["provisional"]));

        await finalize();

        expect(await statusOf(round1.id)).toBe("final");
        expect(new Set((await totals(round1.id)).map((r) => r.status))).toEqual(
          new Set(["final"]),
        );
        const table = await t.db
          .select()
          .from(leagueStandings)
          .where(eq(leagueStandings.leagueId, leagueId));
        expect(table).toHaveLength(2);
        expect(new Set(table.map((r) => r.status))).toEqual(new Set(["final"]));
      });

      it("re-runs a scored session whose current run no longer matches, inline", async () => {
        await queueResults();
        await run();
        const before = new Map(
          (await totals(round1.id)).map((r) => [r.teamId, r.points]),
        );
        await addOverride(t.db, scoredAt, {
          sessionId: race.id,
          driverId: await driverId("norris"),
          kind: "patch",
          fields: DSQ,
          reason: "Disqualified",
          createdBy: "00000000-0000-0000-0000-000000000000",
        });

        await finalize(scoredAt, 1);

        expect(await runs(race.id)).toMatchObject([
          { isCurrent: false },
          { status: "succeeded", isCurrent: true, trigger: "results" },
        ]);
        for (const row of await totals(round1.id)) {
          expect(row.points).toBeLessThan(before.get(row.teamId)!);
          expect(row.status).toBe("final");
        }
      });

      it("doesn't run a session with no results", async () => {
        await at(scoredAt);
        // The race is still `awaiting`, and the qualifying has no state row.
        await finalize();

        expect(await runs()).toEqual([]);
        expect(await statusOf(round1.id)).toBe("final");
      });

      it("scores a session that is provisional or final, but not one awaiting", async () => {
        await resultsIn();
        const qualifying = await sessionOf(t.db, round1.id, "qualifying");
        await t.db
          .insert(sessionResultState)
          .values({ sessionId: qualifying.id, status: "awaiting" })
          .onConflictDoNothing();

        await finalize();

        expect((await runs()).map((r) => r.sessionId)).toEqual([race.id]);
      });

      it("a cancelled session is left out", async () => {
        await resultsIn();
        await t.db
          .update(sessions)
          .set({ status: "cancelled" })
          .where(eq(sessions.id, race.id));

        await finalize();

        expect(await runs()).toEqual([]);
      });

      it("run again, it does nothing", async () => {
        await queueResults();
        await run();
        await finalize();
        const after = await totals(round1.id);
        const open = (await allJobs(t.db)).filter(
          (j) => j.kind === "game_open",
        );

        await finalize(new Date(scoredAt.getTime() + HOUR));

        expect(await totals(round1.id)).toEqual(after);
        expect(
          (await allJobs(t.db)).filter((j) => j.kind === "game_open"),
        ).toEqual(open);
        expect(await t.db.select().from(priceUpdateRuns)).toHaveLength(1);
      });

      it("returns quietly for an event the game never played, or cancelled", async () => {
        await finalizeGameEvent(t.db, scoredAt, {
          gameId,
          eventId: round2.id,
        });
        expect(await statusOf(round2.id)).toBe("upcoming");

        await resultsIn();
        await cancelGameEvent();
        await enqueue(t.db, {
          kind: "game_finalize",
          dedupeKey: gameFinalizeKey(gameId, round1.id),
          runAt: scoredAt,
          payload: {
            gameId,
            eventId: round1.id,
          } satisfies GameFinalizePayload,
        });
        expect(await run()).toEqual({ ran: 1, failed: 0, lost: 0 });
        expect(await statusOf(round1.id)).toBe("cancelled");
        expect(await runs()).toEqual([]);
      });

      it("a correction after final re-scores, keeps the event final and moves no price", async () => {
        await queueResults();
        await run();
        await finalize();
        const prices = await pricesFor(round2.id);
        const before = await totals(round1.id);
        await setSessionException(t.db, scoredAt, {
          gameId,
          sessionId: race.id,
          policy: "skip",
          reason: "Voided after the event",
          actor: ACTOR,
        });

        // The open job finalizing queued runs too.
        expect(
          await run({ ...createGameHandlers(), ...createScoreHandlers() }),
        ).toMatchObject({ failed: 0 });

        expect(await statusOf(round1.id)).toBe("final");
        expect(await statusOf(round2.id)).toBe("open");
        expect(await pricesFor(round2.id)).toEqual(prices);
        const rows = await totals(round1.id);
        expect(rows.map((r) => r.points)).not.toEqual(
          before.map((r) => r.points),
        );
        expect(new Set(rows.map((r) => r.status))).toEqual(new Set(["final"]));
      });

      it("a cancel landing after the inline runs leaves the event cancelled, and publishes no prices", async () => {
        await resultsIn();
        breaking.afterFinish = async () => {
          await cancelGameEvent();
        };

        await finalize();

        expect(await runs(race.id)).toHaveLength(1);
        expect(await statusOf(round1.id)).toBe("cancelled");
        expect(await pricesFor(round2.id)).toEqual([]);
        expect(await t.db.select().from(priceUpdateRuns)).toEqual([]);
        expect(
          (await allJobs(t.db)).filter((j) => j.kind === "game_open"),
        ).toEqual([]);
      });

      it("a second pass after the next window opened raises no prices_carried", async () => {
        await resultsIn();
        // Past its lease, a second worker finishes the job, and round 2 opens.
        breaking.afterFinish = async () => {
          await finalize();
          await run({ ...createGameHandlers(), ...createScoreHandlers() });
        };

        await finalize();

        expect(await statusOf(round2.id)).toBe("open");
        expect(await t.db.select().from(priceUpdateRuns)).toHaveLength(1);
        expect(
          await t.db
            .select()
            .from(reviewItems)
            .where(eq(reviewItems.kind, "prices_carried")),
        ).toEqual([]);
      });

      it("the formula's prices are written before the open job runs, and it is due now", async () => {
        await queueResults();
        await run();
        await finalize();

        expect(
          new Set((await pricesFor(round2.id)).map((p) => p.source)),
        ).toEqual(new Set(["formula"]));
        expect(
          (await allJobs(t.db)).find(
            (j) => j.dedupeKey === `game_open:${gameId}:${round2.id}:final`,
          ),
        ).toMatchObject({
          status: "pending",
          runAt: scoredAt,
          payload: { gameId, eventId: round2.id },
        });
      });
    });
  });
});
