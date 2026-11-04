import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import {
  lockRound,
  openRound,
  round2026,
  seedGame2026,
} from "../../tests/helpers/game-2026";
import { ingest } from "../../tests/helpers/ingest-2026";
import { sessionOf } from "../../tests/helpers/pipeline-2026";
import { loadBody } from "../../tests/helpers/results-2026";
import {
  assetScoreLines,
  assetSessionTotals,
  effectiveResults,
  lineupPicks,
  poolAssets,
  scoringRuns,
  sessionResultState,
  teamAdjustmentLines,
  teamBaseLines,
  teamEventStates,
} from "@/db/schema";
import { newId } from "@/lib/ids";
import { setSimulatedClock } from "@/replay/clock-loop";
import { addOverride } from "@/results/overrides";
import { scoreSession } from "@/scoring/engine";
import { SCORING_RULES_2026 } from "@/scoring/rules";
import type { StaffActor } from "@/staff/roster";
import { setSessionException } from "./cancellations";
import { playChip, saveFinalFix } from "./chips";
import { openGame, saveLineup, type LineupPick } from "./lineups";
import { RULESET_2026 } from "./ruleset";
import {
  finishRun,
  startRun,
  writeAssetLines,
  writeTeamAdjustments,
} from "./scoring-runs";
import { createTeam } from "./teams";

// Scoring runs and the two-tier ledger (DM 4.1-4.3) over the recorded 2026
// game: five teams locked into round 1 (Australia), whose recorded race is
// ingested, and a sixth team with no lineup and so no lock record. Round 2
// (China, a sprint weekend) is the Late Call's.

const NOW = new Date("2026-02-01T09:00:00.000Z");
const HOUR_MS = 3_600_000;
const ACTOR: StaffActor = { kind: "admin", label: "staff" };
// 280 + 250 + 95 + 85 + 80 + 90 + 70 = 950, leaving 50 in the bank.
const DRIVERS = ["norris", "piastri", "hulkenberg", "hadjar", "bearman"];
const CONSTRUCTORS = ["haas", "audi"];

type Run = typeof scoringRuns.$inferSelect;

