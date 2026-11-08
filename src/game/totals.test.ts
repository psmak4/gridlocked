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
import { scoreWholeSession } from "../../tests/helpers/scoring-2026";
import {
  assetSessionTotals,
  events,
  gameEvents,
  lineupPicks,
  poolAssets,
  scoringRuns,
  sessionResultState,
  teamAdjustmentLines,
  teamBaseLines,
  teamEventStates,
  teamEventTotals,
} from "@/db/schema";
import { seedUser } from "../../tests/helpers/users";
import { SYSTEM_USER_ID } from "@/identity/system";
import { newId } from "@/lib/ids";
import { setSimulatedClock } from "@/replay/clock-loop";
import { addOverride } from "@/results/overrides";
import { saveFinalFix } from "./chips";
import { planGameEvents } from "./games";
import { openGame, saveLineup, type LineupPick } from "./lineups";
import { createTeam } from "./teams";
import { recomputeTotals } from "./totals";

// Event totals, running totals and ranks (DM 4.4) over the recorded 2026
// game: three teams locked into round 1 (Australia), whose lineups are
// carried into the later rounds. Most tests set a team's event points with a
// hand-written adjustment line, so the numbers are plain; the first and the
// Late Call test score the recorded results instead. Round 2 (China, a
// sprint weekend) is the Late Call's.

const NOW = new Date("2026-02-01T09:00:00.000Z");
const LATER = new Date("2026-02-01T10:00:00.000Z");
const HOUR_MS = 3_600_000;
// 280 + 250 + 95 + 85 + 80 + 90 + 70 = 950, leaving 50 in the bank.
const DRIVERS = ["norris", "piastri", "hulkenberg", "hadjar", "bearman"];
const CONSTRUCTORS = ["haas", "audi"];

type Round = { id: string; lockAt: Date };

