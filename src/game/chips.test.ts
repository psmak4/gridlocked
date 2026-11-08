import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq, sql } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import {
  lockRound,
  openRound,
  round2026,
  seedGame2026,
} from "../../tests/helpers/game-2026";
import {
  chipPlays,
  events,
  gameEvents,
  lineupPicks,
  lineupVersions,
  RESULT_STATES,
  sessionResultState,
  sessions,
  teamEventStates,
} from "@/db/schema";
import { seedUser } from "../../tests/helpers/users";
import { newId } from "@/lib/ids";
import { setSimulatedClock } from "@/replay/clock-loop";
import type { StaffActor } from "@/staff/roster";
import { playChip, refundChips, saveFinalFix } from "./chips";
import { GameError, refusal } from "./errors";
import { openGame, saveLineup, type LineupPick } from "./lineups";
import { publishPrices } from "./prices";
import { createTeam, removeTeam } from "./teams";

// The six chips (DM 3.9) over the recorded 2026 game, each row of DM 3.9 and
// 3.11 that names one. Round 1 (Australia) is the teams' first event and
// round 2 (China) a sprint weekend. Prices are the fixture's, carried from
// round 1 unless a test sets one.

const NOW = new Date("2026-02-01T09:00:00.000Z");
const HOUR_MS = 3_600_000;
const SECOND_MS = 1000;
const ACTOR: StaffActor = { kind: "admin", label: "staff" };
// 280 + 250 + 95 + 85 + 80 + 90 + 70 = 950, leaving 50 in the bank.
const DRIVERS = ["norris", "piastri", "hulkenberg", "hadjar", "bearman"];
const CONSTRUCTORS = ["haas", "audi"];
const COST = 950;
const RESTRICT_VIOLATION = "23001";
const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const COMPOSITION = "GL002";

type ResultState = (typeof RESULT_STATES)[number];

