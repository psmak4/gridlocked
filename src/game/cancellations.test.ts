import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq, like } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import {
  lockRound,
  openRound,
  round2026,
  seedGame2026,
} from "../../tests/helpers/game-2026";
import {
  assetPrices,
  auditLog,
  chipPlays,
  events,
  gameEvents,
  gameSessionExceptions,
  leagues,
  reviewItems,
  sessions,
  teamEventStates,
  teams,
} from "@/db/schema";
import { seedUser } from "../../tests/helpers/users";
import { setSimulatedClock } from "@/replay/clock-loop";
import type { StaffActor } from "@/staff/roster";
import { clearSessionException, setSessionException } from "./cancellations";
import { playChip } from "./chips";
import { GameError } from "./errors";
import { planGameEvents } from "./games";
import { checkGameInvariants } from "./invariants";
import { lockedLineup, openGame, saveLineup, type LineupPick } from "./lineups";
import { lockEvent } from "./lock";
import { withdrawPoolAsset } from "./pool";
import { priceList, publishPrices } from "./prices";
import { createTeam } from "./teams";
import { createLeague } from "@/leagues/leagues";

// Cancelled events and abandoned sessions (DM 3.9, 3.11) over the recorded
// 2026 game: one test for each cancellation row. Round 1 (Australia) is the
// teams' first event; round 2 (China) is the one cancelled, before its lock
// unless a test says otherwise, and round 3 (Japan) the event after it.
// Cancelling is what the calendar sync does: the event's row is `cancelled`,
// then planGameEvents brings the game in line.

const NOW = new Date("2026-02-01T09:00:00.000Z");
const HOUR_MS = 3_600_000;
const ACTOR: StaffActor = { kind: "admin", label: "staff" };
// 280 + 250 + 95 + 85 + 80 + 90 + 70 = 950, leaving 50 in the bank.
const DRIVERS = ["norris", "piastri", "hulkenberg", "hadjar", "bearman"];
const CONSTRUCTORS = ["haas", "audi"];
const COST = 950;

