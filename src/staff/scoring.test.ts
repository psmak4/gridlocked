import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import {
  lockRound,
  round2026,
  seedGame2026,
} from "../../tests/helpers/game-2026";
import { ingest } from "../../tests/helpers/ingest-2026";
import { sessionOf } from "../../tests/helpers/pipeline-2026";
import { loadBody } from "../../tests/helpers/results-2026";
import { seedUser } from "../../tests/helpers/users";
import { drivers, jobs, leagueStandings, teamEventTotals } from "@/db/schema";
import { createDryRunHandlers, dryRunGame } from "@/game/corrections";
import { openGame, saveLineup, type LineupPick } from "@/game/lineups";
import { createScoreHandlers, enqueueScoring } from "@/game/score-jobs";
import { createTeam } from "@/game/teams";
import { SYSTEM_USER_ID } from "@/identity/system";
import { runDue } from "@/jobs/runner";
import { createLeague, joinLeague } from "@/leagues/leagues";
import { recomputeStandings } from "@/leagues/standings";
import { simulatedClock } from "@/lib/clock";
import { setSimulatedClock } from "@/replay/clock-loop";
import { addOverride } from "@/results/overrides";
import { advanceStatus } from "@/results/status";
import { ENGINE_VERSION } from "@/scoring/engine";
import type { StaffActor } from "./roster";
import { dryRunSummary, rulesetVersions, startDryRun } from "./scoring";

const NOW = new Date("2026-02-01T09:00:00.000Z");
const HOUR = 3_600_000;
const ACTOR: StaffActor = { kind: "admin", label: null, requestId: "r1" };
const DRIVERS = ["norris", "piastri", "hulkenberg", "hadjar", "bearman"];
const CONSTRUCTORS = ["haas", "audi"];