describe("scoring runs and the ledger (DM 4.1-4.3)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let game: Awaited<ReturnType<typeof seedGame2026>>;
  let gameId: string;
  let round1: { id: string; lockAt: Date };
  let race1: { id: string; scheduledEnd: Date };
  /** The five locked teams, in id order; the first plays Safety Car. */
  let teamIds: string[];
  /** Each locked team's Boost driver, by team id. */
  let boostOf: Map<string, string>;
  let scoredAt: Date;

  beforeEach(async () => {
    t = await createTestDb();
    game = await seedGame2026(t.db, NOW);
    gameId = game.gameId;
    await setSimulatedClock(t.db, NOW);
    round1 = await round2026(t.db, 1);
    await openGame(t.db, NOW, gameId);
    teamIds = [];
    boostOf = new Map();
    for (const [i, boost] of DRIVERS.entries()) {
      const teamId = await team(`Team ${i + 1}`);
      await saveFor(round1, teamId, await picksOf(boost));
      teamIds.push(teamId);
      boostOf.set(teamId, boost);
    }
    teamIds.sort();
    await playChip(t.db, anHourBefore(round1), {
      teamId: teamIds[0]!,
      chipCode: "chip_no_negative",
    });
    // No lineup, so no lock record: it is never scored.
    await team("Unlocked");
    await lockRound(t.db, gameId, round1.id);

    race1 = await sessionOf(t.db, round1.id, "race");
    scoredAt = new Date(race1.scheduledEnd.getTime() + HOUR_MS);
    await ingest(
      t.db,
      scoredAt,
      race1.id,
      "race",
      loadBody("jolpica/2026/r01-results.json"),
    );
  });
  afterEach(async () => {
    await t.close();
  });

  /** A team for a new user, so slots never run out. */
  const team = (name: string) =>
    createTeam(t.db, NOW, { gameId, userId: newId(), name });
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
  const anHourBefore = (event: { lockAt: Date }) =>
    new Date(event.lockAt.getTime() - HOUR_MS);
  /** Saves one hour before the event's lock, with both clocks there. */
  const saveFor = async (
    event: { lockAt: Date },
    teamId: string,
    picks: LineupPick[],
  ) => {
    const now = anHourBefore(event);
    await setSimulatedClock(t.db, now);
    return saveLineup(t.db, now, { teamId, picks, basedOnVersionId: null });
  };

  const start = (
    sessionId: string,
    options: { trigger?: Run["trigger"]; force?: boolean } = {},
  ) =>
    startRun(t.db, scoredAt, {
      gameId,
      sessionId,
      trigger: options.trigger ?? "results",
      mode: "live",
      force: options.force,
    });
  /** The run's team step, batch by batch until done; returns each batch. */
  const writeTeams = async (runId: string, batchSize?: number) => {
    const batches: { done: boolean; lastTeamId: string | null }[] = [];
    let afterTeamId: string | null = null;
    for (;;) {
      const batch = await writeTeamAdjustments(t.db, scoredAt, runId, {
        afterTeamId,
        batchSize,
      });
      if (batch === "superseded") throw new Error(`run ${runId} superseded`);
      batches.push(batch);
      if (batch.done) return batches;
      afterTeamId = batch.lastTeamId;
    }
  };
  /** Every step of a started run. */
  const complete = async (runId: string) => {
    expect(await writeAssetLines(t.db, scoredAt, runId)).toBe("written");
    await writeTeams(runId);
    await finishRun(t.db, scoredAt, runId);
    return runId;
  };
  /** A whole run for the session, which must not be skipped. */
  const score = async (
    sessionId: string,
    options: Parameters<typeof start>[1] = {},
  ) => {
    const started = await start(sessionId, options);
    if (!("runId" in started)) throw new Error("the run was skipped");
    return complete(started.runId);
  };

  const runOf = async (runId: string) =>
    (
      await t.db.select().from(scoringRuns).where(eq(scoringRuns.id, runId))
    )[0]!;
  const linesOf = (sessionId: string) =>
    t.db
      .select()
      .from(assetScoreLines)
      .where(eq(assetScoreLines.sessionId, sessionId))
      .orderBy(
        asc(assetScoreLines.assetId),
        asc(assetScoreLines.ruleCode),
        asc(assetScoreLines.subjectDriverId),
      );
  const adjustmentsOf = (eventId: string) =>
    t.db
      .select()
      .from(teamAdjustmentLines)
      .where(eq(teamAdjustmentLines.eventId, eventId))
      .orderBy(
        asc(teamAdjustmentLines.teamId),
        asc(teamAdjustmentLines.sessionId),
        asc(teamAdjustmentLines.lineType),
        asc(teamAdjustmentLines.assetId),
        asc(teamAdjustmentLines.category),
      );
  /** Each asset's session points, summed from its lines. */
  const totalsFromLines = async (sessionId: string) => {
    const totals = new Map<string, number>();
    for (const line of await linesOf(sessionId)) {
      totals.set(line.assetId, (totals.get(line.assetId) ?? 0) + line.points);
    }
    return totals;
  };
  /** How many assets have points in the session. */
  const nonZero = async (sessionId: string) =>
    [...(await totalsFromLines(sessionId)).values()].filter((p) => p !== 0)
      .length;
  const teamBoosting = (key: string) =>
    [...boostOf].find(([, boost]) => boost === key)![0];
  const driverOf = async (key: string) =>
    (
      await t.db
        .select({ driverId: poolAssets.driverId })
        .from(poolAssets)
        .where(eq(poolAssets.id, await game.assetId(key)))
    )[0]!.driverId!;

  it("a run writes one line per non-zero rule result, tagged with its run", async () => {
    const runId = await score(race1.id);

    // The engine over the same effective results and pool, by hand.
    const results = await t.db
      .select()
      .from(effectiveResults)
      .where(eq(effectiveResults.sessionId, race1.id));
    const pool = await t.db
      .select()
      .from(poolAssets)
      .where(eq(poolAssets.gameId, gameId));
    const expected = scoreSession({
      sessionKind: "race",
      rules: SCORING_RULES_2026,
      knockout: RULESET_2026.knockout,
      results,
      pool: pool.map((a) => ({
        assetId: a.id,
        assetType: a.assetType,
        driverId: a.driverId,
        constructorId: a.constructorId,
      })),
    });
    const key = (l: { assetId: string; ruleCode: string }) =>
      `${l.assetId}:${l.ruleCode}`;
    const stored = await linesOf(race1.id);
    expect(stored.length).toBe(expected.length);
    expect(
      stored
        .map((l) => ({
          assetId: l.assetId,
          ruleCode: l.ruleCode,
          category: l.category,
          subjectDriverId: l.subjectDriverId,
          points: l.points,
          detail: l.detail,
        }))
        .sort(
          (a, b) =>
            key(a).localeCompare(key(b)) ||
            (a.subjectDriverId ?? "").localeCompare(b.subjectDriverId ?? ""),
        ),
    ).toEqual(
      [...expected].sort(
        (a, b) =>
          key(a).localeCompare(key(b)) ||
          (a.subjectDriverId ?? "").localeCompare(b.subjectDriverId ?? ""),
      ),
    );
    expect(stored.every((l) => l.runId === runId && l.points !== 0)).toBe(true);
    expect(stored.every((l) => l.gameId === gameId)).toBe(true);
    // Russell won from pole: 25 for the position.
    const russell = await game.assetId("russell");
    expect(
      stored.find(
        (l) => l.assetId === russell && l.ruleCode === "race.position",
      )?.points,
    ).toBe(25);

    const run = await runOf(runId);
    expect(run).toMatchObject({
      gameId,
      sessionId: race1.id,
      engineVersion: "2026.1",
      trigger: "results",
      mode: "live",
      status: "succeeded",
      isCurrent: true,
      startedAt: scoredAt,
      finishedAt: scoredAt,
    });
    expect(run.inputFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect((run.inputs as { results: unknown[] }).results).toHaveLength(22);
    // The first run is compared with nothing: every asset with points changed.
    expect(run.diffSummary).toMatchObject({
      previousRunId: null,
      assetsChanged: await nonZero(race1.id),
      teamsChanged: 5,
    });
    expect((run.diffSummary as { biggest: unknown[] }).biggest).toHaveLength(
      10,
    );
  });

  it("a constructor's category total sums both drivers", async () => {
    await score(race1.id);
    const lines = await linesOf(race1.id);
    const constructorIds = new Set(
      (
        await t.db
          .select({ id: poolAssets.id })
          .from(poolAssets)
          .where(
            and(
              eq(poolAssets.gameId, gameId),
              eq(poolAssets.assetType, "constructor"),
            ),
          )
      ).map((a) => a.id),
    );
    const totals = await t.db
      .select()
      .from(assetSessionTotals)
      .where(eq(assetSessionTotals.sessionId, race1.id));
    let shared = 0;
    for (const total of totals.filter((r) => constructorIds.has(r.assetId))) {
      const own = lines.filter((l) => l.assetId === total.assetId);
      const byCategory: Record<string, number> = {};
      const drivers = new Map<string, Set<string | null>>();
      for (const line of own) {
        byCategory[line.category] =
          (byCategory[line.category] ?? 0) + line.points;
        const set = drivers.get(line.category) ?? new Set();
        set.add(line.subjectDriverId);
        drivers.set(line.category, set);
      }
      expect(total.byCategory).toEqual(byCategory);
      expect(total.points).toBe(own.reduce((sum, l) => sum + l.points, 0));
      shared += [...drivers.values()].filter((s) => s.size === 2).length;
    }
    // Haas, for one: Bearman (12th to 7th, +5) and Ocon (13th to 11th, +2)
    // both gained places, and its race_positions total is the two together.
    expect(shared).toBeGreaterThan(0);
    const haas = await game.assetId("haas");
    expect(
      new Set(
        lines
          .filter((l) => l.assetId === haas && l.category === "race_positions")
          .map((l) => l.subjectDriverId),
      ).size,
    ).toBe(2);
    expect(
      totals.find((r) => r.assetId === haas)?.byCategory.race_positions,
    ).toBe(7);
  });

  it("the same inputs twice skip the second run", async () => {
    await score(race1.id);
    expect(await start(race1.id)).toEqual({ skipped: true });
    expect(await t.db.select().from(scoringRuns)).toHaveLength(1);
  });

  it("an override changes the fingerprint and re-scores", async () => {
    const first = await score(race1.id);
    await addOverride(t.db, scoredAt, {
      sessionId: race1.id,
      driverId: await driverOf("norris"),
      kind: "patch",
      fields: { fastest_lap_rank: 1 },
      reason: "Stewards: lap time reinstated",
      createdBy: newId(),
    });
    const second = await score(race1.id, { trigger: "override" });

    const [a, b] = [await runOf(first), await runOf(second)];
    expect(b.inputFingerprint).not.toBe(a.inputFingerprint);
    expect(a).toMatchObject({ status: "succeeded", isCurrent: false });
    expect(b).toMatchObject({ status: "succeeded", isCurrent: true });
    const norris = await game.assetId("norris");
    const mclaren = await game.assetId("mclaren");
    const lines = await linesOf(race1.id);
    expect(lines.every((l) => l.runId === second)).toBe(true);
    expect(
      lines.find(
        (l) => l.assetId === norris && l.ruleCode === "race.fastest_lap",
      )?.points,
    ).toBe(10);

    // Norris and McLaren gain 10; every team owns Norris, and the one with
    // his Boost gains it twice.
    const diff = b.diffSummary as {
      previousRunId: string;
      assetsChanged: number;
      teamsChanged: number;
      biggest: { kind: string; id: string; change: number }[];
    };
    expect(diff.previousRunId).toBe(first);
    expect(diff.assetsChanged).toBe(2);
    expect(diff.teamsChanged).toBe(5);
    expect(diff.biggest[0]).toMatchObject({
      kind: "team",
      id: teamBoosting("norris"),
      change: 20,
    });
    expect(diff.biggest).toContainEqual(
      expect.objectContaining({ kind: "asset", id: mclaren, change: 10 }),
    );
    expect(diff.biggest).toContainEqual(
      expect.objectContaining({ kind: "asset", id: norris, change: 10 }),
    );
  });

  it("a skip exception leaves the session with no lines", async () => {
    await score(race1.id);
    const before = await nonZero(race1.id);
    await setSessionException(t.db, scoredAt, {
      gameId,
      sessionId: race1.id,
      policy: "skip",
      reason: "Race voided",
      actor: ACTOR,
    });
    const runId = await score(race1.id, { trigger: "exception" });

    expect(await linesOf(race1.id)).toEqual([]);
    expect(
      await t.db
        .select()
        .from(assetSessionTotals)
        .where(eq(assetSessionTotals.sessionId, race1.id)),
    ).toEqual([]);
    // Round 1 is every team's first event: no transfer penalty, and with no
    // points nothing to boost or floor.
    expect(await adjustmentsOf(round1.id)).toEqual([]);
    const run = await runOf(runId);
    expect(run).toMatchObject({ status: "succeeded", isCurrent: true });
    expect(run.inputs).toMatchObject({ exception: { policy: "skip" } });
    expect(run.diffSummary).toMatchObject({
      assetsChanged: before,
      teamsChanged: 5,
    });
    // Voided twice is the same inputs.
    expect(await start(race1.id, { trigger: "exception" })).toEqual({
      skipped: true,
    });
  });

  it("team_base_lines joins the locked lineup to the asset totals", async () => {
    await score(race1.id);
    const totals = await totalsFromLines(race1.id);
    for (const teamId of teamIds) {
      const [state] = await t.db
        .select()
        .from(teamEventStates)
        .where(
          and(
            eq(teamEventStates.teamId, teamId),
            eq(teamEventStates.eventId, round1.id),
          ),
        );
      const picks = await t.db
        .select()
        .from(lineupPicks)
        .where(eq(lineupPicks.lineupVersionId, state!.lockedVersionId));
      const expected = picks
        .filter((p) => totals.has(p.assetId))
        .map((p) => ({
          gameId,
          teamId,
          eventId: round1.id,
          sessionId: race1.id,
          assetId: p.assetId,
          points: totals.get(p.assetId)!,
        }))
        .sort((a, b) => a.assetId.localeCompare(b.assetId));
      const base = await t.db
        .select()
        .from(teamBaseLines)
        .where(eq(teamBaseLines.teamId, teamId))
        .orderBy(asc(teamBaseLines.assetId));
      expect(base).toEqual(expected);
      expect(base.length).toBe(picks.length);
    }
    // The Boost line is the boosted driver's session points once more.
    const [boostLine] = (await adjustmentsOf(round1.id)).filter(
      (l) => l.teamId === teamIds[1] && l.lineType === "boost",
    );
    const [boostPick] = (
      await t.db
        .select()
        .from(teamEventStates)
        .innerJoin(
          lineupPicks,
          eq(lineupPicks.lineupVersionId, teamEventStates.lockedVersionId),
        )
        .where(
          and(
            eq(teamEventStates.teamId, teamIds[1]!),
            eq(lineupPicks.isBoost, true),
          ),
        )
    ).map((r) => r.lineup_picks);
    expect(boostLine).toMatchObject({
      assetId: boostPick!.assetId,
      sessionId: race1.id,
      points: totals.get(boostPick!.assetId),
    });
  });

  it("a Late Call team's race base lines use the Late Call version", async () => {
    // Round 2 opens an hour after round 1's lock and locks with the lineups
    // carried; qualifying's results open the Late Call window.
    const round2 = await round2026(t.db, 2);
    const opened = new Date(round1.lockAt.getTime() + HOUR_MS);
    await setSimulatedClock(t.db, opened);
    await openRound(t.db, opened, gameId, round2.id);
    await lockRound(t.db, gameId, round2.id);
    const qualifying = await sessionOf(t.db, round2.id, "qualifying");
    const sprint = await sessionOf(t.db, round2.id, "sprint");
    const race = await sessionOf(t.db, round2.id, "race");
    await t.db
      .insert(sessionResultState)
      .values({ sessionId: qualifying.id, status: "provisional" });
    const lateCallAt = new Date(race.scheduledStart.getTime() - 2 * HOUR_MS);
    await setSimulatedClock(t.db, lateCallAt);
    const lateCaller = teamIds[1]!;
    const hadjar = await game.assetId("hadjar");
    const lawson = await game.assetId("lawson");
    const { versionId } = await saveFinalFix(t.db, lateCallAt, {
      teamId: lateCaller,
      outAssetId: hadjar,
      inAssetId: lawson,
    });

    const after = new Date(race.scheduledEnd.getTime() + HOUR_MS);
    await ingest(
      t.db,
      after,
      sprint.id,
      "sprint",
      loadBody("jolpica/2026/r02-sprint.json"),
    );
    await ingest(
      t.db,
      after,
      race.id,
      "race",
      loadBody("jolpica/2026/r02-results.json"),
    );
    await score(sprint.id);
    await score(race.id);

    const base = (sessionId: string, teamId = lateCaller) =>
      t.db
        .select()
        .from(teamBaseLines)
        .where(
          and(
            eq(teamBaseLines.teamId, teamId),
            eq(teamBaseLines.eventId, round2.id),
            eq(teamBaseLines.sessionId, sessionId),
          ),
        );
    const assets = async (sessionId: string, teamId = lateCaller) =>
      (await base(sessionId, teamId)).map((r) => r.assetId).sort();
    const [state] = await t.db
      .select()
      .from(teamEventStates)
      .where(
        and(
          eq(teamEventStates.teamId, lateCaller),
          eq(teamEventStates.eventId, round2.id),
        ),
      );
    const picksOfVersion = async (id: string) =>
      (
        await t.db
          .select({ assetId: lineupPicks.assetId })
          .from(lineupPicks)
          .where(eq(lineupPicks.lineupVersionId, id))
      )
        .map((p) => p.assetId)
        .sort();
    // The sprint counts the locked lineup, the race the Late Call one.
    const locked = await picksOfVersion(state!.lockedVersionId);
    const lateCall = await picksOfVersion(versionId);
    expect(locked).toEqual(expect.arrayContaining(await assets(sprint.id)));
    expect(lateCall).toEqual(expect.arrayContaining(await assets(race.id)));
    expect(await assets(sprint.id)).toContain(hadjar);
    expect(await assets(sprint.id)).not.toContain(lawson);
    expect(await assets(race.id)).toContain(lawson);
    expect(await assets(race.id)).not.toContain(hadjar);
    // A team without the chip keeps its locked lineup in the race.
    expect(await assets(race.id, teamIds[2]!)).toContain(hadjar);
  });

  it("a later run supersedes an earlier one mid-way", async () => {
    const a = await start(race1.id);
    const b = await start(race1.id);
    if (!("runId" in a) || !("runId" in b)) throw new Error("skipped");
    await complete(b.runId);

    expect(await writeAssetLines(t.db, scoredAt, a.runId)).toBe("superseded");
    expect(
      await writeTeamAdjustments(t.db, scoredAt, a.runId, {
        afterTeamId: null,
      }),
    ).toBe("superseded");
    expect(await runOf(a.runId)).toMatchObject({
      status: "superseded",
      isCurrent: false,
      finishedAt: scoredAt,
    });
    expect(await runOf(b.runId)).toMatchObject({
      status: "succeeded",
      isCurrent: true,
    });
    const lines = await linesOf(race1.id);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => l.runId === b.runId)).toBe(true);
    const adjustments = await adjustmentsOf(round1.id);
    expect(adjustments.length).toBeGreaterThan(0);
    expect(adjustments.every((l) => l.runId === b.runId)).toBe(true);
  });

  it("a run superseded between its team batches stops writing", async () => {
    const a = await start(race1.id);
    if (!("runId" in a)) throw new Error("skipped");
    expect(await writeAssetLines(t.db, scoredAt, a.runId)).toBe("written");
    const first = await writeTeamAdjustments(t.db, scoredAt, a.runId, {
      afterTeamId: null,
      batchSize: 2,
    });
    expect(first).toEqual({ done: false, lastTeamId: teamIds[1] });
    const b = await start(race1.id, { force: true });
    if (!("runId" in b)) throw new Error("skipped");

    expect(
      await writeTeamAdjustments(t.db, scoredAt, a.runId, {
        afterTeamId: teamIds[1]!,
        batchSize: 2,
      }),
    ).toBe("superseded");
    expect(await finishRun(t.db, scoredAt, a.runId)).toBe("superseded");
    await complete(b.runId);
    expect(
      (await adjustmentsOf(round1.id)).every((l) => l.runId === b.runId),
    ).toBe(true);
    expect(await runOf(a.runId)).toMatchObject({ status: "superseded" });
  });

  it("re-scoring is idempotent", async () => {
    const first = await score(race1.id);
    /** Each row without its own id and its run's. */
    const strip = <T extends { id?: string; runId?: string }>(rows: T[]) =>
      rows.map((row) => {
        const rest = { ...row };
        delete rest.id;
        delete rest.runId;
        return rest;
      });
    const lines = strip(await linesOf(race1.id));
    const adjustments = strip(await adjustmentsOf(round1.id));

    const second = await score(race1.id, { trigger: "admin", force: true });
    expect(second).not.toBe(first);
    expect(strip(await linesOf(race1.id))).toEqual(lines);
    expect(strip(await adjustmentsOf(round1.id))).toEqual(adjustments);
    expect((await linesOf(race1.id)).every((l) => l.runId === second)).toBe(
      true,
    );
    const [a, b] = [await runOf(first), await runOf(second)];
    expect(b.inputFingerprint).toBe(a.inputFingerprint);
    expect(b.diffSummary).toEqual({
      previousRunId: first,
      assetsChanged: 0,
      teamsChanged: 0,
      biggest: [],
      assets: [],
    });
  });

  it("batches cover every locked team exactly once", async () => {
    const started = await start(race1.id);
    if (!("runId" in started)) throw new Error("skipped");
    const { runId } = started;
    expect(await writeAssetLines(t.db, scoredAt, runId)).toBe("written");
    const batches = await writeTeams(runId, 2);
    expect(batches).toEqual([
      { done: false, lastTeamId: teamIds[1] },
      { done: false, lastTeamId: teamIds[3] },
      { done: true, lastTeamId: teamIds[4] },
    ]);

    const adjustments = await adjustmentsOf(round1.id);
    expect([...new Set(adjustments.map((l) => l.teamId))]).toEqual(teamIds);
    expect(adjustments.every((l) => l.runId === runId)).toBe(true);
    // One Boost line each, in the race; nothing written twice.
    for (const teamId of teamIds) {
      expect(
        adjustments.filter(
          (l) => l.teamId === teamId && l.lineType === "boost",
        ),
      ).toHaveLength(1);
    }
    const keys = adjustments.map(
      (l) =>
        `${l.teamId}:${l.sessionId}:${l.lineType}:${l.assetId}:${l.category}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
    // Safety Car floors the first team's negative subtotals.
    expect(
      adjustments.some(
        (l) => l.teamId === teamIds[0] && l.lineType === "no_negative",
      ),
    ).toBe(true);

    // A batch run again (a retried job) writes the same lines.
    await writeTeamAdjustments(t.db, scoredAt, runId, {
      afterTeamId: teamIds[1]!,
      batchSize: 2,
    });
    expect(await adjustmentsOf(round1.id)).toHaveLength(adjustments.length);
    await finishRun(t.db, scoredAt, runId);
    expect((await runOf(runId)).diffSummary).toMatchObject({
      teamsChanged: 5,
    });
  });
});