describe("cancellations (DM 3.9)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let game: Awaited<ReturnType<typeof seedGame2026>>;
  let gameId: string;
  let round1: { id: string; lockAt: Date };
  let round2: { id: string; lockAt: Date };
  let round3: { id: string; lockAt: Date };
  let teamId: string;

  beforeEach(async () => {
    t = await createTestDb();
    game = await seedGame2026(t.db, NOW);
    gameId = game.gameId;
    await setSimulatedClock(t.db, NOW);
    round1 = await round2026(t.db, 1);
    round2 = await round2026(t.db, 2);
    round3 = await round2026(t.db, 3);
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
  const before = (event: { lockAt: Date }, hours: number) =>
    at(new Date(event.lockAt.getTime() - hours * HOUR_MS));
  /** Saves `hours` before the event's lock, with both clocks there. */
  const saveFor = async (
    event: { lockAt: Date },
    picks: LineupPick[],
    id = teamId,
    hours = 1,
  ) =>
    saveLineup(t.db, await before(event, hours), {
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
    playChip(t.db, await before(event, 1), {
      teamId: id,
      chipCode,
      targetAssetId:
        target === undefined ? undefined : await game.assetId(target),
    });
  /** Locks round 1, then opens round 2 an hour later. */
  const toRound2 = async () => {
    const locked = await lockRound(t.db, gameId, round1.id);
    const opened = await at(new Date(locked.getTime() + HOUR_MS));
    await openRound(t.db, opened, gameId, round2.id);
    return opened;
  };
  /**
   * The event is cancelled in the calendar, half an hour before its lock
   * unless `now` is given, and the game is planned again, as the sync does.
   */
  const cancel = async (event: { id: string; lockAt: Date }, now?: Date) => {
    const when =
      now ?? (await at(new Date(event.lockAt.getTime() - HOUR_MS / 2)));
    await t.db
      .update(events)
      .set({ status: "cancelled" })
      .where(eq(events.id, event.id));
    await planGameEvents(t.db, when, gameId);
    return when;
  };
  const gameEventOf = async (eventId: string) =>
    (
      await t.db
        .select()
        .from(gameEvents)
        .where(
          and(eq(gameEvents.gameId, gameId), eq(gameEvents.eventId, eventId)),
        )
    )[0]!;
  const statesAt = (eventId: string) =>
    t.db
      .select()
      .from(teamEventStates)
      .where(eq(teamEventStates.eventId, eventId))
      .orderBy(asc(teamEventStates.teamId));
  const stateOf = async (eventId: string, id = teamId) =>
    (await statesAt(eventId)).find((s) => s.teamId === id);
  const plays = () =>
    t.db.select().from(chipPlays).orderBy(asc(chipPlays.playedAt));

  async function expectGameError(promise: Promise<unknown>, code: string) {
    const error = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error, "expected a GameError").toBeInstanceOf(GameError);
    expect((error as GameError).code).toBe(code);
  }

  it("an event cancelled before lock refunds its chips and writes no state rows", async () => {
    await saveFor(round1, await picksOf());
    await toRound2();
    await play(round2, "chip_autopilot");
    await cancel(round2);

    expect(await gameEventOf(round2.id)).toMatchObject({
      status: "cancelled",
      sequence: null,
    });
    expect((await plays()).map((p) => [p.eventId, p.status])).toEqual([
      [round2.id, "refunded"],
    ]);
    // Nothing locks for it, then or later.
    await expect(
      lockEvent(t.db, round2.lockAt, { gameId, eventId: round2.id }),
    ).rejects.toThrow(/cancelled/);
    await lockRound(t.db, gameId, round3.id);
    expect(await statesAt(round2.id)).toEqual([]);
    expect(await statesAt(round3.id)).toHaveLength(1);
  });

  it("the next event counts transfers against the last real locked lineup, with no extra free transfers", async () => {
    const first = await saveFor(round1, await picksOf());
    await toRound2();
    await cancel(round2);
    // Three out (95 + 85 + 80), three in (72 + 66 + 60).
    const third = await saveFor(
      round3,
      await picksOf(["norris", "piastri", "lawson", "ocon", "stroll"]),
    );
    await lockRound(t.db, gameId, round3.id);

    // Round 1 was the team's first event (no carry-over out), and the
    // cancelled round 2 grants nothing: two free, so one transfer costs.
    expect(await stateOf(round3.id)).toMatchObject({
      baseVersionId: first.versionId,
      lockedVersionId: third.versionId,
      isFirstEvent: false,
      purchasingPower: 1000,
      spent: 888,
      bank: 112,
      transfersMade: 3,
      freeTransfers: 2,
      carryOverOut: 0,
      transferPenalty: -10,
    });
  });

  it("prices don't change across a cancellation", async () => {
    await saveFor(round1, await picksOf());
    // Round 2's own list: two prices moved, the rest carried when it opens.
    await publishPrices(t.db, NOW, {
      gameId,
      eventId: round2.id,
      source: "admin",
      reason: "Price update after Australia",
      actor: ACTOR,
      prices: [
        { assetId: await game.assetId("norris"), price: 290 },
        { assetId: await game.assetId("hadjar"), price: 80 },
      ],
    });
    await toRound2();
    const cancelled = await priceList(t.db, { gameId, eventId: round2.id });
    await cancel(round2);

    // Round 3 had none, so it takes round 2's, not round 1's.
    const next = await priceList(t.db, { gameId, eventId: round3.id });
    expect(next.size).toBe(cancelled.size);
    expect(Object.fromEntries(next)).toEqual(Object.fromEntries(cancelled));
    expect(next.get(await game.assetId("norris"))).toBe(290);
    const sources = await t.db
      .select({ source: assetPrices.source })
      .from(assetPrices)
      .where(eq(assetPrices.eventId, round3.id));
    expect(new Set(sources.map((s) => s.source))).toEqual(new Set(["carried"]));
    // The cancelled event's own list is as it was.
    expect(
      Object.fromEntries(await priceList(t.db, { gameId, eventId: round2.id })),
    ).toEqual(Object.fromEntries(cancelled));
  });

  it("a lineup saved for the cancelled open event counts at the next lock", async () => {
    const first = await saveFor(round1, await picksOf());
    await toRound2();
    // Bearman (80) out, Lawson (72) in.
    const changed = await saveFor(
      round2,
      await picksOf(["norris", "piastri", "hulkenberg", "hadjar", "lawson"]),
    );
    // A team that joined in round 2's window and saved only for it.
    const late = await team("Late");
    const lateLineup = await saveFor(round2, await picksOf(), late);
    await cancel(round2);

    // Nothing saved for round 3: the round 2 saves are what counts.
    expect(
      (await lockedLineup(t.db, { teamId, eventId: round3.id }))?.versionId,
    ).toBe(changed.versionId);
    await lockRound(t.db, gameId, round3.id);
    expect(await stateOf(round3.id)).toMatchObject({
      baseVersionId: first.versionId,
      lockedVersionId: changed.versionId,
      purchasingPower: 1000,
      spent: COST - 8,
      bank: 1000 - COST + 8,
      transfersMade: 1,
      freeTransfers: 2,
      carryOverOut: 1,
      transferPenalty: 0,
    });
    expect(await stateOf(round3.id, late)).toMatchObject({
      baseVersionId: null,
      lockedVersionId: lateLineup.versionId,
      isFirstEvent: true,
      purchasingPower: 1000,
      transfersMade: 7,
      freeTransfers: null,
    });
    const [lateTeam] = await t.db
      .select()
      .from(teams)
      .where(eq(teams.id, late));
    expect(lateTeam!.firstEventId).toBe(round3.id);
  });

  it("a lineup carried from the cancelled event that is over budget at the next one doesn't count, and the base does", async () => {
    const first = await saveFor(round1, await picksOf());
    await toRound2();
    // Alonso costs 200 at round 3, which hasn't opened yet.
    const alonso = await game.assetId("alonso");
    await publishPrices(t.db, round2.lockAt, {
      gameId,
      eventId: round3.id,
      source: "admin",
      reason: "Price update for Japan",
      actor: ACTOR,
      prices: [{ assetId: alonso, price: 200 }],
    });
    // Bearman (80) out, Alonso (110 at round 2) in: 980 of 1000.
    await saveFor(
      round2,
      await picksOf(["norris", "piastri", "hulkenberg", "hadjar", "alonso"]),
    );
    await cancel(round2);

    // Nothing saved for round 3, where that lineup costs 1070 of 1000: the
    // team's round 1 lineup carries, and round 3 locks.
    expect(
      (await lockedLineup(t.db, { teamId, eventId: round3.id }))?.versionId,
    ).toBe(first.versionId);
    await lockRound(t.db, gameId, round3.id);
    expect(await stateOf(round3.id)).toMatchObject({
      baseVersionId: first.versionId,
      lockedVersionId: first.versionId,
      purchasingPower: 1000,
      spent: COST,
      transfersMade: 0,
    });
    // The season check works out the same lineup.
    expect(await checkGameInvariants(t.db, gameId)).toEqual([]);
  });

  it("a lineup carried from the cancelled event with an asset withdrawn from the next one doesn't count, and the base does", async () => {
    const first = await saveFor(round1, await picksOf());
    const opened = await toRound2();
    await withdrawPoolAsset(t.db, opened, {
      assetId: await game.assetId("bottas"),
      fromEventId: round3.id,
      reason: "Leaves after China",
      actor: ACTOR,
    });
    // Bearman out, Bottas in: pickable at round 2, not at round 3, and the
    // team never owned him.
    await saveFor(
      round2,
      await picksOf(["norris", "piastri", "hulkenberg", "hadjar", "bottas"]),
    );
    await cancel(round2);

    expect(
      (await lockedLineup(t.db, { teamId, eventId: round3.id }))?.versionId,
    ).toBe(first.versionId);
    await lockRound(t.db, gameId, round3.id);
    expect(await stateOf(round3.id)).toMatchObject({
      lockedVersionId: first.versionId,
      spent: COST,
      transfersMade: 0,
    });
    expect(await checkGameInvariants(t.db, gameId)).toEqual([]);
  });

  it("a Blank Cheque lineup saved for the cancelled event doesn't count, and the regular one before it does", async () => {
    await saveFor(round1, await picksOf());
    await toRound2();
    const regular = await saveFor(
      round2,
      await picksOf(["norris", "piastri", "hulkenberg", "hadjar", "lawson"]),
      teamId,
      3,
    );
    await play(round2, "chip_limitless");
    // Far over the budget, as only Blank Cheque allows.
    await saveFor(
      round2,
      await picksOf(
        ["norris", "piastri", "russell", "max_verstappen", "leclerc"],
        ["mclaren", "mercedes"],
      ),
    );
    await cancel(round2);

    // The chip is refunded, so its temporary lineup goes with it.
    await lockRound(t.db, gameId, round3.id);
    expect(await stateOf(round3.id)).toMatchObject({
      lockedVersionId: regular.versionId,
      chipPlayId: null,
      transfersMade: 1,
    });
  });

  it("the x3 Boost at the next event is checked against the lineup carried from the cancelled one", async () => {
    await saveFor(round1, await picksOf());
    await toRound2();
    // Hadjar out, Lawson in, and nothing saved for round 3.
    await saveFor(
      round2,
      await picksOf(["norris", "piastri", "hulkenberg", "lawson", "bearman"]),
    );
    await cancel(round2);

    await expectGameError(
      play(round3, "chip_triple_boost", teamId, "hadjar"),
      "composition",
    );
    await play(round3, "chip_triple_boost", teamId, "lawson");
    await lockRound(t.db, gameId, round3.id);
    expect((await stateOf(round3.id))!.chipPlayId).not.toBeNull();
  });

  it("the next event opens at once when the open event is cancelled", async () => {
    await saveFor(round1, await picksOf());
    await toRound2();
    const when = await cancel(round2);

    const next = await gameEventOf(round3.id);
    expect(next).toMatchObject({ status: "open", sequence: 2 });
    expect(next.pricesReadyAt).toEqual(when);
    expect(
      (await priceList(t.db, { gameId, eventId: round3.id })).size,
    ).toBeGreaterThan(0);
    // Saves go to round 3 straight away.
    const saved = await saveLineup(t.db, when, {
      teamId,
      picks: await picksOf(),
      basedOnVersionId: null,
    });
    expect(
      (await lockedLineup(t.db, { teamId, eventId: round3.id }))?.versionId,
    ).toBe(saved.versionId);

    // Planning again changes nothing.
    const rows = await t.db
      .select()
      .from(gameEvents)
      .where(eq(gameEvents.gameId, gameId));
    await planGameEvents(t.db, new Date(when.getTime() + HOUR_MS), gameId);
    expect(
      await t.db.select().from(gameEvents).where(eq(gameEvents.gameId, gameId)),
    ).toEqual(rows);
  });

  it("the event opened for a cancelled one carries an owned asset's price, though its list was complete when published", async () => {
    const bearman = await game.assetId("bearman");
    await withdrawPoolAsset(t.db, NOW, {
      assetId: bearman,
      fromEventId: round3.id,
      reason: "Leaves after China",
      actor: ACTOR,
    });
    // Round 3's full list, published before anyone owned Bearman.
    await publishPrices(t.db, NOW, {
      gameId,
      eventId: round3.id,
      source: "admin",
      reason: "Early prices for Japan",
      actor: ACTOR,
      prices: [...(await priceList(t.db, { gameId, eventId: round1.id }))]
        .filter(([assetId]) => assetId !== bearman)
        .map(([assetId, price]) => ({ assetId, price })),
    });
    expect((await gameEventOf(round3.id)).pricesReadyAt).toEqual(NOW);
    await saveFor(round1, await picksOf());
    await toRound2();
    const when = await cancel(round2);

    // Round 3 opens with Bearman's price carried, so his owner can save and
    // lock with him.
    const saved = await saveLineup(t.db, when, {
      teamId,
      picks: await picksOf(),
      basedOnVersionId: null,
    });
    await lockRound(t.db, gameId, round3.id);
    expect(await stateOf(round3.id)).toMatchObject({
      lockedVersionId: saved.versionId,
      spent: COST,
    });
    expect(
      (await priceList(t.db, { gameId, eventId: round3.id })).get(bearman),
    ).toBe(80);
  });

  /**
   * `t.db` for planGameEvents, with `race` run in its transaction just before
   * its first write to game_events: as if another transaction (the lock job's
   * last batch) committed between planning's read and that write.
   */
  function racing(race: (tx: typeof t.db) => Promise<unknown>): typeof t.db {
    let raced = false;
    type Query = PromiseLike<unknown> & {
      returning: (...args: unknown[]) => Query;
    };
    const after = (tx: typeof t.db, query: Query): Query => ({
      returning: (...args) => after(tx, query.returning(...args)),
      then: (done, failed) =>
        race(tx)
          .then(() => query)
          .then(done, failed),
    });
    const wrap = (tx: typeof t.db) =>
      new Proxy(tx, {
        get(target, prop) {
          if (prop === "update") {
            return (table: typeof gameEvents) => {
              const builder = target.update(table);
              if (table !== gameEvents || raced) return builder;
              raced = true;
              return {
                set: (values: Parameters<typeof builder.set>[0]) => ({
                  where: (
                    where: Parameters<
                      ReturnType<typeof builder.set>["where"]
                    >[0],
                  ) =>
                    after(
                      target,
                      builder.set(values).where(where) as unknown as Query,
                    ),
                }),
              };
            };
          }
          const value: unknown = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    return new Proxy(t.db, {
      get(target, prop) {
        if (prop === "transaction") {
          return (run: (tx: typeof t.db) => Promise<unknown>) =>
            target.transaction((tx) => run(wrap(tx as unknown as typeof t.db)));
        }
        const value: unknown = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  it("planning that loses a race with the lock leaves the locked event alone", async () => {
    await saveFor(round1, await picksOf());
    await play(round1, "chip_autopilot");
    // The calendar calls round 1 off just as it locks: planning reads it
    // `open`, and the lock's last batch commits before planning writes.
    await t.db
      .update(events)
      .set({ status: "cancelled" })
      .where(eq(events.id, round1.id));
    const when = await at(new Date(round1.lockAt.getTime() - 1000));
    const lock = (tx: typeof t.db) =>
      tx
        .update(gameEvents)
        .set({ status: "locked" })
        .where(
          and(eq(gameEvents.gameId, gameId), eq(gameEvents.eventId, round1.id)),
        );
    await expect(planGameEvents(racing(lock), when, gameId)).rejects.toThrow(
      /no longer open/,
    );

    // Nothing planning did stays: round 1 is as the lock left it, its chip
    // played, and round 2 neither renumbered nor opened.
    await lock(t.db);
    expect(await gameEventOf(round1.id)).toMatchObject({
      status: "locked",
      sequence: 1,
    });
    expect(await gameEventOf(round2.id)).toMatchObject({
      status: "upcoming",
      sequence: 2,
    });
    expect((await plays()).map((p) => p.status)).toEqual(["played"]);
  });

  /** The calendar reinstates a cancelled event, and the game is planned again. */
  const reinstate = async (event: { id: string }, when: Date) => {
    await t.db
      .update(events)
      .set({ status: "scheduled" })
      .where(eq(events.id, event.id));
    await planGameEvents(t.db, when, gameId);
  };

  it("an event reinstated after a later one opened stays cancelled in the game, for an admin to look at", async () => {
    await saveFor(round1, await picksOf(), teamId, 2);
    const cancelled = await cancel(round1);
    expect(await gameEventOf(round2.id)).toMatchObject({
      status: "open",
      sequence: 1,
    });
    // Back on the calendar before its own lock, with round 2 open.
    await reinstate(round1, await at(new Date(cancelled.getTime() + 60_000)));

    expect(await gameEventOf(round1.id)).toMatchObject({
      status: "cancelled",
      sequence: null,
    });
    expect(await gameEventOf(round2.id)).toMatchObject({
      status: "open",
      sequence: 1,
    });
    const items = await t.db
      .select()
      .from(reviewItems)
      .where(eq(reviewItems.kind, "game_event_reinstated"));
    expect(items).toMatchObject([
      {
        status: "open",
        severity: "warning",
        eventId: round1.id,
        dedupeKey: `game_event_reinstated:${gameId}:${round1.id}`,
        details: { gameId, openEventId: round2.id },
      },
    ]);
    // Round 2 still locks, with the lineup saved for round 1.
    await lockRound(t.db, gameId, round2.id);
    expect(await stateOf(round2.id)).toMatchObject({ isFirstEvent: true });
  });

  it("an event reinstated before any later one opened is back in the game", async () => {
    await saveFor(round1, await picksOf());
    const opened = await toRound2();
    await cancel(round3, opened);
    await reinstate(round3, await at(new Date(opened.getTime() + HOUR_MS)));

    expect(await gameEventOf(round3.id)).toMatchObject({
      status: "upcoming",
      sequence: 3,
    });
    expect(
      await t.db
        .select()
        .from(reviewItems)
        .where(eq(reviewItems.kind, "game_event_reinstated")),
    ).toEqual([]);
  });

  it("an upcoming event cancelled while another is open opens nothing", async () => {
    await saveFor(round1, await picksOf());
    const opened = await toRound2();
    await cancel(round3, opened);

    expect(await gameEventOf(round2.id)).toMatchObject({
      status: "open",
      sequence: 2,
    });
    expect(await gameEventOf(round3.id)).toMatchObject({
      status: "cancelled",
      sequence: null,
    });
    const round4 = await round2026(t.db, 4);
    expect(await gameEventOf(round4.id)).toMatchObject({
      status: "upcoming",
      sequence: 3,
      pricesReadyAt: null,
    });
  });

  it("a race cancelled after qualifying keeps its chips played and its state rows", async () => {
    await saveFor(round1, await picksOf());
    await toRound2();
    const chip = await play(round2, "chip_autopilot");
    await lockRound(t.db, gameId, round2.id);
    const rows = await statesAt(round2.id);
    expect(rows).toHaveLength(1);

    // Called off after qualifying: the race, then the whole event.
    const after = await at(new Date(round2.lockAt.getTime() + 24 * HOUR_MS));
    await t.db
      .update(sessions)
      .set({ status: "cancelled" })
      .where(and(eq(sessions.eventId, round2.id), eq(sessions.kind, "race")));
    await cancel(round2, after);

    expect(await gameEventOf(round2.id)).toMatchObject({
      status: "locked",
      sequence: 2,
    });
    expect((await plays()).map((p) => [p.id, p.status])).toEqual([
      [chip, "played"],
    ]);
    expect(await statesAt(round2.id)).toEqual(rows);
    expect(rows[0]!.chipPlayId).toBe(chip);
    expect((await gameEventOf(round3.id)).sequence).toBe(3);
  });

  it("an event cancelled between two lock batches still locks, and its chips stay played", async () => {
    const other = await team("Two");
    await saveFor(round1, await picksOf());
    await toRound2();
    await saveFor(round2, await picksOf(), other);
    const chips = [
      await play(round2, "chip_autopilot"),
      await play(round2, "chip_no_negative", other),
    ];
    // The lock has started: one team of two is written.
    await at(round2.lockAt);
    const first = await lockEvent(t.db, round2.lockAt, {
      gameId,
      eventId: round2.id,
      limit: 1,
    });
    expect(first).toMatchObject({ written: 1, done: false });

    // The calendar says cancelled now, and the sync plans the game again;
    // also with a clock that is behind, so the rows decide it on their own.
    await cancel(round2, new Date(round2.lockAt.getTime() - 60_000));
    await cancel(round2, await at(new Date(round2.lockAt.getTime() + 60_000)));
    expect(await gameEventOf(round2.id)).toMatchObject({
      status: "open",
      sequence: 2,
    });
    expect(await gameEventOf(round3.id)).toMatchObject({
      status: "upcoming",
      sequence: 3,
    });
    expect((await plays()).map((p) => p.status)).toEqual(["played", "played"]);

    // The lock job finishes, and the event stays locked from then on.
    const rest = await lockEvent(t.db, round2.lockAt, {
      gameId,
      eventId: round2.id,
      afterTeamId: first.lastTeamId!,
      limit: 1,
    });
    expect(rest.done).toBe(true);
    await planGameEvents(t.db, round2.lockAt, gameId);
    expect(await gameEventOf(round2.id)).toMatchObject({
      status: "locked",
      sequence: 2,
    });
    const rows = await statesAt(round2.id);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.chipPlayId))).toEqual(new Set(chips));
    expect((await plays()).map((p) => p.status)).toEqual(["played", "played"]);
  });

  it("a pool seeded from a round that's then cancelled is still pickable at the next round", async () => {
    // Round 1, where the pool starts, is called off with its window open.
    await cancel(round1);
    expect(await gameEventOf(round2.id)).toMatchObject({
      status: "open",
      sequence: 1,
    });
    const saved = await saveFor(round2, await picksOf());
    await lockRound(t.db, gameId, round2.id);
    expect(await stateOf(round2.id)).toMatchObject({
      lockedVersionId: saved.versionId,
      isFirstEvent: true,
      spent: COST,
    });
  });

  it("an asset withdrawn from a cancelled round is withdrawn from the next one", async () => {
    await saveFor(round1, await picksOf());
    const opened = await toRound2();
    await withdrawPoolAsset(t.db, opened, {
      assetId: await game.assetId("hadjar"),
      fromEventId: round3.id,
      reason: "Leaves the team",
      actor: ACTOR,
    });
    await cancel(round3, opened);
    const locked = await lockRound(t.db, gameId, round2.id);
    const round4 = await round2026(t.db, 4);
    await openRound(
      t.db,
      await at(new Date(locked.getTime() + HOUR_MS)),
      gameId,
      round4.id,
    );

    // Withdrawn from round 4 on: a new team can't buy him, his owner keeps him.
    const buyer = await team("Buyer");
    await expectGameError(
      saveFor(round4, await picksOf(), buyer),
      "asset_unavailable",
    );
    await saveFor(round4, await picksOf(DRIVERS, CONSTRUCTORS, "piastri"));
  });

  it("a refunded chip can be played again later", async () => {
    await saveFor(round1, await picksOf());
    await toRound2();
    const first = await play(round2, "chip_wildcard");
    await cancel(round2);

    const again = await play(round3, "chip_wildcard");
    expect((await plays()).map((p) => [p.id, p.eventId, p.status])).toEqual([
      [first, round2.id, "refunded"],
      [again, round3.id, "played"],
    ]);
  });

  it("a session exception is audited, and a second one for the same session is refused", async () => {
    const [race] = await t.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.eventId, round1.id), eq(sessions.kind, "race")));
    const input = {
      gameId,
      sessionId: race!.id,
      policy: "skip" as const,
      reason: "Abandoned after two laps behind the safety car",
      actor: ACTOR,
    };
    const exceptions = () => t.db.select().from(gameSessionExceptions);
    const audits = () =>
      t.db
        .select()
        .from(auditLog)
        .where(like(auditLog.action, "game_session_exception.%"))
        .orderBy(asc(auditLog.id));

    await expect(
      setSessionException(t.db, NOW, { ...input, reason: "  " }),
    ).rejects.toThrow(/reason/);
    expect(await exceptions()).toEqual([]);

    await setSessionException(t.db, NOW, input);
    expect(await exceptions()).toEqual([
      expect.objectContaining({
        gameId,
        sessionId: race!.id,
        policy: "skip",
        reason: input.reason,
        decidedAt: NOW,
      }),
    ]);
    expect(await audits()).toEqual([
      expect.objectContaining({
        actorKind: "admin",
        actorLabel: "staff",
        action: "game_session_exception.set",
        entityType: "game_session_exception",
        entityId: race!.id,
        before: null,
        after: { gameId, policy: "skip" },
        reason: input.reason,
      }),
    ]);

    await expect(
      setSessionException(t.db, NOW, { ...input, reason: "Again" }),
    ).rejects.toThrow();
    expect(await exceptions()).toHaveLength(1);
    expect(await audits()).toHaveLength(1);

    // Cleared, with its own reason, and then it can be set again.
    const later = new Date(NOW.getTime() + HOUR_MS);
    await expect(
      clearSessionException(t.db, later, { ...input, reason: "" }),
    ).rejects.toThrow(/reason/);
    await clearSessionException(t.db, later, {
      gameId,
      sessionId: race!.id,
      reason: "Stewards reinstated the result",
      actor: ACTOR,
    });
    expect(await exceptions()).toEqual([]);
    expect((await audits()).at(-1)).toMatchObject({
      action: "game_session_exception.clear",
      entityId: race!.id,
      before: { gameId, policy: "skip", reason: input.reason },
      after: null,
      reason: "Stewards reinstated the result",
    });
    await expect(
      clearSessionException(t.db, later, {
        gameId,
        sessionId: race!.id,
        reason: "Nothing to clear",
        actor: ACTOR,
      }),
    ).rejects.toThrow();
    await setSessionException(t.db, later, input);
    expect(await exceptions()).toHaveLength(1);
    expect(await audits()).toHaveLength(3);
  });
  describe("mini-league ranges follow their events (DM 4.5)", () => {
    const sequenceOf = async (event: { id: string }) => {
      const [row] = await t.db
        .select({ sequence: gameEvents.sequence })
        .from(gameEvents)
        .where(
          and(eq(gameEvents.gameId, gameId), eq(gameEvents.eventId, event.id)),
        );
      return row!.sequence!;
    };
    /** A private league from one round to another; no end means the season. */
    const leagueOn = async (from: number, to?: number) => {
      const { leagueId } = await createLeague(t.db, NOW, {
        gameId,
        ownerUserId: await seedUser(t.db),
        kind: "private",
        name: "Range",
        startSequence: await sequenceOf(await round2026(t.db, from)),
        endSequence:
          to === undefined
            ? undefined
            : await sequenceOf(await round2026(t.db, to)),
      });
      return leagueId;
    };
    const rangeOf = async (leagueId: string) => {
      const [row] = await t.db
        .select()
        .from(leagues)
        .where(eq(leagues.id, leagueId));
      return row!;
    };
    /** The real events a league covers now, in order. */
    const eventsOf = async (leagueId: string) => {
      const { startSequence, endSequence } = await rangeOf(leagueId);
      const rows = await t.db
        .select({ eventId: gameEvents.eventId, sequence: gameEvents.sequence })
        .from(gameEvents)
        .where(eq(gameEvents.gameId, gameId))
        .orderBy(asc(gameEvents.sequence));
      return rows
        .filter(
          (r) =>
            r.sequence !== null &&
            r.sequence >= startSequence &&
            (endSequence === null || r.sequence <= endSequence),
        )
        .map((r) => r.eventId);
    };
    const ids = async (...rounds: number[]) =>
      Promise.all(rounds.map(async (n) => (await round2026(t.db, n)).id));

    it("a league after the cancelled event stays on the same races", async () => {
      const league = await leagueOn(3, 5);
      await cancel(round2);
      expect(await eventsOf(league)).toEqual(await ids(3, 4, 5));
    });

    it("a league across the cancelled event keeps the races around it", async () => {
      const league = await leagueOn(1, 3);
      await cancel(round2);
      expect(await eventsOf(league)).toEqual(await ids(1, 3));
    });

    it("a league starting on the cancelled event starts at the next race", async () => {
      const league = await leagueOn(2, 4);
      await cancel(round2);
      expect(await eventsOf(league)).toEqual(await ids(3, 4));
    });

    it("a league ending on the cancelled event ends at the race before it", async () => {
      const league = await leagueOn(1, 2);
      await cancel(round2);
      expect(await eventsOf(league)).toEqual(await ids(1));
    });

    it("a league on only the cancelled event moves to the next race", async () => {
      const league = await leagueOn(2, 2);
      await cancel(round2);
      expect(await eventsOf(league)).toEqual(await ids(3));
    });

    it("a league with no end keeps none", async () => {
      const league = await leagueOn(3);
      await cancel(round2);
      const row = await rangeOf(league);
      expect(row.startSequence).toBe(await sequenceOf(round3));
      expect(row.endSequence).toBeNull();
    });

    it("planning again changes nothing", async () => {
      const league = await leagueOn(3, 5);
      await cancel(round2);
      const first = await rangeOf(league);
      await planGameEvents(t.db, new Date(NOW.getTime() + HOUR_MS), gameId);
      expect(await rangeOf(league)).toEqual(first);
    });

    it("a reinstated event moves the ranges back", async () => {
      const league = await leagueOn(3, 5);
      await cancel(round2);
      await t.db
        .update(events)
        .set({ status: "scheduled" })
        .where(eq(events.id, round2.id));
      await planGameEvents(t.db, NOW, gameId);
      expect(await eventsOf(league)).toEqual(await ids(3, 4, 5));
    });
  });
});