// The scoring board (M8 Task 8) over the recorded 2026 game: teams A and B
// locked into round 1, its race scored through the jobs, then Norris
// disqualified and nothing re-scored, so a dry run has something to show.
describe("dryRunSummary and rulesetVersions (M8 Task 8)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let gameId: string;
  let round1: { id: string; lockAt: Date };
  let teamA: string;
  let teamB: string;
  const users = new Map<string, string>();
  const clock = simulatedClock(NOW);

  async function at(instant: Date) {
    clock.set(instant);
    await setSimulatedClock(t.db, instant);
  }

  beforeEach(async () => {
    t = await createTestDb();
    users.clear();
    await at(NOW);
    const game = await seedGame2026(t.db, NOW);
    gameId = game.gameId;
    round1 = await round2026(t.db, 1);
    await openGame(t.db, NOW, gameId);
    const team = async (name: string, boost: string) => {
      const userId = await seedUser(t.db);
      const id = await createTeam(t.db, NOW, { gameId, userId, name });
      users.set(id, userId);
      const picks: LineupPick[] = [
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
      await saveLineup(t.db, NOW, {
        teamId: id,
        picks,
        basedOnVersionId: null,
      });
      return id;
    };
    // A boosts Norris, so his disqualification costs A the most.
    teamA = await team("Alpha", "norris");
    teamB = await team("Bravo", "hadjar");
    await lockRound(t.db, gameId, round1.id);
    const race = await sessionOf(t.db, round1.id, "race");
    await at(new Date(race.scheduledEnd.getTime() + HOUR));
    await ingest(
      t.db,
      clock.now(),
      race.id,
      "race",
      loadBody("jolpica/2026/r01-results.json"),
    );
    const { resultsVersion } = await advanceStatus(t.db, clock.now(), race.id);
    await enqueueScoring(t.db, clock.now(), {
      sessionId: race.id,
      stamp: `v${resultsVersion}`,
      trigger: "results",
    });
    expect(
      await runDue(t.db, clock, createScoreHandlers(), {
        maxJobs: 50,
        leaseMs: 300_000,
      }),
    ).toMatchObject({ failed: 0 });
    const [norris] = await t.db
      .select({ id: drivers.id })
      .from(drivers)
      .where(eq(drivers.slug, "norris"));
    await addOverride(t.db, clock.now(), {
      sessionId: race.id,
      driverId: norris!.id,
      kind: "patch",
      fields: { classification: "disqualified", position: null },
      reason: "Stewards",
      createdBy: SYSTEM_USER_ID,
    });
  });
  afterEach(async () => {
    await t.close();
  });

  /** A league of both teams, its standings then set by hand. */
  async function league(name: string, points: Record<string, number>) {
    const { leagueId, joinCode } = await createLeague(t.db, clock.now(), {
      gameId,
      ownerUserId: await seedUser(t.db),
      kind: "private",
      name,
    });
    for (const teamId of [teamA, teamB]) {
      await joinLeague(t.db, clock.now(), {
        joinCode,
        teamId,
        userId: users.get(teamId)!,
      });
    }
    await recomputeStandings(t.db, clock.now(), {
      gameId,
      eventId: round1.id,
    });
    const ranked = Object.entries(points).sort(([, a], [, b]) => b - a);
    for (const [i, [teamId, p]] of ranked.entries()) {
      await t.db
        .update(leagueStandings)
        .set({ points: p, rank: i + 1 })
        .where(
          and(
            eq(leagueStandings.leagueId, leagueId),
            eq(leagueStandings.teamId, teamId),
          ),
        );
    }
  }

  it("dryRunSummary is null with no dry run", async () => {
    expect(await dryRunSummary(t.db, gameId)).toBeNull();
  });

  it("dryRunSummary gives teams affected of total, events, the biggest change and leagues whose first place changes", async () => {
    // A leads by one point here, so the fix hands first place to B.
    await league("Close", { [teamA]: 101, [teamB]: 100 });
    // And by a thousand here, which no fix of one race overturns.
    await league("Runaway", { [teamA]: 1100, [teamB]: 100 });
    const report = await dryRunGame(t.db, clock.now(), ACTOR, {
      gameId,
      reason: "Engine 2026.2",
    });
    const season = async (teamId: string) =>
      (
        await t.db
          .select({ points: teamEventTotals.points })
          .from(teamEventTotals)
          .where(eq(teamEventTotals.teamId, teamId))
      ).reduce((sum, r) => sum + r.points, 0);

    const summary = await dryRunSummary(t.db, gameId);

    expect(summary).toMatchObject({
      dryRunId: report.dryRunId,
      state: "pending",
      engineVersion: ENGINE_VERSION,
      reason: "Engine 2026.2",
      events: [{ id: round1.id, round: 1 }],
    });
    expect(summary!.tiles).toEqual([
      { label: "TEAMS AFFECTED", value: "2", sub: "of 2" },
      { label: "EVENTS", value: "1", sub: "Round 1" },
      {
        label: "BIGGEST CHANGE",
        value: expect.stringMatching(/^[−+]\d+$/),
        sub: "Alpha",
      },
      {
        label: "LEAGUE LEADERS",
        value: "1",
        sub: "Leagues whose 1st place changes",
      },
    ]);
    const [first, second] = summary!.rows;
    expect(first).toMatchObject({
      teamId: teamA,
      team: "Alpha",
      events: "Round 1",
      before: await season(teamA),
    });
    expect(first!.after - first!.before).toBe(first!.change);
    expect(first!.change).toBeLessThan(second!.change);
    expect(second).toMatchObject({ teamId: teamB, team: "Bravo" });
    expect(Math.abs(first!.change)).toBeGreaterThan(Math.abs(second!.change));
  });

  it("a dry run longer than one batch continues as a job, and the screen shows it running", async () => {
    // Started from the screen: the runs and the audit row now, the scoring
    // later, one dry_run job per event. A batch of one team makes two.
    const started = await startDryRun(t.db, clock.now(), ACTOR, {
      gameId,
      reason: "Engine 2026.2",
      batchSize: 1,
    });
    expect(started).toMatchObject({ sessions: 1, events: 1 });
    expect(await dryRunSummary(t.db, gameId)).toMatchObject({
      dryRunId: started.dryRunId,
      state: "running",
      sessions: 1,
    });
    const queued = await t.db
      .select({ payload: jobs.payload, runAt: jobs.runAt })
      .from(jobs)
      .where(eq(jobs.kind, "dry_run"));
    expect(queued).toMatchObject([
      { payload: { gameId, eventId: round1.id }, runAt: clock.now() },
    ]);

    expect(
      await runDue(t.db, clock, createDryRunHandlers(), {
        maxJobs: 10,
        leaseMs: 300_000,
      }),
    ).toMatchObject({ ran: 1, failed: 0 });
    const summary = await dryRunSummary(t.db, gameId);
    expect(summary).toMatchObject({
      dryRunId: started.dryRunId,
      state: "pending",
    });
    expect(summary!.tiles[0]).toEqual({
      label: "TEAMS AFFECTED",
      value: "2",
      sub: "of 2",
    });
  });

  it("a dry run job that fails sets the dry run aside", async () => {
    const started = await startDryRun(t.db, clock.now(), ACTOR, {
      gameId,
      reason: "Engine 2026.2",
    });
    // A newer dry run takes over before the job runs.
    await dryRunGame(t.db, clock.now(), ACTOR, {
      gameId,
      reason: "Engine 2026.3",
    });
    expect(
      await runDue(t.db, clock, createDryRunHandlers(), {
        maxJobs: 10,
        leaseMs: 300_000,
      }),
    ).toMatchObject({ failed: 0 });
    const summary = await dryRunSummary(t.db, gameId);
    expect(summary?.dryRunId).not.toBe(started.dryRunId);
    expect(summary).toMatchObject({
      state: "pending",
      reason: "Engine 2026.3",
    });
  });

  it("dryRunSummary says approved once the dry run it shows is approved", async () => {
    const { dryRunId } = await dryRunGame(t.db, clock.now(), ACTOR, {
      gameId,
      reason: "Engine 2026.2",
    });
    const { approveRescore } = await import("@/game/corrections");
    await approveRescore(t.db, clock.now(), ACTOR, {
      gameId,
      dryRunId,
      reason: "Looks right",
    });
    expect(await dryRunSummary(t.db, gameId)).toMatchObject({
      dryRunId,
      state: "approved",
    });
  });

  it("rulesetVersions lists the game's versions, newest first, with the events on each", async () => {
    const versions = await rulesetVersions(t.db, gameId);
    expect(versions.length).toBeGreaterThan(0);
    expect(versions[0]).toMatchObject({
      version: 1,
      isCorrection: false,
      fromRound: 1,
    });
    expect(versions[0]!.rounds).toContain(1);
  });
});