describe("chips (DM 3.9)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let game: Awaited<ReturnType<typeof seedGame2026>>;
  let gameId: string;
  let round1: { id: string; lockAt: Date };
  let round2: { id: string; lockAt: Date };
  let teamId: string;

  beforeEach(async () => {
    t = await createTestDb();
    game = await seedGame2026(t.db, NOW);
    gameId = game.gameId;
    await setSimulatedClock(t.db, NOW);
    round1 = await round2026(t.db, 1);
    round2 = await round2026(t.db, 2);
    await openGame(t.db, NOW, gameId);
    teamId = await team("One");
  });
  afterEach(async () => {
    await t.close();
  });

  /** A team for a new user, so slots never run out. */
  const team = async (name: string) =>
    createTeam(t.db, NOW, { gameId, userId: await seedUser(t.db), name });

  const picksOf = async (
    drivers = DRIVERS,
    constructors = CONSTRUCTORS,
    boost = drivers[0]!,
  ): Promise<LineupPick[]> => [
    ...(await Promise.all(
      drivers.map(async (key) => ({
        assetId: await game.assetId(key),
        isBoost: key === boost,
      })),
    )),
    ...(await Promise.all(
      constructors.map(async (key) => ({
        assetId: await game.assetId(key),
        isBoost: false,
      })),
    )),
  ];
  /** Moves both clocks, the app's and the database's, to the same instant. */
  const at = async (time: Date) => {
    await setSimulatedClock(t.db, time);
    return time;
  };
  const anHourBefore = (event: { lockAt: Date }) =>
    at(new Date(event.lockAt.getTime() - HOUR_MS));
  /** Saves one hour before the event's lock, with both clocks there. */
  const saveFor = async (
    event: { lockAt: Date },
    picks: LineupPick[],
    id = teamId,
  ) =>
    saveLineup(t.db, await anHourBefore(event), {
      teamId: id,
      picks,
      basedOnVersionId: null,
    });
  /** Plays a chip one hour before the event's lock. */
  const play = async (
    event: { lockAt: Date },
    chipCode: string,
    id = teamId,
    target?: string,
  ) =>
    playChip(t.db, await anHourBefore(event), {
      teamId: id,
      chipCode,
      targetAssetId:
        target === undefined ? undefined : await game.assetId(target),
    });
  /** Locks `from`, then opens `to` an hour later. */
  const advance = async (from: { id: string }, to: { id: string }) => {
    const locked = await lockRound(t.db, gameId, from.id);
    const opened = await at(new Date(locked.getTime() + HOUR_MS));
    await openRound(t.db, opened, gameId, to.id);
    return opened;
  };
  /** Round 1's lineup locked, carried into round 2, and round 2 locked. */
  const lockedRound2 = async () => {
    const first = await saveFor(round1, await picksOf());
    await advance(round1, round2);
    await lockRound(t.db, gameId, round2.id);
    return first;
  };
  const round = (n: number) => round2026(t.db, n);
  const stateOf = async (eventId: string, id = teamId) =>
    (
      await t.db
        .select()
        .from(teamEventStates)
        .where(
          and(
            eq(teamEventStates.teamId, id),
            eq(teamEventStates.eventId, eventId),
          ),
        )
    )[0];
  const plays = () =>
    t.db.select().from(chipPlays).orderBy(asc(chipPlays.playedAt));
  const baseState = async (eventId: string) => {
    const { rows } = await t.db.execute(
      sql`select * from team_base_state(${teamId}::uuid, ${eventId}::uuid)`,
    );
    return rows[0];
  };
  const purchasingPower = async (eventId: string) => {
    const { rows } = await t.db.execute(
      sql`select team_purchasing_power(${teamId}::uuid, ${eventId}::uuid) as power`,
    );
    return (rows[0] as { power: number }).power;
  };
  const picksOfVersion = (versionId: string) =>
    t.db
      .select({ assetId: lineupPicks.assetId, isBoost: lineupPicks.isBoost })
      .from(lineupPicks)
      .where(eq(lineupPicks.lineupVersionId, versionId))
      .orderBy(asc(lineupPicks.assetId));
  /** An event's qualifying, sprint qualifying and race sessions. */
  const weekend = async (eventId: string) => {
    const rows = await t.db
      .select()
      .from(sessions)
      .where(eq(sessions.eventId, eventId));
    const of = (kind: string) => rows.find((s) => s.kind === kind);
    return {
      qualifying: of("qualifying")!,
      sprintQualifying: of("sprint_qualifying"),
      race: of("race")!,
    };
  };
  /** A session's results arriving: its result state leaves `awaiting`. */
  const resultsIn = (sessionId: string, status: ResultState = "provisional") =>
    t.db
      .insert(sessionResultState)
      .values({ sessionId, status })
      .onConflictDoUpdate({
        target: sessionResultState.sessionId,
        set: { status },
      });
  const lateCall = async (
    now: Date,
    outKey: string,
    inKey: string,
    id = teamId,
  ) =>
    saveFinalFix(t.db, now, {
      teamId: id,
      outAssetId: await game.assetId(outKey),
      inAssetId: await game.assetId(inKey),
    });
  /** Two hours before the race, with qualifying's results in. */
  const lateCallWindow = async (eventId: string) => {
    const { qualifying, race } = await weekend(eventId);
    await resultsIn(qualifying.id);
    return at(new Date(race.scheduledStart.getTime() - 2 * HOUR_MS));
  };

  async function expectGameError(promise: Promise<unknown>, code: string) {
    const error = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error, "expected a GameError").toBeInstanceOf(GameError);
    expect((error as GameError).code).toBe(code);
  }
  /** The SQLSTATE is on the error or its cause. */
  async function expectPgError(promise: Promise<unknown>, code: string) {
    const error = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error, "expected the statement to be rejected").toBeDefined();
    const direct = (error as { code?: string }).code;
    const cause = (error as { cause?: { code?: string } }).cause?.code;
    expect(direct ?? cause).toBe(code);
  }

  it("a chip can be played once per season", async () => {
    await saveFor(round1, await picksOf());
    const first = await play(round1, "chip_autopilot");
    await advance(round1, round2);
    await expectGameError(play(round2, "chip_autopilot"), "chip_unavailable");
    expect(
      (await plays()).map((p) => [p.id, p.chipCode, p.eventId, p.status]),
    ).toEqual([[first, "chip_autopilot", round1.id, "played"]]);
    // Another chip is still there to play.
    await play(round2, "chip_no_negative");
    expect(await plays()).toHaveLength(2);
  });

  it("only one chip per race", async () => {
    await play(round1, "chip_autopilot");
    await expectGameError(play(round1, "chip_no_negative"), "chip_unavailable");
    expect((await plays()).map((p) => p.chipCode)).toEqual(["chip_autopilot"]);
  });

  it("Rebuild, Blank Cheque and Late Call are refused at the team's first event and allowed at its second", async () => {
    const rebuild = teamId;
    const blankCheque = await team("Two");
    const lateCaller = await team("Three");
    for (const id of [rebuild, blankCheque, lateCaller]) {
      await saveFor(round1, await picksOf(), id);
    }
    await expectGameError(
      play(round1, "chip_wildcard", rebuild),
      "chip_unavailable",
    );
    await expectGameError(
      play(round1, "chip_limitless", blankCheque),
      "chip_unavailable",
    );
    await lockRound(t.db, gameId, round1.id);
    const now = await lateCallWindow(round1.id);
    await expectGameError(
      lateCall(now, "hadjar", "lawson", lateCaller),
      "chip_unavailable",
    );
    expect(await plays()).toHaveLength(0);

    const opened = await at(new Date(now.getTime() + 6 * HOUR_MS));
    await openRound(t.db, opened, gameId, round2.id);
    await play(round2, "chip_wildcard", rebuild);
    await play(round2, "chip_limitless", blankCheque);
    await lockRound(t.db, gameId, round2.id);
    await lateCall(
      await lateCallWindow(round2.id),
      "hadjar",
      "lawson",
      lateCaller,
    );
    expect(
      (await plays()).map((p) => [p.teamId, p.chipCode, p.eventId]),
    ).toEqual([
      [rebuild, "chip_wildcard", round2.id],
      [blankCheque, "chip_limitless", round2.id],
      [lateCaller, "chip_final_fix", round2.id],
    ]);
  });

  it("Strategist, Overdrive and Safety Car work at the team's first event", async () => {
    const strategist = teamId;
    const overdrive = await team("Two");
    const safetyCar = await team("Three");
    for (const id of [strategist, overdrive, safetyCar]) {
      await saveFor(round1, await picksOf(), id);
    }
    const ids = [
      await play(round1, "chip_autopilot", strategist),
      await play(round1, "chip_triple_boost", overdrive, "piastri"),
      await play(round1, "chip_no_negative", safetyCar),
    ];
    await lockRound(t.db, gameId, round1.id);
    expect(
      await Promise.all(
        [strategist, overdrive, safetyCar].map(async (id) => {
          const row = await stateOf(round1.id, id);
          return [row!.isFirstEvent, row!.chipPlayId];
        }),
      ),
    ).toEqual(ids.map((id) => [true, id]));
    const [x3] = (await plays()).filter((p) => p.teamId === overdrive);
    expect(x3!.targetAssetId).toBe(await game.assetId("piastri"));
  });

  it("Overdrive on the 2x Boost driver is refused", async () => {
    await saveFor(round1, await picksOf());
    // Norris has the 2x Boost.
    await expectGameError(
      play(round1, "chip_triple_boost", teamId, "norris"),
      "composition",
    );
    // A constructor, a driver the team doesn't have, or no target at all.
    await expectGameError(
      play(round1, "chip_triple_boost", teamId, "haas"),
      "composition",
    );
    await expectGameError(
      play(round1, "chip_triple_boost", teamId, "max_verstappen"),
      "composition",
    );
    await expectGameError(play(round1, "chip_triple_boost"), "composition");
    expect(await plays()).toHaveLength(0);
    await play(round1, "chip_triple_boost", teamId, "piastri");
    expect(await plays()).toHaveLength(1);
  });

  it("after Overdrive, moving the Boost onto its target is refused", async () => {
    await saveFor(round1, await picksOf());
    const chip = await play(round1, "chip_triple_boost", teamId, "piastri");
    await expectGameError(
      saveFor(round1, await picksOf(DRIVERS, CONSTRUCTORS, "piastri")),
      "composition",
    );
    // Dropping the target is refused too.
    await expectGameError(
      saveFor(
        round1,
        await picksOf(["norris", "lawson", "hulkenberg", "hadjar", "bearman"]),
      ),
      "composition",
    );
    // The Boost can still move to another driver.
    const kept = await saveFor(
      round1,
      await picksOf(DRIVERS, CONSTRUCTORS, "hulkenberg"),
    );
    await lockRound(t.db, gameId, round1.id);
    expect(await stateOf(round1.id)).toMatchObject({
      lockedVersionId: kept.versionId,
      chipPlayId: chip,
    });
  });

  it("a played chip can't be deleted or un-played", async () => {
    const id = await play(round1, "chip_autopilot");
    const thePlay = eq(chipPlays.id, id);
    await expectPgError(
      t.db.delete(chipPlays).where(thePlay),
      RESTRICT_VIOLATION,
    );
    await expectPgError(
      t.db
        .update(chipPlays)
        .set({ chipCode: "chip_no_negative" })
        .where(thePlay),
      RESTRICT_VIOLATION,
    );
    await expectPgError(
      t.db.update(chipPlays).set({ eventId: round2.id }).where(thePlay),
      RESTRICT_VIOLATION,
    );
    // Only the system refunds, and only for a cancelled event.
    await expectPgError(
      t.db.update(chipPlays).set({ status: "refunded" }).where(thePlay),
      RESTRICT_VIOLATION,
    );
    await expect(
      refundChips(t.db, NOW, { gameId, eventId: round1.id }),
    ).rejects.toThrow();
    await t.db
      .update(gameEvents)
      .set({ status: "cancelled", sequence: null })
      .where(eq(gameEvents.eventId, round1.id));
    expect(await refundChips(t.db, NOW, { gameId, eventId: round1.id })).toBe(
      1,
    );
    expect((await plays()).map((p) => p.status)).toEqual(["refunded"]);
    // A refund is final.
    await expectPgError(
      t.db.update(chipPlays).set({ status: "played" }).where(thePlay),
      RESTRICT_VIOLATION,
    );
    await expectPgError(
      t.db.delete(chipPlays).where(thePlay),
      RESTRICT_VIOLATION,
    );
    expect(await refundChips(t.db, NOW, { gameId, eventId: round1.id })).toBe(
      0,
    );
  });

  it("a team deleted before its first lock takes its chip plays with it", async () => {
    await play(round1, "chip_autopilot");
    expect(await removeTeam(t.db, NOW, teamId)).toBe("deleted");
    expect(await plays()).toHaveLength(0);
  });

  it("Rebuild: four transfers, no penalty, carry-over 0, and the result is the next base", async () => {
    const first = await saveFor(round1, await picksOf());
    await advance(round1, round2);
    const chip = await play(round2, "chip_wildcard");
    // Three drivers and a constructor out: 280 + 250 + 72 + 66 + 60 + 60 + 70.
    const rebuilt = await saveFor(
      round2,
      await picksOf(
        ["norris", "piastri", "lawson", "ocon", "stroll"],
        ["alpine", "audi"],
      ),
    );
    const round3 = await round(3);
    await advance(round2, round3);
    expect(await stateOf(round2.id)).toMatchObject({
      baseVersionId: first.versionId,
      lockedVersionId: rebuilt.versionId,
      chipPlayId: chip,
      purchasingPower: 1000,
      spent: 858,
      bank: 142,
      transfersMade: 4,
      freeTransfers: null,
      carryOverOut: 0,
      transferPenalty: 0,
    });
    expect(await baseState(round3.id)).toEqual({
      base_version_id: rebuilt.versionId,
      bank: 142,
      carry_in: 0,
      is_first: false,
    });
    await lockRound(t.db, gameId, round3.id);
    expect(await stateOf(round3.id)).toMatchObject({
      baseVersionId: rebuilt.versionId,
      lockedVersionId: rebuilt.versionId,
      chipPlayId: null,
      transfersMade: 0,
      freeTransfers: 2,
    });
  });

  it("Blank Cheque: an over-budget lineup locks, no carry-over, and the next event's base is the pre-Blank Cheque lineup with its bank, at the new prices", async () => {
    const first = await saveFor(round1, await picksOf());
    await advance(round1, round2);
    const chip = await play(round2, "chip_limitless");
    // Far over the budget: 280 + 270 + 250 + 220 + 200 + 300 + 270.
    const big = await saveFor(
      round2,
      await picksOf(
        ["norris", "max_verstappen", "piastri", "russell", "leclerc"],
        ["mclaren", "mercedes"],
      ),
    );
    const [version] = await t.db
      .select()
      .from(lineupVersions)
      .where(eq(lineupVersions.id, big.versionId));
    expect(version!.kind).toBe("limitless");
    await lockRound(t.db, gameId, round2.id);
    expect(await stateOf(round2.id)).toMatchObject({
      baseVersionId: first.versionId,
      lockedVersionId: big.versionId,
      chipPlayId: chip,
      purchasingPower: 1000,
      spent: 1790,
      bank: -790,
      transfersMade: 5,
      freeTransfers: null,
      carryOverOut: 0,
      transferPenalty: 0,
    });

    // Round 3's prices move before it opens: Norris up 20, Haas down 10.
    const round3 = await round(3);
    const opened = await at(new Date(round2.lockAt.getTime() + HOUR_MS));
    await publishPrices(t.db, opened, {
      gameId,
      eventId: round3.id,
      source: "admin",
      reason: "Price correction",
      actor: ACTOR,
      prices: [
        { assetId: await game.assetId("norris"), price: 300 },
        { assetId: await game.assetId("haas"), price: 80 },
      ],
    });
    await openRound(t.db, opened, gameId, round3.id);
    expect(await baseState(round3.id)).toEqual({
      base_version_id: first.versionId,
      bank: 1000 - COST,
      carry_in: 0,
      is_first: false,
    });
    expect(await purchasingPower(round3.id)).toBe(1010);
    await lockRound(t.db, gameId, round3.id);
    expect(await stateOf(round3.id)).toMatchObject({
      baseVersionId: first.versionId,
      lockedVersionId: first.versionId,
      purchasingPower: 1010,
      spent: 960,
      bank: 50,
      transfersMade: 0,
      freeTransfers: 2,
    });
  });

  it("Late Call before qualifying's results are in is refused with chip_window_closed", async () => {
    await lockedRound2();
    const { qualifying, race } = await weekend(round2.id);
    const now = await at(new Date(race.scheduledStart.getTime() - 2 * HOUR_MS));
    await expectGameError(
      lateCall(now, "hadjar", "lawson"),
      "chip_window_closed",
    );
    // A result state still `awaiting` is not results.
    await resultsIn(qualifying.id, "awaiting");
    await expectGameError(
      lateCall(now, "hadjar", "lawson"),
      "chip_window_closed",
    );
    expect(await plays()).toHaveLength(0);
    expect(
      await t.db
        .select()
        .from(lineupVersions)
        .where(eq(lineupVersions.kind, "final_fix")),
    ).toHaveLength(0);
    await resultsIn(qualifying.id, "provisional");
    await lateCall(now, "hadjar", "lawson");
  });

  it("Late Call after the race's scheduled start is refused", async () => {
    await lockedRound2();
    const { qualifying, race } = await weekend(round2.id);
    await resultsIn(qualifying.id, "final");
    await expectGameError(
      lateCall(await at(race.scheduledStart), "hadjar", "lawson"),
      "chip_window_closed",
    );
    expect(await plays()).toHaveLength(0);
    // One second before it is still in time.
    await lateCall(
      await at(new Date(race.scheduledStart.getTime() - SECOND_MS)),
      "hadjar",
      "lawson",
    );
  });

  it("Late Call on a sprint weekend opens after qualifying, not after sprint qualifying", async () => {
    await lockedRound2();
    const [event] = await t.db
      .select()
      .from(events)
      .where(eq(events.id, round2.id));
    expect(event!.format).toBe("sprint");
    const { qualifying, sprintQualifying } = await weekend(round2.id);
    await resultsIn(sprintQualifying!.id, "final");
    // Between the sprint and qualifying.
    const now = await at(
      new Date(qualifying.scheduledStart.getTime() - HOUR_MS),
    );
    await expectGameError(
      lateCall(now, "hadjar", "lawson"),
      "chip_window_closed",
    );
    await resultsIn(qualifying.id);
    const later = await at(new Date(qualifying.scheduledEnd.getTime()));
    await lateCall(later, "hadjar", "lawson");
    expect((await plays()).map((p) => p.chipCode)).toEqual(["chip_final_fix"]);
  });

  it("Late Call moves the Boost to the incoming driver", async () => {
    const first = await lockedRound2();
    const { race } = await weekend(round2.id);
    const { versionId, chipPlayId } = await lateCall(
      await lateCallWindow(round2.id),
      "norris",
      "lawson",
    );
    const [version] = await t.db
      .select()
      .from(lineupVersions)
      .where(eq(lineupVersions.id, versionId));
    expect(version).toMatchObject({
      teamId,
      forEventId: round2.id,
      kind: "final_fix",
      effectiveFromSessionId: race.id,
      basedOnVersionId: first.versionId,
    });
    const expected = await picksOf(
      ["lawson", "piastri", "hulkenberg", "hadjar", "bearman"],
      CONSTRUCTORS,
      "lawson",
    );
    expect(await picksOfVersion(versionId)).toEqual(
      [...expected].sort((a, b) => a.assetId.localeCompare(b.assetId)),
    );
    expect(await stateOf(round2.id)).toMatchObject({
      lockedVersionId: first.versionId,
      finalFixVersionId: versionId,
      chipPlayId,
    });
    const [thePlay] = await plays();
    expect(thePlay).toMatchObject({
      id: chipPlayId,
      chipCode: "chip_final_fix",
      eventId: round2.id,
      status: "played",
    });
  });

  it("Late Call with two swaps, or a driver for a constructor, is refused", async () => {
    const first = await lockedRound2();
    const now = await lateCallWindow(round2.id);
    await expectGameError(lateCall(now, "norris", "mclaren"), "composition");
    expect(await plays()).toHaveLength(0);
    // The database refuses a Late Call version with two swaps, even with the
    // chip played alongside it.
    const { race } = await weekend(round2.id);
    const two = await picksOf(
      ["norris", "piastri", "hulkenberg", "lawson", "ocon"],
      CONSTRUCTORS,
    );
    await expectPgError(
      t.db.transaction(async (tx) => {
        await tx.insert(chipPlays).values({
          id: newId(),
          teamId,
          gameId,
          chipCode: "chip_final_fix",
          eventId: round2.id,
          status: "played",
        });
        const id = newId();
        await tx.insert(lineupVersions).values({
          id,
          teamId,
          forEventId: round2.id,
          kind: "final_fix",
          effectiveFromSessionId: race.id,
          basedOnVersionId: first.versionId,
        });
        await tx
          .insert(lineupPicks)
          .values(two.map((p) => ({ lineupVersionId: id, ...p })));
      }),
      COMPOSITION,
    );
    expect(await plays()).toHaveLength(0);
    // One swap, then a second Late Call for another.
    await lateCall(now, "hadjar", "lawson");
    await expectGameError(lateCall(now, "bearman", "ocon"), "chip_unavailable");
    expect(
      await t.db
        .select()
        .from(lineupVersions)
        .where(eq(lineupVersions.kind, "final_fix")),
    ).toHaveLength(1);
  });

  it("Late Call over the event's purchasing power is refused", async () => {
    await lockedRound2();
    // 950 - 85 + 270 = 1135, against 1000.
    expect(await purchasingPower(round2.id)).toBe(1000);
    await expectGameError(
      lateCall(await lateCallWindow(round2.id), "hadjar", "max_verstappen"),
      "over_budget",
    );
    expect(await plays()).toHaveLength(0);
    expect((await stateOf(round2.id))!.finalFixVersionId).toBeNull();
  });

  it("a second one-swap Late Call version for the same event is refused", async () => {
    const first = await lockedRound2();
    const now = await lateCallWindow(round2.id);
    await lateCall(now, "hadjar", "lawson");
    // Another single swap against the locked lineup, inside the window, with
    // Late Call played: still only one Late Call version per event.
    const { race } = await weekend(round2.id);
    const other = await picksOf(
      ["norris", "piastri", "hulkenberg", "hadjar", "ocon"],
      CONSTRUCTORS,
    );
    const insert = t.db.transaction(async (tx) => {
      const id = newId();
      await tx.insert(lineupVersions).values({
        id,
        teamId,
        forEventId: round2.id,
        kind: "final_fix",
        effectiveFromSessionId: race.id,
        basedOnVersionId: first.versionId,
      });
      await tx
        .insert(lineupPicks)
        .values(other.map((p) => ({ lineupVersionId: id, ...p })));
    });
    const error = await insert.then(
      () => undefined,
      (e: unknown) => e,
    );
    await expectPgError(Promise.reject(error), UNIQUE_VIOLATION);
    const mapped = refusal(error);
    expect(mapped).toBeInstanceOf(GameError);
    expect((mapped as GameError).code).toBe("chip_unavailable");
    expect(
      await t.db
        .select()
        .from(lineupVersions)
        .where(eq(lineupVersions.kind, "final_fix")),
    ).toHaveLength(1);
  });

  it("a lock record can't point at another team's or event's Late Call or chip", async () => {
    const other = await team("Two");
    const first = await saveFor(round1, await picksOf());
    await saveFor(round1, await picksOf(), other);
    await advance(round1, round2);
    await lockRound(t.db, gameId, round2.id);
    const { versionId, chipPlayId } = await lateCall(
      await lateCallWindow(round2.id),
      "hadjar",
      "lawson",
    );
    const rowOf = (eventId: string, id: string) =>
      and(eq(teamEventStates.teamId, id), eq(teamEventStates.eventId, eventId));
    const point = (
      eventId: string,
      id: string,
      set: { finalFixVersionId?: string; chipPlayId?: string },
    ) => t.db.update(teamEventStates).set(set).where(rowOf(eventId, id));

    // Another team's.
    await expectPgError(
      point(round2.id, other, { finalFixVersionId: versionId }),
      CHECK_VIOLATION,
    );
    await expectPgError(
      point(round2.id, other, { chipPlayId }),
      CHECK_VIOLATION,
    );
    // Another event's.
    await expectPgError(
      point(round1.id, teamId, { finalFixVersionId: versionId }),
      CHECK_VIOLATION,
    );
    await expectPgError(
      point(round1.id, teamId, { chipPlayId }),
      CHECK_VIOLATION,
    );
    // A version of the team and event that isn't a Late Call one.
    await expectPgError(
      point(round1.id, teamId, { finalFixVersionId: first.versionId }),
      CHECK_VIOLATION,
    );
    expect(await stateOf(round2.id, other)).toMatchObject({
      finalFixVersionId: null,
      chipPlayId: null,
    });
    expect(await stateOf(round2.id)).toMatchObject({
      finalFixVersionId: versionId,
      chipPlayId,
    });
  });

  it("after Late Call, the next event's base is the locked lineup, not the Late Call one", async () => {
    const first = await lockedRound2();
    const now = await lateCallWindow(round2.id);
    const { versionId } = await lateCall(now, "hadjar", "lawson");
    const round3 = await round(3);
    const opened = await at(new Date(now.getTime() + 24 * HOUR_MS));
    await openRound(t.db, opened, gameId, round3.id);
    // Round 2 used none of its two free transfers, so one carries in.
    expect(await baseState(round3.id)).toEqual({
      base_version_id: first.versionId,
      bank: 1000 - COST,
      carry_in: 1,
      is_first: false,
    });
    await lockRound(t.db, gameId, round3.id);
    const row = await stateOf(round3.id);
    expect(row).toMatchObject({
      baseVersionId: first.versionId,
      lockedVersionId: first.versionId,
      finalFixVersionId: null,
      transfersMade: 0,
    });
    expect(row!.lockedVersionId).not.toBe(versionId);
  });
});