describe("event totals (DM 4.4)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let game: Awaited<ReturnType<typeof seedGame2026>>;
  let gameId: string;
  /** Rounds 1 to 4. */
  let rounds: Round[];
  let teamA: string;
  /** Boosts Hadjar, the driver the Late Call test swaps out. */
  let teamB: string;
  let teamC: string;
  /** The last round opened and locked by `lockThrough`. */
  let lockedThrough: number;
  let stubRunId: string;

  beforeEach(async () => {
    t = await createTestDb();
    game = await seedGame2026(t.db, NOW);
    gameId = game.gameId;
    await setSimulatedClock(t.db, NOW);
    rounds = [];
    for (const n of [1, 2, 3, 4]) rounds.push(await round2026(t.db, n));
    await openGame(t.db, NOW, gameId);
    teamA = await team("A");
    teamB = await team("B");
    teamC = await team("C");
    await saveFor(rounds[0]!, teamA, await picksOf("norris"));
    await saveFor(rounds[0]!, teamB, await picksOf("hadjar"));
    await saveFor(rounds[0]!, teamC, await picksOf("norris"));
    await lockRound(t.db, gameId, rounds[0]!.id);
    lockedThrough = 1;
    stubRunId = await stubRun();
  });
  afterEach(async () => {
    await t.close();
  });

  /** A team for a new user, so slots never run out. */
  const team = async (name: string) =>
    createTeam(t.db, NOW, { gameId, userId: await seedUser(t.db), name });
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
  /** Saves one hour before the event's lock, with both clocks there. */
  const saveFor = async (event: Round, teamId: string, picks: LineupPick[]) => {
    const now = new Date(event.lockAt.getTime() - HOUR_MS);
    await setSimulatedClock(t.db, now);
    return saveLineup(t.db, now, { teamId, picks, basedOnVersionId: null });
  };
  /** Opens round `n` an hour after the one before it locked. */
  const toRound = async (n: number) => {
    const opened = new Date(rounds[n - 2]!.lockAt.getTime() + HOUR_MS);
    await setSimulatedClock(t.db, opened);
    await openRound(t.db, opened, gameId, rounds[n - 1]!.id);
  };
  /** Opens and locks the rounds up to `n`, the lineups carried. */
  const lockThrough = async (n: number) => {
    while (lockedThrough < n) {
      lockedThrough += 1;
      await toRound(lockedThrough);
      await lockRound(t.db, gameId, rounds[lockedThrough - 1]!.id);
    }
  };

  /** A run row for the hand-written lines to point at; it scores nothing. */
  const stubRun = async () => {
    const [ge] = await t.db
      .select()
      .from(gameEvents)
      .where(eq(gameEvents.eventId, rounds[0]!.id));
    const race = await sessionOf(t.db, rounds[0]!.id, "race");
    const id = newId();
    await t.db.insert(scoringRuns).values({
      id,
      gameId,
      sessionId: race.id,
      rulesetVersionId: ge!.rulesetVersionId,
      engineVersion: "test",
      inputFingerprint: "stub",
      trigger: "admin",
      mode: "live",
      status: "succeeded",
      startedAt: NOW,
    });
    return id;
  };
  /**
   * Adds `points` to the team's event: an event-level line, or a session's
   * with `sessionId`.
   */
  const award = (
    teamId: string,
    round: Round,
    points: number,
    sessionId: string | null = null,
  ) =>
    t.db.insert(teamAdjustmentLines).values({
      id: newId(),
      gameId,
      teamId,
      eventId: round.id,
      sessionId,
      assetId: null,
      lineType: sessionId === null ? "transfer_penalty" : "boost",
      category: null,
      points,
      runId: stubRunId,
    });
  /** The points of each event, by round index, for the teams in order. */
  const awardAll = async (byRound: number[][]) => {
    for (const [i, points] of byRound.entries()) {
      for (const [j, teamId] of [teamA, teamB, teamC].entries()) {
        const p = points[j] ?? 0;
        if (p !== 0) await award(teamId, rounds[i]!, p);
      }
    }
  };
  const recompute = (round: Round, now = NOW) =>
    recomputeTotals(t.db, now, { gameId, fromEventId: round.id });
  /** Recomputes round by round, as each event's scoring would. */
  const recomputeThrough = async (n: number, now = NOW) => {
    for (const round of rounds.slice(0, n)) await recompute(round, now);
  };

  const rowsOf = (teamId: string) =>
    t.db
      .select()
      .from(teamEventTotals)
      .where(eq(teamEventTotals.teamId, teamId))
      .orderBy(asc(teamEventTotals.eventSequence));
  const allRows = () =>
    t.db
      .select()
      .from(teamEventTotals)
      .orderBy(asc(teamEventTotals.eventSequence), asc(teamEventTotals.teamId));
  /** One team's `[cumulative, firstReached, rank]` per event. */
  const standing = async (teamId: string) =>
    (await rowsOf(teamId)).map((r) => [
      r.cumulativePoints,
      r.firstReachedSequence,
      r.globalRank,
    ]);

  it("an event's total is its base lines plus its adjustments", async () => {
    const race = await sessionOf(t.db, rounds[0]!.id, "race");
    const scoredAt = new Date(race.scheduledEnd.getTime() + HOUR_MS);
    await ingest(
      t.db,
      scoredAt,
      race.id,
      "race",
      loadBody("jolpica/2026/r01-results.json"),
    );
    await scoreWholeSession(t.db, scoredAt, { gameId, sessionId: race.id });
    // An event-level line, which is in the total and in no session.
    await award(teamA, rounds[0]!, -7);

    expect(await recompute(rounds[0]!, scoredAt)).toEqual({
      events: 1,
      teams: 3,
    });

    for (const teamId of [teamA, teamB, teamC]) {
      const base = (
        await t.db
          .select()
          .from(teamBaseLines)
          .where(eq(teamBaseLines.teamId, teamId))
      ).reduce((sum, l) => sum + l.points, 0);
      const adjustments = await t.db
        .select()
        .from(teamAdjustmentLines)
        .where(eq(teamAdjustmentLines.teamId, teamId));
      const adjusted = adjustments.reduce((sum, l) => sum + l.points, 0);
      const inRace = adjustments
        .filter((l) => l.sessionId === race.id)
        .reduce((sum, l) => sum + l.points, 0);
      const [row] = await rowsOf(teamId);
      expect(base).not.toBe(0);
      expect(row).toMatchObject({
        gameId,
        eventId: rounds[0]!.id,
        eventSequence: 1,
        points: base + adjusted,
        pointsBySession: { [race.id]: base + inRace },
        cumulativePoints: base + adjusted,
        status: "provisional",
        computedAt: scoredAt,
      });
    }
    // The event-level line is in A's total and in none of its sessions.
    const [a] = await rowsOf(teamA);
    expect(a!.points).toBe(a!.pointsBySession[race.id]! - 7);
  });

  it("the running total carries over a cancelled event", async () => {
    await awardAll([[10, 20, 0]]);
    await recompute(rounds[0]!);
    // Round 2 opens and is cancelled before its lock; round 3 takes its place.
    await toRound(2);
    const cancelledAt = new Date(rounds[1]!.lockAt.getTime() - HOUR_MS / 2);
    await setSimulatedClock(t.db, cancelledAt);
    await t.db
      .update(events)
      .set({ status: "cancelled" })
      .where(eq(events.id, rounds[1]!.id));
    await planGameEvents(t.db, cancelledAt, gameId);
    await lockRound(t.db, gameId, rounds[2]!.id);
    const [third] = await t.db
      .select()
      .from(gameEvents)
      .where(eq(gameEvents.eventId, rounds[2]!.id));
    expect(third!.sequence).toBe(2);
    await award(teamA, rounds[2]!, 5);
    await award(teamB, rounds[2]!, 5);
    await recompute(rounds[2]!);

    const rows = await allRows();
    expect(rows.some((r) => r.eventId === rounds[1]!.id)).toBe(false);
    expect(
      rows.map((r) => [
        r.teamId,
        r.eventId,
        r.eventSequence,
        r.cumulativePoints,
      ]),
    ).toEqual(
      expect.arrayContaining([
        [teamA, rounds[0]!.id, 1, 10],
        [teamA, rounds[2]!.id, 2, 15],
        [teamB, rounds[2]!.id, 2, 25],
        [teamC, rounds[2]!.id, 2, 0],
      ]),
    );
    expect(rows).toHaveLength(6);
    expect(await standing(teamB)).toEqual([
      [20, 1, 1],
      [25, 2, 1],
    ]);
  });

  it("a dip and a recovery use first at or above", async () => {
    await lockThrough(3);
    // Running totals 50, 40, 50.
    await awardAll([[50], [-10], [10]]);
    await recomputeThrough(3);

    // 40 was first reached at event 1, when the total was above it; and 50
    // again at event 3 is not a new first.
    expect(await standing(teamA)).toEqual([
      [50, 1, 1],
      [40, 1, 1],
      [50, 1, 1],
    ]);
  });

  it("teams tied on points rank by who got there first", async () => {
    await lockThrough(2);
    // Both end on 60; A got there at event 1, B at event 2.
    await awardAll([
      [60, 30, 0],
      [0, 30, 0],
    ]);
    await recomputeThrough(2);

    expect(await standing(teamA)).toEqual([
      [60, 1, 1],
      [60, 1, 1],
    ]);
    expect(await standing(teamB)).toEqual([
      [30, 1, 2],
      [60, 2, 2],
    ]);
    expect(await standing(teamC)).toEqual([
      [0, 1, 3],
      [0, 1, 3],
    ]);
  });

  it("teams that got there at the same event share a rank", async () => {
    await lockThrough(2);
    await awardAll([
      [50, 20, 0],
      [10, 40, 0],
    ]);
    await recomputeThrough(2);

    // Both on 60, both first there at event 2: rank 1 twice, then 3.
    const atTwo = async (teamId: string) => (await rowsOf(teamId))[1]!;
    expect(await atTwo(teamA)).toMatchObject({
      cumulativePoints: 60,
      firstReachedSequence: 2,
      globalRank: 1,
    });
    expect(await atTwo(teamB)).toMatchObject({
      cumulativePoints: 60,
      firstReachedSequence: 2,
      globalRank: 1,
    });
    expect((await atTwo(teamC)).globalRank).toBe(3);
    // After event 1 there was no tie.
    expect((await rowsOf(teamA))[0]!.globalRank).toBe(1);
    expect((await rowsOf(teamB))[0]!.globalRank).toBe(2);
  });

  it("a correction to an early event moves later running totals and ranks, but not later points", async () => {
    await lockThrough(3);
    await awardAll([
      [50, 20, 0],
      [-10, 30, 0],
      [20, 25, 0],
    ]);
    await recomputeThrough(3);
    // Before: A is on 50, 40, 60 and B on 20, 50, 75.
    const shape = (rows: (typeof teamEventTotals.$inferSelect)[]) =>
      rows.map((r) => [
        r.points,
        r.cumulativePoints,
        r.firstReachedSequence,
        r.globalRank,
      ]);
    expect(shape(await rowsOf(teamA))).toEqual([
      [50, 50, 1, 1],
      [-10, 40, 1, 2],
      [20, 60, 3, 2],
    ]);
    expect(shape(await rowsOf(teamB))).toEqual([
      [20, 20, 1, 2],
      [30, 50, 2, 1],
      [25, 75, 3, 1],
    ]);

    // Event 1 is corrected after event 3 is totalled: A was owed 30 more. The
    // later events keep their points; their running totals and ranks move. A
    // shift of every total leaves what was reached first alone.
    await award(teamA, rounds[0]!, 30);
    const corrected = new Date(LATER.getTime() + HOUR_MS);
    expect(await recompute(rounds[0]!, corrected)).toEqual({
      events: 3,
      teams: 3,
    });
    expect(shape(await rowsOf(teamA))).toEqual([
      [80, 80, 1, 1],
      [-10, 70, 1, 1],
      [20, 90, 3, 1],
    ]);
    expect(shape(await rowsOf(teamB))).toEqual([
      [20, 20, 1, 2],
      [30, 50, 2, 2],
      [25, 75, 3, 2],
    ]);
    expect((await rowsOf(teamC)).map((r) => r.globalRank)).toEqual([3, 3, 3]);

    // Then event 2 is: A lost 40 more there, which drops its total at event 3
    // back below event 1's, so event 3 was first reached at event 1. Event 1's
    // row is left alone.
    await award(teamA, rounds[1]!, -40);
    const again = new Date(corrected.getTime() + HOUR_MS);
    expect(await recompute(rounds[1]!, again)).toEqual({ events: 2, teams: 3 });
    const a = await rowsOf(teamA);
    expect(shape(a)).toEqual([
      [80, 80, 1, 1],
      [-50, 30, 1, 2],
      [20, 50, 1, 2],
    ]);
    expect(a[0]!.computedAt).toEqual(corrected);
    expect(a[2]!.computedAt).toEqual(again);
    expect(shape(await rowsOf(teamB))).toEqual([
      [20, 20, 1, 2],
      [30, 50, 2, 1],
      [25, 75, 3, 1],
    ]);
  });

  it("a rebuild leaves unchanged later rows alone", async () => {
    await lockThrough(2);
    await awardAll([
      [10, 5, 0],
      [10, 20, 0],
    ]);
    await recomputeThrough(2);

    // Nothing moved: the later event's rows keep their time.
    expect(await recompute(rounds[0]!, LATER)).toEqual({ events: 2, teams: 3 });
    expect((await rowsOf(teamA)).map((r) => r.computedAt)).toEqual([
      LATER,
      NOW,
    ]);
    expect((await rowsOf(teamC)).map((r) => r.computedAt)).toEqual([
      LATER,
      NOW,
    ]);
  });

  it("a rebuild brings later rows' status along", async () => {
    await lockThrough(2);
    await awardAll([[10], [10]]);
    await recomputeThrough(2);
    await t.db
      .update(gameEvents)
      .set({ status: "final" })
      .where(eq(gameEvents.eventId, rounds[1]!.id));

    await recompute(rounds[0]!, LATER);
    expect((await rowsOf(teamA)).map((r) => [r.status, r.computedAt])).toEqual([
      ["provisional", LATER],
      ["final", LATER],
    ]);
  });

  it("a team that joined late has no rows for earlier events", async () => {
    const late = await team("Late");
    await toRound(2);
    await saveFor(rounds[1]!, late, await picksOf("piastri"));
    await lockRound(t.db, gameId, rounds[1]!.id);
    lockedThrough = 2;
    await award(teamA, rounds[0]!, 10);
    await award(teamA, rounds[1]!, 10);
    await award(late, rounds[1]!, 15);
    await recomputeThrough(2);

    const rows = await rowsOf(late);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventId: rounds[1]!.id,
      eventSequence: 2,
      points: 15,
      cumulativePoints: 15,
      firstReachedSequence: 2,
      globalRank: 2,
    });
    // Event 1 ranked the three teams that were there.
    const atOne = (await allRows()).filter((r) => r.eventId === rounds[0]!.id);
    expect(atOne).toHaveLength(3);
    expect(atOne.map((r) => r.globalRank).sort()).toEqual([1, 2, 2]);
    expect((await rowsOf(teamA))[1]!.globalRank).toBe(1);
  });

  it("recomputing twice changes nothing", async () => {
    await lockThrough(2);
    await awardAll([
      [10, 5, 0],
      [-3, 20, 0],
    ]);
    await recompute(rounds[0]!);
    await recompute(rounds[1]!);
    const rows = await allRows();
    expect(rows).toHaveLength(6);

    // The second pass finds the later event's rows already there.
    expect(await recompute(rounds[0]!)).toEqual({ events: 2, teams: 3 });
    expect(await recompute(rounds[1]!)).toEqual({ events: 1, teams: 3 });
    expect(await allRows()).toEqual(rows);
  });

  it("a total follows its event: final once the event is final", async () => {
    await lockThrough(2);
    await awardAll([[10], [10]]);
    await t.db
      .update(gameEvents)
      .set({ status: "final" })
      .where(eq(gameEvents.eventId, rounds[0]!.id));
    await recomputeThrough(2);

    const a = await rowsOf(teamA);
    expect(a.map((r) => r.status)).toEqual(["final", "provisional"]);
  });

  it("a team without a lock record for the event has no total, and loses a stale one", async () => {
    await award(teamA, rounds[0]!, 10);
    await recompute(rounds[0]!);
    // A row left from before: the lock record it came from is gone.
    await t.db
      .delete(teamEventStates)
      .where(
        and(
          eq(teamEventStates.teamId, teamC),
          eq(teamEventStates.eventId, rounds[0]!.id),
        ),
      );
    expect(await recompute(rounds[0]!)).toEqual({ events: 1, teams: 2 });
    expect(await rowsOf(teamC)).toEqual([]);
    expect(await rowsOf(teamA)).toHaveLength(1);
  });

  it("refuses a cancelled event", async () => {
    await toRound(2);
    const cancelledAt = new Date(rounds[1]!.lockAt.getTime() - HOUR_MS / 2);
    await setSimulatedClock(t.db, cancelledAt);
    await t.db
      .update(events)
      .set({ status: "cancelled" })
      .where(eq(events.id, rounds[1]!.id));
    await planGameEvents(t.db, cancelledAt, gameId);

    await expect(recompute(rounds[1]!)).rejects.toThrow(/cancelled/);
  });

  it("a Late Call team's corrected qualifying re-totals with the locked lineup", async () => {
    await lockThrough(2);
    const round2 = rounds[1]!;
    const qualifying = await sessionOf(t.db, round2.id, "qualifying");
    const sprint = await sessionOf(t.db, round2.id, "sprint");
    const race = await sessionOf(t.db, round2.id, "race");
    const hadjar = await game.assetId("hadjar");
    const lawson = await game.assetId("lawson");

    // Qualifying's results open the Late Call window; B swaps Hadjar, who
    // holds its Boost, for Lawson.
    const qualified = new Date(qualifying.scheduledEnd.getTime() + HOUR_MS);
    await ingest(
      t.db,
      qualified,
      qualifying.id,
      "qualifying",
      loadBody("jolpica/2026/r18-qualifying.json"),
    );
    await t.db
      .insert(sessionResultState)
      .values({ sessionId: qualifying.id, status: "provisional" })
      .onConflictDoUpdate({
        target: sessionResultState.sessionId,
        set: { status: "provisional" },
      });
    const lateCallAt = new Date(race.scheduledStart.getTime() - 2 * HOUR_MS);
    await setSimulatedClock(t.db, lateCallAt);
    const { versionId: lateCallVersion } = await saveFinalFix(
      t.db,
      lateCallAt,
      { teamId: teamB, outAssetId: hadjar, inAssetId: lawson },
    );
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
    for (const session of [qualifying, sprint, race]) {
      await scoreWholeSession(t.db, after, { gameId, sessionId: session.id });
    }
    await recompute(round2, after);

    const [state] = await t.db
      .select()
      .from(teamEventStates)
      .where(
        and(
          eq(teamEventStates.teamId, teamB),
          eq(teamEventStates.eventId, round2.id),
        ),
      );
    const picksOf = (versionId: string) =>
      t.db
        .select()
        .from(lineupPicks)
        .where(eq(lineupPicks.lineupVersionId, versionId));
    const locked = await picksOf(state!.lockedVersionId);
    const lateCall = await picksOf(lateCallVersion);
    const sessionPoints = async (sessionId: string) =>
      new Map(
        (
          await t.db
            .select()
            .from(assetSessionTotals)
            .where(eq(assetSessionTotals.sessionId, sessionId))
        ).map((r) => [r.assetId, r.points]),
      );
    /**
     * What B should score in the session by hand: its lineup's assets, and
     * the Boost's extra on top. The race counts the Late Call lineup.
     */
    const expected = async (
      sessionId: string,
      picks = sessionId === race.id ? lateCall : locked,
    ) => {
      const totals = await sessionPoints(sessionId);
      const of = (assetId: string) => totals.get(assetId) ?? 0;
      const boosted = picks.find((p) => p.isBoost)!.assetId;
      return picks.reduce((sum, p) => sum + of(p.assetId), 0) + of(boosted);
    };
    const boostLines = async (sessionId: string) =>
      (
        await t.db
          .select()
          .from(teamAdjustmentLines)
          .where(
            and(
              eq(teamAdjustmentLines.teamId, teamB),
              eq(teamAdjustmentLines.sessionId, sessionId),
              eq(teamAdjustmentLines.lineType, "boost"),
            ),
          )
      ).map((l) => l.assetId);
    const eventLevel = async () =>
      (
        await t.db
          .select()
          .from(teamAdjustmentLines)
          .where(
            and(
              eq(teamAdjustmentLines.teamId, teamB),
              eq(teamAdjustmentLines.eventId, round2.id),
            ),
          )
      )
        .filter((l) => l.sessionId === null)
        .reduce((sum, l) => sum + l.points, 0);

    // The Boost is on Hadjar until the race, and on Lawson only there.
    expect(locked.find((p) => p.isBoost)!.assetId).toBe(hadjar);
    expect(lateCall.find((p) => p.isBoost)!.assetId).toBe(lawson);
    expect(await boostLines(qualifying.id)).toEqual([hadjar]);
    expect(await boostLines(sprint.id)).toEqual([hadjar]);
    expect(await boostLines(race.id)).toEqual([lawson]);

    const atRound2 = async () =>
      (await rowsOf(teamB)).find((r) => r.eventId === round2.id)!;
    const before = await atRound2();
    for (const session of [qualifying, sprint, race]) {
      expect(before.pointsBySession[session.id]).toBe(
        await expected(session.id),
      );
    }
    expect(before.pointsBySession[qualifying.id]).not.toBe(
      await expected(qualifying.id, lateCall),
    );
    expect(before.points).toBe(
      (await expected(qualifying.id)) +
        (await expected(sprint.id)) +
        (await expected(race.id)) +
        (await eventLevel()),
    );

    // The stewards' correction: Hadjar was on pole after all.
    const corrected = new Date(after.getTime() + HOUR_MS);
    const hadjarDriver = await driverOf(hadjar);
    await addOverride(t.db, corrected, {
      sessionId: qualifying.id,
      driverId: hadjarDriver,
      kind: "patch",
      fields: { position: 1 },
      reason: "Stewards: Hadjar's pole lap reinstated",
      createdBy: SYSTEM_USER_ID,
    });
    await scoreWholeSession(t.db, corrected, {
      gameId,
      sessionId: qualifying.id,
      trigger: "override",
    });
    await recompute(round2, corrected);

    // Hadjar's pole is 10 in qualifying, and his Boost doubles it; Lawson's
    // qualifying never reached B, who had swapped him in for the race only.
    expect((await sessionPoints(qualifying.id)).get(hadjar)).toBe(10);
    const row = await atRound2();
    expect(row.pointsBySession[qualifying.id]).toBe(
      await expected(qualifying.id),
    );
    // Not what the Late Call lineup would have scored there.
    expect(row.pointsBySession[qualifying.id]).not.toBe(
      await expected(qualifying.id, lateCall),
    );
    expect(row.pointsBySession[qualifying.id]).not.toBe(
      before.pointsBySession[qualifying.id],
    );
    expect(row.pointsBySession[sprint.id]).toBe(
      before.pointsBySession[sprint.id],
    );
    expect(row.pointsBySession[race.id]).toBe(before.pointsBySession[race.id]);
    expect(row.points).toBe(
      (await expected(qualifying.id)) +
        (await expected(sprint.id)) +
        (await expected(race.id)) +
        (await eventLevel()),
    );
    expect(row.cumulativePoints).toBe(row.points);
    expect(await boostLines(qualifying.id)).toEqual([hadjar]);
    expect(await boostLines(race.id)).toEqual([lawson]);
  });

  const driverOf = async (assetId: string) =>
    (
      await t.db
        .select({ driverId: poolAssets.driverId })
        .from(poolAssets)
        .where(eq(poolAssets.id, assetId))
    )[0]!.driverId!;
});
