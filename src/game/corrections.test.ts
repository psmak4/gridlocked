import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq, sql } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import {
  lockRound,
  openRound,
  round2026,
  seedGame2026,
} from "../../tests/helpers/game-2026";
import { ingest } from "../../tests/helpers/ingest-2026";
import { allJobs, sessionOf } from "../../tests/helpers/pipeline-2026";
import { loadBody } from "../../tests/helpers/results-2026";
import {
  assetPrices,
  assetScoreLines,
  assetSessionTotals,
  auditLog,
  drivers,
  gameEvents,
  games,
  leagueStandings,
  lineupVersions,
  priceUpdateRuns,
  reviewItems,
  rulesetVersions,
  scoringRules,
  scoringRuns,
  sessionResultState,
  teamAdjustmentLines,
  teamEventStates,
  teamEventTotals,
  teams,
} from "@/db/schema";
import { gameChecksKey, scoreKey } from "@/jobs/kinds";
import { enqueue } from "@/jobs/queue";
import { runDue } from "@/jobs/runner";
import { simulatedClock } from "@/lib/clock";
import { newId } from "@/lib/ids";
import { createLeague, joinLeague } from "@/leagues/leagues";
import { recomputeStandings } from "@/leagues/standings";
import { setSimulatedClock } from "@/replay/clock-loop";
import { addOverride } from "@/results/overrides";
import { advanceStatus } from "@/results/status";
import { ENGINE_VERSION } from "@/scoring/engine";
import { SCORING_RULES_2026, type ScoringRule } from "@/scoring/rules";
import type { StaffActor } from "@/staff/roster";
import {
  approveRescore,
  checkScoreExplanations,
  createGameChecksHandler,
  dryRunGame,
  publishCorrectionVersion,
  pruneLineupVersions,
} from "./corrections";
import { saveFinalFix } from "./chips";
import { GameError } from "./errors";
import { planGameEvents } from "./games";
import { checkGameInvariants } from "./invariants";
import { openGame, saveLineup, type LineupPick } from "./lineups";
import { RULESET_2026 } from "./ruleset";
import {
  createScoreHandlers,
  enqueueScoring,
  finalizeGameEvent,
} from "./score-jobs";
import { startRun, writeAssetLines } from "./scoring-runs";
import { createTeam } from "./teams";

// Corrections (DM 4.9) and the daily checks (DM 4.8, 3.7), over the recorded
// 2026 game: teams A and B locked into round 1, whose race is scored through
// the real jobs. Round 2 is a sprint weekend, for two scored sessions.

const NOW = new Date("2026-02-01T09:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const LEASE = 300_000;
const ACTOR: StaffActor = { kind: "admin", label: "staff" };
// 280 + 250 + 95 + 85 + 80 + 90 + 70 = 950, leaving 50 in the bank.
const DRIVERS = ["norris", "piastri", "hulkenberg", "hadjar", "bearman"];
const CONSTRUCTORS = ["haas", "audi"];
const SETTING = "gridlocked.ruleset_correction";

/** The 2026 rules with `extra` more points for every scoring race position. */
const rulesWorth = (extra: number) =>
  SCORING_RULES_2026.map((rule): ScoringRule =>
    rule.code === "race.position" && rule.kind === "position_table"
      ? {
          ...rule,
          params: {
            points: [25, 18, 15, 12, 10, 8, 6, 4, 2, 1].map((p) => p + extra),
          },
        }
      : rule,
  );

describe("corrections and the daily checks (DM 4.8, 4.9, 3.7)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let game: Awaited<ReturnType<typeof seedGame2026>>;
  let gameId: string;
  let round1: { id: string; lockAt: Date };
  let round2: { id: string; lockAt: Date };
  let race: { id: string; scheduledEnd: Date };
  let scoredAt: Date;
  let teamA: string;
  let teamB: string;
  const users = new Map<string, string>();
  const clock = simulatedClock(NOW);

  async function at(instant: Date) {
    clock.set(instant);
    await setSimulatedClock(t.db, instant);
  }
  const team = async (name: string) => {
    const userId = newId();
    const id = await createTeam(t.db, NOW, { gameId, userId, name });
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
  const run = (maxJobs = 50) =>
    runDue(t.db, clock, createScoreHandlers(), { maxJobs, leaseMs: LEASE });
  /** Results for the session, moved on and scored through the jobs. */
  async function score(
    session: { id: string },
    kind: "race" | "sprint",
    file: string,
  ) {
    await ingest(t.db, clock.now(), session.id, kind, loadBody(file));
    const { resultsVersion } = await advanceStatus(
      t.db,
      clock.now(),
      session.id,
    );
    await enqueueScoring(t.db, clock.now(), {
      sessionId: session.id,
      stamp: `v${resultsVersion}`,
      trigger: "results",
    });
    expect(await run()).toMatchObject({ failed: 0 });
  }
  const driverOf = async (slug: string) =>
    (
      await t.db
        .select({ id: drivers.id })
        .from(drivers)
        .where(eq(drivers.slug, slug))
    )[0]!.id;
  /** A result change nothing has re-scored yet: the current lines are stale. */
  const override = async (sessionId: string, driver = "norris") =>
    addOverride(t.db, clock.now(), {
      sessionId,
      driverId: await driverOf(driver),
      kind: "patch",
      fields: { classification: "disqualified", position: null },
      reason: "Stewards",
      createdBy: newId(),
    });

  const gameEvent = async (eventId: string) =>
    (
      await t.db
        .select()
        .from(gameEvents)
        .where(
          and(eq(gameEvents.gameId, gameId), eq(gameEvents.eventId, eventId)),
        )
    )[0]!;
  const totalsOf = async (eventId: string) =>
    new Map(
      (
        await t.db
          .select()
          .from(teamEventTotals)
          .where(eq(teamEventTotals.eventId, eventId))
      ).map((row) => [row.teamId, row]),
    );
  const pointsOf = async (eventId: string) =>
    new Map(
      [...(await totalsOf(eventId))].map(([teamId, row]) => [
        teamId,
        row.points,
      ]),
    );
  const versions = () =>
    t.db
      .select()
      .from(rulesetVersions)
      .where(eq(rulesetVersions.gameId, gameId))
      .orderBy(asc(rulesetVersions.version));
  const audits = (action: string) =>
    t.db.select().from(auditLog).where(eq(auditLog.action, action));
  const scoreJobs = async () =>
    (await allJobs(t.db)).filter((j) => j.kind === "score_session");
  const runsOf = (sessionId: string) =>
    t.db
      .select()
      .from(scoringRuns)
      .where(eq(scoringRuns.sessionId, sessionId))
      .orderBy(asc(scoringRuns.id));
  const repoint = (eventId: string, rulesetVersionId: string) =>
    t.db
      .update(gameEvents)
      .set({ rulesetVersionId })
      .where(
        and(eq(gameEvents.gameId, gameId), eq(gameEvents.eventId, eventId)),
      );
  const publish = (
    eventIds: string[],
    rules = rulesWorth(5),
    db: typeof t.db = t.db,
  ) =>
    publishCorrectionVersion(db, clock.now(), ACTOR, {
      gameId,
      params: RULESET_2026,
      rules,
      notes: "The winner's points were wrong.",
      eventIds,
      reason: "A wrong points table",
    });
  const dryRun = (batchSize?: number) =>
    dryRunGame(t.db, clock.now(), ACTOR, {
      gameId,
      reason: "Engine 2026.2",
      batchSize,
    });
  const items = (kind: string) =>
    t.db.select().from(reviewItems).where(eq(reviewItems.kind, kind));
  const breakTotal = (eventId: string, points: number, teamId = teamA) =>
    t.db
      .update(teamEventTotals)
      .set({ points })
      .where(
        and(
          eq(teamEventTotals.teamId, teamId),
          eq(teamEventTotals.eventId, eventId),
        ),
      );
  /** A version with no picks and any `savedAt`, past the save checks. */
  async function versionFor(teamId: string, eventId: string, savedAt: Date) {
    const id = newId();
    await t.db.execute(sql`alter table lineup_versions disable trigger user`);
    await t.db.insert(lineupVersions).values({
      id,
      teamId,
      forEventId: eventId,
      kind: "regular",
      savedAt,
    });
    await t.db.execute(sql`alter table lineup_versions enable trigger user`);
    return id;
  }
  /** Round 2 opened and locked with the lineups carried, then scored. */
  async function secondRound() {
    const opened = new Date(round1.lockAt.getTime() + HOUR);
    await setSimulatedClock(t.db, opened);
    await openRound(t.db, opened, gameId, round2.id);
    await lockRound(t.db, gameId, round2.id);
    const sprint = await sessionOf(t.db, round2.id, "sprint");
    const race2 = await sessionOf(t.db, round2.id, "race");
    await at(new Date(race2.scheduledEnd.getTime() + HOUR));
    await score(sprint, "sprint", "jolpica/2026/r02-sprint.json");
    await score(race2, "race", "jolpica/2026/r02-results.json");
    return { sprint, race: race2 };
  }

  beforeEach(async () => {
    t = await createTestDb();
    users.clear();
    await at(NOW);
    game = await seedGame2026(t.db, NOW);
    gameId = game.gameId;
    round1 = await round2026(t.db, 1);
    round2 = await round2026(t.db, 2);
    await openGame(t.db, NOW, gameId);
    teamA = await team("A");
    teamB = await team("B");
    await saveLineup(t.db, NOW, {
      teamId: teamA,
      picks: await picksOf("norris"),
      basedOnVersionId: null,
    });
    await saveLineup(t.db, NOW, {
      teamId: teamB,
      picks: await picksOf("hadjar"),
      basedOnVersionId: null,
    });
    await lockRound(t.db, gameId, round1.id);
    race = await sessionOf(t.db, round1.id, "race");
    scoredAt = new Date(race.scheduledEnd.getTime() + HOUR);
    await at(scoredAt);
    await score(race, "race", "jolpica/2026/r01-results.json");
  });
  afterEach(async () => {
    await t.close();
  });

  describe("publishCorrectionVersion", () => {
    it("a correction version re-scores the re-pointed events, and is audited", async () => {
      const assetPoints = async () =>
        new Map(
          (
            await t.db
              .select()
              .from(assetSessionTotals)
              .where(eq(assetSessionTotals.sessionId, race.id))
          ).map((row) => [row.assetId, row.points]),
        );
      const pointsBefore = await pointsOf(round1.id);
      const assetsBefore = await assetPoints();
      const [old] = await versions();

      const { rulesetVersionId } = await publish([round1.id]);

      const [, version] = await versions();
      expect(version).toMatchObject({
        id: rulesetVersionId,
        version: 2,
        isCorrection: true,
        effectiveFromEventId: round1.id,
        notes: "The winner's points were wrong.",
        publishedAt: scoredAt,
      });
      expect(
        await t.db
          .select()
          .from(scoringRules)
          .where(eq(scoringRules.rulesetVersionId, rulesetVersionId)),
      ).toHaveLength(SCORING_RULES_2026.length);
      expect(await gameEvent(round1.id)).toMatchObject({
        rulesetVersionId,
        status: "scored",
        updatedAt: scoredAt,
      });

      const [entry] = await audits("ruleset_version.correct");
      expect(entry).toMatchObject({
        actorKind: "admin",
        actorLabel: "staff",
        reason: "A wrong points table",
        entityType: "ruleset_version",
        entityId: rulesetVersionId,
        before: {
          gameId,
          events: [{ eventId: round1.id, rulesetVersionId: old!.id }],
        },
        after: { gameId, version: 2, eventIds: [round1.id] },
      });
      // One job: the race. Practice and the qualifying with no results queue none.
      const queued = (await scoreJobs()).filter((j) => j.status === "pending");
      expect(queued).toMatchObject([
        {
          dedupeKey: scoreKey(gameId, race.id, `c:${entry!.id}`),
          payload: {
            gameId,
            sessionId: race.id,
            trigger: "ruleset_correction",
            step: "assets",
          },
        },
      ]);

      expect(await run()).toMatchObject({ failed: 0 });
      const [, rerun] = await runsOf(race.id);
      expect(rerun).toMatchObject({
        rulesetVersionId,
        trigger: "ruleset_correction",
        status: "succeeded",
        isCurrent: true,
      });

      // Team A's lineup plus its Boost on Norris, at the new points.
      const assetsAfter = await assetPoints();
      const change = (assetId: string) =>
        (assetsAfter.get(assetId) ?? 0) - (assetsBefore.get(assetId) ?? 0);
      const picks = await picksOf("norris");
      const expected =
        picks.reduce((sum, p) => sum + change(p.assetId), 0) +
        change(await game.assetId("norris"));
      expect(expected).toBeGreaterThan(0);
      const pointsAfter = await pointsOf(round1.id);
      expect(pointsAfter.get(teamA)).toBe(pointsBefore.get(teamA)! + expected);
    });

    it("re-pointing a locked event outside a correction is still refused", async () => {
      const id = newId();
      await t.db.insert(rulesetVersions).values({
        id,
        gameId,
        version: 2,
        effectiveFromEventId: round2.id,
        params: RULESET_2026,
        notes: "A version",
        publishedAt: scoredAt,
        createdAt: scoredAt,
        updatedAt: scoredAt,
      });
      await expect(repoint(round1.id, id)).rejects.toThrow();
      expect((await gameEvent(round1.id)).rulesetVersionId).not.toBe(id);

      // Set to anything else, the setting opens nothing.
      await expect(
        t.db.transaction(async (tx) => {
          await tx.execute(sql`select set_config(${SETTING}, 'off', true)`);
          await tx
            .update(gameEvents)
            .set({ rulesetVersionId: id })
            .where(
              and(
                eq(gameEvents.gameId, gameId),
                eq(gameEvents.eventId, round1.id),
              ),
            );
        }),
      ).rejects.toThrow();

      // An event that hasn't locked moves freely: planning does that.
      await repoint(round2.id, id);
      expect((await gameEvent(round2.id)).rulesetVersionId).toBe(id);
    });

    it("a correction keeps the lock records' version", async () => {
      const [old] = await versions();
      const { rulesetVersionId } = await publish([round1.id]);
      await run();
      const states = await t.db
        .select()
        .from(teamEventStates)
        .where(eq(teamEventStates.eventId, round1.id));
      expect(states).toHaveLength(2);
      for (const state of states) {
        expect(state.rulesetVersionId).toBe(old!.id);
        expect(state.rulesetVersionId).not.toBe(rulesetVersionId);
      }
    });

    it("the invariants hold after a correction", async () => {
      const params = {
        ...RULESET_2026,
        transfers: { ...RULESET_2026.transfers, freePerEvent: 3 },
      };
      await publishCorrectionVersion(t.db, clock.now(), ACTOR, {
        gameId,
        params,
        rules: rulesWorth(5),
        notes: "Notes",
        eventIds: [round1.id],
        reason: "A reason",
      });
      await run();
      expect(await checkGameInvariants(t.db, gameId)).toEqual([]);
    });

    it("a lock record on a correction version is flagged", async () => {
      const { rulesetVersionId } = await publish([round1.id]);
      await run();
      await t.db
        .update(teamEventStates)
        .set({ rulesetVersionId })
        .where(eq(teamEventStates.eventId, round1.id));

      const found = await checkGameInvariants(t.db, gameId);

      expect(found).toHaveLength(2);
      for (const message of found) {
        expect(message).toContain("correction version");
      }
    });

    describe("the old version stays frozen after the re-point", () => {
      const refusesEdits = async (versionId: string) => {
        await expect(
          t.db
            .update(scoringRules)
            .set({ sortOrder: 999 })
            .where(eq(scoringRules.rulesetVersionId, versionId)),
        ).rejects.toThrow();
        await expect(
          t.db
            .update(rulesetVersions)
            .set({ notes: "Rewritten" })
            .where(eq(rulesetVersions.id, versionId)),
        ).rejects.toThrow();
      };

      it("with both its lock records and its runs citing it", async () => {
        const [old] = await versions();
        await publish([round1.id]);
        await run();
        await refusesEdits(old!.id);
      });

      it("cited only by a lock record", async () => {
        const [old] = await versions();
        const { rulesetVersionId } = await publish([round1.id]);
        await run();
        await t.db.update(scoringRuns).set({ rulesetVersionId });
        await refusesEdits(old!.id);
      });

      it("cited only by a run", async () => {
        const [old] = await versions();
        const { rulesetVersionId } = await publish([round1.id]);
        await run();
        await t.db.update(teamEventStates).set({ rulesetVersionId });
        await refusesEdits(old!.id);
      });
    });

    describe("a correction's teamsPerUser reaches no one", () => {
      const withLimit = (teamsPerUser: number) =>
        publishCorrectionVersion(t.db, clock.now(), ACTOR, {
          gameId,
          params: { ...RULESET_2026, teamsPerUser },
          rules: rulesWorth(5),
          notes: "Notes",
          eventIds: [round1.id],
          reason: "A reason",
        });
      /** A row straight into the table, past `createTeam`, for the trigger. */
      const insertTeam = (userId: string, slot: number) =>
        t.db.insert(teams).values({
          id: newId(),
          gameId,
          userId,
          slot,
          name: `Slot ${slot}`,
          status: "active",
          createdAt: clock.now(),
        });
      const create = (userId: string, name: string) =>
        createTeam(t.db, clock.now(), { gameId, userId, name });

      it("a higher limit opens no slot in createTeam", async () => {
        await withLimit(5);
        const userId = newId();
        for (const name of ["One", "Two", "Three"]) {
          await create(userId, name);
        }
        await expect(create(userId, "Four")).rejects.toMatchObject({
          code: "no_free_slot",
        });
      });

      it("a higher limit opens no slot in the trigger", async () => {
        await withLimit(5);
        await expect(insertTeam(newId(), 4)).rejects.toThrow();
      });

      it("a lower limit closes no slot in createTeam or the trigger", async () => {
        await withLimit(1);
        const userId = newId();
        await create(userId, "One");
        await create(userId, "Two");
        await insertTeam(userId, 3);
      });
    });

    it("the correction setting doesn't outlive its update or its transaction", async () => {
      const { rulesetVersionId } = await publish([round1.id]);
      const read = async (db: typeof t.db) =>
        (
          (await db.execute(
            sql`select current_setting(${SETTING}, true) as value`,
          )) as unknown as { rows: { value: string | null }[] }
        ).rows[0]!.value;
      expect(await read(t.db)).not.toBe("on");
      const [first] = await versions();
      await expect(repoint(round1.id, first!.id)).rejects.toThrow();
      expect((await gameEvent(round1.id)).rulesetVersionId).toBe(
        rulesetVersionId,
      );

      // Nested in a caller's transaction, it is off again straight after.
      await t.db.transaction(async (tx) => {
        await publish([round1.id], rulesWorth(6), tx);
        expect(await read(tx)).not.toBe("on");
      });
      expect(await read(t.db)).not.toBe("on");
    });

    it("only the listed events move, and planning leaves them where they are", async () => {
      await secondRound();
      const [first] = await versions();

      const { rulesetVersionId } = await publish([round1.id]);
      expect((await gameEvent(round2.id)).rulesetVersionId).toBe(first!.id);
      const round3 = await round2026(t.db, 3);
      expect((await gameEvent(round3.id)).rulesetVersionId).toBe(first!.id);

      await planGameEvents(t.db, clock.now(), gameId);

      expect((await gameEvent(round1.id)).rulesetVersionId).toBe(
        rulesetVersionId,
      );
      expect((await gameEvent(round2.id)).rulesetVersionId).toBe(first!.id);
      expect((await gameEvent(round3.id)).rulesetVersionId).toBe(first!.id);
      expect(await items("ruleset_version_refused")).toEqual([]);
    });

    it("re-scores every scored session of the listed events", async () => {
      const { sprint, race: race2 } = await secondRound();
      await publish([round1.id, round2.id]);
      const queued = (await scoreJobs()).filter((j) => j.status === "pending");
      expect(
        queued
          .map((j) => (j.payload as { sessionId: string }).sessionId)
          .sort(),
      ).toEqual([race.id, sprint.id, race2.id].sort());
      // Its first event by sequence.
      const [, version] = await versions();
      expect(version!.effectiveFromEventId).toBe(round1.id);
    });

    it("a correction after prices moved changes points and not prices", async () => {
      await finalizeGameEvent(t.db, clock.now(), {
        gameId,
        eventId: round1.id,
      });
      expect((await gameEvent(round1.id)).status).toBe("final");
      const prices = () =>
        t.db
          .select()
          .from(assetPrices)
          .where(eq(assetPrices.eventId, round2.id))
          .orderBy(asc(assetPrices.assetId));
      const formula = await prices();
      expect(formula.some((p) => p.source === "formula")).toBe(true);
      const updates = await t.db.select().from(priceUpdateRuns);
      const before = await pointsOf(round1.id);

      await publish([round1.id], rulesWorth(-1));
      await run();

      expect(await prices()).toEqual(formula);
      expect(await t.db.select().from(priceUpdateRuns)).toEqual(updates);
      expect(await gameEvent(round1.id)).toMatchObject({ status: "final" });
      const totals = await totalsOf(round1.id);
      expect([...totals.values()].every((r) => r.status === "final")).toBe(
        true,
      );
      expect((await pointsOf(round1.id)).get(teamA)).toBeLessThan(
        before.get(teamA)!,
      );
    });

    describe("refusals write nothing", () => {
      const nothingWritten = async () => {
        expect(await versions()).toHaveLength(1);
        expect(await audits("ruleset_version.correct")).toEqual([]);
        expect((await scoreJobs()).every((j) => j.status !== "pending")).toBe(
          true,
        );
      };

      it("an event that hasn't locked", async () => {
        await expect(publish([round1.id, round2.id])).rejects.toThrow(
          /upcoming/,
        );
        await nothingWritten();
        const [first] = await versions();
        expect((await gameEvent(round1.id)).rulesetVersionId).toBe(first!.id);
      });

      it("a cancelled event", async () => {
        await t.db
          .update(gameEvents)
          .set({ status: "cancelled", sequence: null })
          .where(
            and(
              eq(gameEvents.gameId, gameId),
              eq(gameEvents.eventId, round2.id),
            ),
          );
        await expect(publish([round2.id])).rejects.toThrow(/cancelled/);
        await nothingWritten();
      });

      it("an event that isn't the game's", async () => {
        await expect(publish([newId()])).rejects.toThrow(/not in game/);
        await nothingWritten();
      });

      it("an empty list", async () => {
        await expect(publish([])).rejects.toThrow(/no events/);
        await nothingWritten();
      });

      it("empty rules, which would wipe the events' points", async () => {
        await expect(publish([round1.id], [])).rejects.toThrow(/no rules/);
        await nothingWritten();
      });

      it("a game that isn't running, which nothing would re-score", async () => {
        await t.db
          .update(games)
          .set({ status: "completed" })
          .where(eq(games.id, gameId));
        const refused = await publish([round1.id]).catch((e: unknown) => e);
        expect(refused).toBeInstanceOf(GameError);
        expect(refused).toMatchObject({ code: "game_not_running" });
        await nothingWritten();
        const [first] = await versions();
        expect((await gameEvent(round1.id)).rulesetVersionId).toBe(first!.id);
      });

      it("a blank reason", async () => {
        await expect(
          publishCorrectionVersion(t.db, clock.now(), ACTOR, {
            gameId,
            params: RULESET_2026,
            rules: SCORING_RULES_2026,
            notes: "Notes",
            eventIds: [round1.id],
            reason: "  ",
          }),
        ).rejects.toThrow(/reason/);
        await nothingWritten();
      });
    });
  });

  describe("dryRunGame", () => {
    /** What a dry run must leave exactly as it was. */
    const ledger = async () => ({
      lines: await t.db
        .select()
        .from(assetScoreLines)
        .orderBy(asc(assetScoreLines.id)),
      adjustments: await t.db
        .select()
        .from(teamAdjustmentLines)
        .orderBy(asc(teamAdjustmentLines.id)),
      totals: await t.db
        .select()
        .from(teamEventTotals)
        .orderBy(asc(teamEventTotals.teamId)),
      current: (await t.db.select().from(scoringRuns))
        .filter((r) => r.isCurrent)
        .map((r) => r.id),
    });
    /** The re-score of a session the dry run forecast. */
    const liveRescore = async (sessionId: string) => {
      await enqueueScoring(t.db, clock.now(), {
        sessionId,
        stamp: `test:${newId()}`,
        trigger: "override",
      });
      expect(await run()).toMatchObject({ failed: 0 });
    };

    it("a dry run writes no lines and reports the changes", async () => {
      await override(race.id);
      const before = await ledger();
      const points = await pointsOf(round1.id);

      const report = await dryRun();

      expect(await ledger()).toEqual(before);
      const [, dry] = await runsOf(race.id);
      expect(report).toMatchObject({
        runIds: [dry!.id],
        sessions: 1,
        teamsChanged: 2,
      });
      expect(report.assetsChanged).toBeGreaterThan(0);
      expect(dry).toMatchObject({
        mode: "dry_run",
        status: "succeeded",
        isCurrent: false,
        trigger: "admin",
        engineVersion: ENGINE_VERSION,
        finishedAt: scoredAt,
        diffSummary: {
          previousRunId: (await runsOf(race.id))[0]!.id,
          assetsChanged: report.assetsChanged,
          teamsChanged: 2,
        },
      });
      expect(dry!.diffSummary).not.toHaveProperty("teamsThrough");
      expect(dry!.inputs).not.toBeNull();

      const teams = report.biggest.filter((c) => c.kind === "team");
      expect(teams.map((c) => c.id).sort()).toEqual([teamA, teamB].sort());
      for (const change of teams) {
        expect(change.before).toBe(points.get(change.id));
        expect(change.change).toBe(change.after - change.before);
      }

      const [entry] = await audits("game.dry_run");
      expect(entry).toMatchObject({
        reason: "Engine 2026.2",
        entityType: "game",
        entityId: gameId,
        after: { engineVersion: ENGINE_VERSION, runIds: report.runIds },
      });

      // The forecast is what the live re-score then does.
      await liveRescore(race.id);
      const after = await pointsOf(round1.id);
      for (const change of teams) {
        expect(after.get(change.id)).toBe(change.after);
      }
    });

    it("a dry run with nothing to change reports nothing", async () => {
      expect(await dryRun()).toMatchObject({
        sessions: 1,
        assetsChanged: 0,
        teamsChanged: 0,
        biggest: [],
      });
    });

    it("compares against the stored totals", async () => {
      await breakTotal(round1.id, 7);
      const report = await dryRun();
      expect(report).toMatchObject({ assetsChanged: 0, teamsChanged: 1 });
      expect(report.biggest).toMatchObject([
        { kind: "team", id: teamA, before: 7 },
      ]);
    });

    it("batches give the same answer", async () => {
      await override(race.id);
      const whole = await dryRun();
      const batched = await dryRun(1);
      expect(batched).toMatchObject({
        assetsChanged: whole.assetsChanged,
        teamsChanged: whole.teamsChanged,
        biggest: whole.biggest,
      });
    });

    it("a weekend's team changes add up over its sessions", async () => {
      const { sprint, race: race2 } = await secondRound();
      await override(sprint.id);
      await override(race2.id, "bearman");
      const before = await pointsOf(round2.id);

      const report = await dryRun();

      expect(report.sessions).toBe(3);
      const diffOf = async (sessionId: string) =>
        (await runsOf(sessionId)).find((r) => r.mode === "dry_run")!
          .diffSummary as {
          biggest: {
            kind: string;
            id: string;
            before: number;
            after: number;
          }[];
        };
      const forecast = new Map(before);
      for (const session of [sprint, race2]) {
        const { biggest } = await diffOf(session.id);
        const changes = biggest.filter((c) => c.kind === "team");
        expect(changes.length).toBeGreaterThan(0);
        for (const change of changes) {
          expect(change.before).toBe(forecast.get(change.id));
          forecast.set(change.id, change.after);
        }
      }

      await liveRescore(sprint.id);
      await liveRescore(race2.id);
      expect(await pointsOf(round2.id)).toEqual(forecast);
    });

    it("scores a session with results and no live run yet", async () => {
      const sprint = await sessionOf(t.db, round2.id, "sprint");
      const opened = new Date(round1.lockAt.getTime() + HOUR);
      await setSimulatedClock(t.db, opened);
      await openRound(t.db, opened, gameId, round2.id);
      await lockRound(t.db, gameId, round2.id);
      await at(new Date(sprint.scheduledEnd.getTime() + HOUR));
      await ingest(
        t.db,
        clock.now(),
        sprint.id,
        "sprint",
        loadBody("jolpica/2026/r02-sprint.json"),
      );
      await advanceStatus(t.db, clock.now(), sprint.id);

      const report = await dryRun();

      expect(report.sessions).toBe(2);
      expect(report.teamsChanged).toBe(2);
      expect(
        await t.db
          .select()
          .from(assetScoreLines)
          .where(eq(assetScoreLines.sessionId, sprint.id)),
      ).toEqual([]);
      expect(await pointsOf(round2.id)).toEqual(new Map());
    });

    it("skips a session with no results", async () => {
      await t.db
        .delete(sessionResultState)
        .where(eq(sessionResultState.sessionId, race.id));
      const report = await dryRun();
      expect(report).toMatchObject({ runIds: [], sessions: 0 });
    });

    it("a dry run leaves a running live run alone", async () => {
      await override(race.id);
      const started = await startRun(t.db, clock.now(), {
        gameId,
        sessionId: race.id,
        trigger: "override",
        mode: "live",
      });
      if (!("runId" in started)) throw new Error("skipped");
      expect(await writeAssetLines(t.db, clock.now(), started.runId)).toBe(
        "written",
      );

      await dryRun();

      const live = (await runsOf(race.id)).find((r) => r.id === started.runId);
      expect(live).toMatchObject({
        status: "running",
        isCurrent: true,
        finishedAt: null,
      });
    });

    it("a blank reason writes nothing", async () => {
      await expect(
        dryRunGame(t.db, clock.now(), ACTOR, { gameId, reason: " " }),
      ).rejects.toThrow(/reason/);
      expect(await runsOf(race.id)).toHaveLength(1);
      expect(await audits("game.dry_run")).toEqual([]);
    });
  });

  describe("approveRescore", () => {
    const approve = () =>
      approveRescore(t.db, clock.now(), ACTOR, {
        gameId,
        reason: "The dry run looks right",
      });

    it("approving re-scores the season", async () => {
      const { sprint, race: race2 } = await secondRound();
      await dryRun();

      expect(await approve()).toEqual({ queued: 3 });

      const [entry] = await audits("game.rescore_approved");
      expect(entry).toMatchObject({
        reason: "The dry run looks right",
        entityType: "game",
        entityId: gameId,
        after: { engineVersion: ENGINE_VERSION },
      });
      const queued = (await scoreJobs()).filter((j) => j.status === "pending");
      expect(queued.map((j) => j.dedupeKey).sort()).toEqual(
        [race.id, sprint.id, race2.id]
          .map((id) => scoreKey(gameId, id, `r:${entry!.id}`))
          .sort(),
      );
      for (const job of queued) {
        expect(job.payload).toMatchObject({
          trigger: "engine_change",
          force: true,
          step: "assets",
        });
      }

      // The inputs haven't changed: only the force gets past the fingerprint.
      expect(await run()).toMatchObject({ failed: 0 });
      for (const id of [race.id, sprint.id, race2.id]) {
        const current = (await runsOf(id)).find((r) => r.isCurrent);
        expect(current).toMatchObject({
          trigger: "engine_change",
          mode: "live",
          status: "succeeded",
        });
      }
    });

    it("is refused with no dry run", async () => {
      const refused = await approve().catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(GameError);
      expect(refused).toMatchObject({ code: "dry_run_required" });
      expect(await audits("game.rescore_approved")).toEqual([]);
      expect((await scoreJobs()).every((j) => j.status !== "pending")).toBe(
        true,
      );
    });

    it("is refused with a dry run of an older engine", async () => {
      await dryRun();
      await t.db
        .update(scoringRuns)
        .set({ engineVersion: "2025.9" })
        .where(eq(scoringRuns.mode, "dry_run"));
      await expect(approve()).rejects.toMatchObject({
        code: "dry_run_required",
      });
    });

    it("is refused when the dry run didn't finish", async () => {
      await startRun(t.db, clock.now(), {
        gameId,
        sessionId: race.id,
        trigger: "admin",
        mode: "dry_run",
      });
      await expect(approve()).rejects.toMatchObject({
        code: "dry_run_required",
      });
    });

    it("a blank reason writes nothing", async () => {
      await dryRun();
      await expect(
        approveRescore(t.db, clock.now(), ACTOR, { gameId, reason: "" }),
      ).rejects.toThrow(/reason/);
      expect(await audits("game.rescore_approved")).toEqual([]);
    });
  });

  describe("checkScoreExplanations", () => {
    const check = () => checkScoreExplanations(t.db, clock.now(), { gameId });

    it("a clean game passes", async () => {
      expect(await check()).toEqual({ mismatches: 0, events: [] });
      expect(await items("score_mismatch")).toEqual([]);
    });

    it("a hand-broken total opens score_mismatch and is rebuilt", async () => {
      const points = await pointsOf(round1.id);
      await breakTotal(round1.id, points.get(teamA)! + 3);

      expect(await check()).toEqual({ mismatches: 1, events: [round1.id] });

      expect(await pointsOf(round1.id)).toEqual(points);
      expect(await items("score_mismatch")).toMatchObject([
        {
          severity: "blocking",
          status: "open",
          eventId: round1.id,
          dedupeKey: `score_mismatch:${gameId}:${round1.id}`,
          details: {
            gameId,
            teams: [
              {
                teamId: teamA,
                stored: points.get(teamA)! + 3,
                explained: points.get(teamA),
              },
            ],
          },
        },
      ]);
    });

    it("rebuilds the standings too", async () => {
      const { leagueId, joinCode } = await createLeague(t.db, clock.now(), {
        gameId,
        ownerUserId: newId(),
        kind: "private",
        name: "League",
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
      const standings = () =>
        t.db
          .select()
          .from(leagueStandings)
          .where(eq(leagueStandings.leagueId, leagueId))
          .orderBy(asc(leagueStandings.teamId));
      const right = (await standings()).map((r) => r.points);
      expect(right).toHaveLength(2);
      await t.db
        .update(leagueStandings)
        .set({ points: 9999 })
        .where(eq(leagueStandings.leagueId, leagueId));
      await breakTotal(round1.id, 1234);

      await check();

      expect((await standings()).map((r) => r.points)).toEqual(right);
    });

    it("rebuilds every event it finds wrong, not just the earliest", async () => {
      await secondRound();
      const first = await pointsOf(round1.id);
      const second = await pointsOf(round2.id);
      await breakTotal(round1.id, 1234);
      await breakTotal(round2.id, 4321);

      expect(await check()).toEqual({
        mismatches: 2,
        events: [round1.id, round2.id],
      });

      expect(await pointsOf(round1.id)).toEqual(first);
      expect(await pointsOf(round2.id)).toEqual(second);
      expect(await items("score_mismatch")).toHaveLength(2);
    });

    it("a repeat of an open mismatch adds no item, and one after it is resolved does", async () => {
      await breakTotal(round1.id, 1234);
      await check();
      await breakTotal(round1.id, 1234);
      await check();
      expect(await items("score_mismatch")).toHaveLength(1);

      await t.db
        .update(reviewItems)
        .set({ status: "resolved" })
        .where(eq(reviewItems.kind, "score_mismatch"));
      await breakTotal(round1.id, 1234);
      await check();
      const all = await items("score_mismatch");
      expect(all.map((i) => i.status).sort()).toEqual(["open", "resolved"]);
    });

    it("skips an event with a live run in flight", async () => {
      await override(race.id);
      const started = await startRun(t.db, clock.now(), {
        gameId,
        sessionId: race.id,
        trigger: "override",
        mode: "live",
      });
      if (!("runId" in started)) throw new Error("skipped");
      expect(await writeAssetLines(t.db, clock.now(), started.runId)).toBe(
        "written",
      );
      const stored = await pointsOf(round1.id);

      expect(await check()).toEqual({ mismatches: 0, events: [] });

      expect(await items("score_mismatch")).toEqual([]);
      expect(await pointsOf(round1.id)).toEqual(stored);
    });

    it("a dry run in flight doesn't hide a mismatch", async () => {
      await startRun(t.db, clock.now(), {
        gameId,
        sessionId: race.id,
        trigger: "admin",
        mode: "dry_run",
      });
      await breakTotal(round1.id, 1234);
      expect(await check()).toMatchObject({ mismatches: 1 });
    });

    it("skips a cancelled event", async () => {
      await breakTotal(round1.id, 1234);
      await t.db
        .update(gameEvents)
        .set({ status: "cancelled", sequence: null })
        .where(
          and(eq(gameEvents.gameId, gameId), eq(gameEvents.eventId, round1.id)),
        );
      expect(await check()).toEqual({ mismatches: 0, events: [] });
    });

    it("finds a total that has gone missing", async () => {
      const points = await pointsOf(round1.id);
      await t.db
        .delete(teamEventTotals)
        .where(eq(teamEventTotals.teamId, teamA));
      expect(await check()).toMatchObject({ mismatches: 1 });
      expect(await pointsOf(round1.id)).toEqual(points);
    });

    it("checks only a sample of teams", async () => {
      await breakTotal(round1.id, 1234, teamA);
      await breakTotal(round1.id, 1234, teamB);
      expect(
        await checkScoreExplanations(t.db, clock.now(), { gameId, sample: 1 }),
      ).toMatchObject({ mismatches: 1 });
    });
  });

  describe("pruneLineupVersions", () => {
    let older: string;
    let middle: string;
    let locked: string;
    let teamC: string;
    const prune = (now: Date) => pruneLineupVersions(t.db, now, { gameId });
    const versionsOf = async (teamId: string) =>
      (
        await t.db
          .select()
          .from(lineupVersions)
          .where(eq(lineupVersions.teamId, teamId))
      ).map((v) => v.id);
    const sevenDaysOn = () => new Date(scoredAt.getTime() + 7 * DAY);

    // Three saves by team C for round 2, which it locks with the last.
    beforeEach(async () => {
      const opened = new Date(round1.lockAt.getTime() + HOUR);
      await at(opened);
      await openRound(t.db, opened, gameId, round2.id);
      teamC = await team("C");
      const save = async (boost: string, based: string | null) => {
        const { versionId } = await saveLineup(t.db, clock.now(), {
          teamId: teamC,
          picks: await picksOf(boost),
          basedOnVersionId: based,
        });
        return versionId;
      };
      older = await save("norris", null);
      await at(new Date(opened.getTime() + 1000));
      middle = await save("piastri", older);
      await at(new Date(opened.getTime() + 2000));
      locked = await save("hadjar", middle);
      await lockRound(t.db, gameId, round2.id);
      await t.db
        .update(gameEvents)
        .set({ status: "final", updatedAt: scoredAt })
        .where(
          and(eq(gameEvents.gameId, gameId), eq(gameEvents.eventId, round2.id)),
        );
    });

    it("pruning keeps every version a lock record uses", async () => {
      expect(await prune(sevenDaysOn())).toEqual({ deleted: 2 });
      expect(await versionsOf(teamC)).toEqual([locked]);
      // Team A's and B's single versions are its locked ones.
      expect(await versionsOf(teamA)).toHaveLength(1);
      expect(await versionsOf(teamB)).toHaveLength(1);
      // The kept version's base went: the link is nulled, nothing else.
      const [kept] = await t.db
        .select()
        .from(lineupVersions)
        .where(eq(lineupVersions.id, locked));
      expect(kept!.basedOnVersionId).toBeNull();
      expect(await checkGameInvariants(t.db, gameId)).toEqual([]);
    });

    it.each(["baseVersionId", "lockedVersionId"] as const)(
      "keeps a version %s points to",
      async (column) => {
        await t.db
          .update(teamEventStates)
          .set({ [column]: older })
          .where(
            and(
              eq(teamEventStates.teamId, teamC),
              eq(teamEventStates.eventId, round2.id),
            ),
          );
        await prune(sevenDaysOn());
        expect((await versionsOf(teamC)).sort()).toEqual(
          [older, locked].sort(),
        );
      },
    );

    it("keeps a Late Call version that isn't the team's newest", async () => {
      await t.db
        .update(gameEvents)
        .set({ status: "locked" })
        .where(
          and(eq(gameEvents.gameId, gameId), eq(gameEvents.eventId, round2.id)),
        );
      const qualifying = await sessionOf(t.db, round2.id, "qualifying");
      const race2 = await sessionOf(t.db, round2.id, "race");
      await t.db
        .insert(sessionResultState)
        .values({ sessionId: qualifying.id, status: "provisional" });
      const lateCallAt = new Date(race2.scheduledStart.getTime() - 2 * HOUR);
      await at(lateCallAt);
      const { versionId } = await saveFinalFix(t.db, lateCallAt, {
        teamId: teamA,
        outAssetId: await game.assetId("hadjar"),
        inAssetId: await game.assetId("lawson"),
      });
      const newer = await versionFor(
        teamA,
        round2.id,
        new Date(lateCallAt.getTime() + HOUR),
      );
      await t.db
        .update(gameEvents)
        .set({ status: "final", updatedAt: scoredAt })
        .where(
          and(eq(gameEvents.gameId, gameId), eq(gameEvents.eventId, round2.id)),
        );

      await prune(new Date(lateCallAt.getTime() + 8 * DAY));

      expect(await versionsOf(teamA)).toEqual(
        expect.arrayContaining([versionId, newer]),
      );
    });

    it("keeps a team's newest version for the event, lock record or not", async () => {
      await t.db
        .delete(teamEventStates)
        .where(eq(teamEventStates.teamId, teamC));
      await prune(sevenDaysOn());
      expect(await versionsOf(teamC)).toEqual([locked]);
    });

    it("waits seven days from the event going final", async () => {
      const early = new Date(sevenDaysOn().getTime() - 1);
      expect(await prune(early)).toEqual({ deleted: 0 });
      expect(await versionsOf(teamC)).toHaveLength(3);
    });

    it("leaves an event that isn't final", async () => {
      await t.db
        .update(gameEvents)
        .set({ status: "scored" })
        .where(
          and(eq(gameEvents.gameId, gameId), eq(gameEvents.eventId, round2.id)),
        );
      expect(await prune(sevenDaysOn())).toEqual({ deleted: 0 });
    });

    it("running it again deletes nothing more", async () => {
      await prune(sevenDaysOn());
      expect(await prune(sevenDaysOn())).toEqual({ deleted: 0 });
    });
  });

  describe("the game_checks job", () => {
    const queue = (now: Date) =>
      enqueue(t.db, {
        kind: "game_checks",
        dedupeKey: gameChecksKey(gameId, now.toISOString().slice(0, 10)),
        runAt: now,
        payload: { gameId },
      });
    const handlers = () => ({ game_checks: createGameChecksHandler() });

    it("checks the explanations, then prunes", async () => {
      await breakTotal(round1.id, 1234);
      const at8 = new Date(scoredAt.getTime() + 8 * DAY);
      await t.db
        .update(gameEvents)
        .set({ status: "final", updatedAt: scoredAt })
        .where(
          and(eq(gameEvents.gameId, gameId), eq(gameEvents.eventId, round1.id)),
        );
      const versionId = await versionFor(
        teamA,
        round1.id,
        new Date(NOW.getTime() - HOUR),
      );
      await at(at8);
      await queue(at8);

      expect(
        await runDue(t.db, clock, handlers(), { maxJobs: 1, leaseMs: LEASE }),
      ).toEqual({ ran: 1, failed: 0, lost: 0 });

      expect(await items("score_mismatch")).toHaveLength(1);
      const remaining = await t.db
        .select()
        .from(lineupVersions)
        .where(eq(lineupVersions.id, versionId));
      expect(remaining).toEqual([]);
    });
  });
});
