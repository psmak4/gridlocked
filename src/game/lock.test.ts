import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asc, eq, sql, TransactionRollbackError } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import {
  lockRound,
  openRound,
  round2026,
  seedGame2026,
} from "../../tests/helpers/game-2026";
import {
  assetPrices,
  gameEvents,
  games,
  lineupPicks,
  lineupVersions,
  teamEventStates,
  teams,
} from "@/db/schema";
import { newId } from "@/lib/ids";
import { setSimulatedClock } from "@/replay/clock-loop";
import type { StaffActor } from "@/staff/roster";
import { saveLineup, openGame, type LineupPick } from "./lineups";
import { lockEvent } from "./lock";
import { withdrawPoolAsset } from "./pool";
import { publishPrices } from "./prices";
import { createTeam, removeTeam } from "./teams";

// The per-event lock record (DM 3.8) over the recorded 2026 game. Prices are
// the fixture's, carried from round 1 unless a test sets one.

const NOW = new Date("2026-02-01T09:00:00.000Z");
const HOUR_MS = 3_600_000;
const ACTOR: StaffActor = { kind: "admin", label: "staff" };
// 280 + 250 + 95 + 85 + 80 + 90 + 70 = 950, leaving 50 in the bank.
const DRIVERS = ["norris", "piastri", "hulkenberg", "hadjar", "bearman"];
const CONSTRUCTORS = ["haas", "audi"];
const COST = 950;
// The same drivers with Williams and Cadillac: exactly the $100M budget.
const EXACT = ["williams", "cadillac"];

describe("lockEvent (DM 3.8)", () => {
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
  const team = (name: string) =>
    createTeam(t.db, NOW, { gameId, userId: newId(), name });

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
  /** Saves one hour before the event's lock, with both clocks there. */
  const saveFor = async (
    event: { lockAt: Date },
    picks: LineupPick[],
    id = teamId,
    hoursBefore = 1,
  ) => {
    const now = new Date(event.lockAt.getTime() - hoursBefore * HOUR_MS);
    await setSimulatedClock(t.db, now);
    return saveLineup(t.db, now, { teamId: id, picks, basedOnVersionId: null });
  };
  /** Locks `from`, then opens `to` an hour later. */
  const advance = async (from: { id: string }, to: { id: string }) => {
    const at = await lockRound(t.db, gameId, from.id);
    const opened = new Date(at.getTime() + HOUR_MS);
    await setSimulatedClock(t.db, opened);
    await openRound(t.db, opened, gameId, to.id);
    return opened;
  };
  const states = (eventId?: string) =>
    t.db
      .select()
      .from(teamEventStates)
      .where(eventId ? eq(teamEventStates.eventId, eventId) : undefined)
      .orderBy(asc(teamEventStates.teamId), asc(teamEventStates.eventId));
  const stateOf = async (eventId: string, id = teamId) =>
    (await states(eventId)).find((s) => s.teamId === id);
  const firstEventOf = async (id = teamId) =>
    (await t.db.select().from(teams).where(eq(teams.id, id)))[0]!.firstEventId;
  const purchasingPower = async (eventId: string, id = teamId) => {
    const { rows } = await t.db.execute(
      sql`select team_purchasing_power(${id}::uuid, ${eventId}::uuid) as power`,
    );
    return (rows[0] as { power: number }).power;
  };
  /** Sets an admin price for each key at the event. */
  const adminPrices = async (
    eventId: string,
    now: Date,
    prices: Record<string, number>,
  ) =>
    publishPrices(t.db, now, {
      gameId,
      eventId,
      source: "admin",
      reason: "Price correction",
      actor: ACTOR,
      prices: await Promise.all(
        Object.entries(prices).map(async ([key, price]) => ({
          assetId: await game.assetId(key),
          price,
        })),
      ),
    });
  const round = async (n: number) => round2026(t.db, n);

  it("the first event: purchasing power is the budget, transfers are unlimited, and first_event_id is set", async () => {
    const { versionId } = await saveFor(round1, await picksOf());
    expect(await purchasingPower(round1.id)).toBe(1000);
    await lockRound(t.db, gameId, round1.id);

    const row = await stateOf(round1.id);
    expect(row).toMatchObject({
      gameId,
      baseVersionId: null,
      lockedVersionId: versionId,
      finalFixVersionId: null,
      isFirstEvent: true,
      purchasingPower: 1000,
      spent: COST,
      bank: 1000 - COST,
      transfersMade: 7,
      freeTransfers: null,
      carryOverOut: 0,
      transferPenalty: 0,
    });
    const [ge] = await t.db
      .select()
      .from(gameEvents)
      .where(eq(gameEvents.eventId, round1.id));
    expect(row!.rulesetVersionId).toBe(ge!.rulesetVersionId);
    expect(ge!.status).toBe("locked");
    expect(await firstEventOf()).toBe(round1.id);
    const [g] = await t.db.select().from(games).where(eq(games.id, gameId));
    expect(g!.status).toBe("running");
  });

  it("a team's second event counts transfers against the first locked lineup", async () => {
    const first = await saveFor(round1, await picksOf());
    await advance(round1, round2);
    // Three out (95 + 85 + 80), three in (72 + 66 + 60).
    const second = await saveFor(
      round2,
      await picksOf(["norris", "piastri", "lawson", "ocon", "stroll"]),
    );
    expect(await purchasingPower(round2.id)).toBe(1000);
    await lockRound(t.db, gameId, round2.id);

    expect(await stateOf(round2.id)).toMatchObject({
      baseVersionId: first.versionId,
      lockedVersionId: second.versionId,
      isFirstEvent: false,
      purchasingPower: 1000,
      spent: 888,
      bank: 112,
      transfersMade: 3,
      freeTransfers: 2,
      carryOverOut: 0,
      transferPenalty: -10,
    });
    expect(await firstEventOf()).toBe(round1.id);
  });

  it("out and back in across two saves in one window is free", async () => {
    const first = await saveFor(round1, await picksOf());
    await advance(round1, round2);
    await saveFor(
      round2,
      await picksOf(["norris", "piastri", "hulkenberg", "hadjar", "stroll"]),
      teamId,
      3,
    );
    const back = await saveFor(round2, await picksOf(), teamId, 2);
    await lockRound(t.db, gameId, round2.id);

    expect(await stateOf(round2.id)).toMatchObject({
      baseVersionId: first.versionId,
      lockedVersionId: back.versionId,
      transfersMade: 0,
      freeTransfers: 2,
      carryOverOut: 1,
      transferPenalty: 0,
      purchasingPower: 1000,
      spent: COST,
      bank: 50,
    });
  });

  it("an owned asset's price rise raises purchasing power", async () => {
    const first = await saveFor(round1, await picksOf());
    const at = await lockRound(t.db, gameId, round1.id);
    await adminPrices(round2.id, at, { norris: 300 });
    await openRound(t.db, at, gameId, round2.id);
    expect(await purchasingPower(round2.id)).toBe(1020);

    // No save: the base carries forward and is worth 20 more.
    await lockRound(t.db, gameId, round2.id);
    expect(await stateOf(round2.id)).toMatchObject({
      baseVersionId: first.versionId,
      lockedVersionId: first.versionId,
      purchasingPower: 1020,
      spent: 970,
      bank: 50,
      transfersMade: 0,
      freeTransfers: 2,
      carryOverOut: 1,
      transferPenalty: 0,
    });
  });

  it("an unchanged lineup stays affordable after every owned price falls", async () => {
    await saveFor(round1, await picksOf(DRIVERS, EXACT));
    const at = await lockRound(t.db, gameId, round1.id);
    expect((await stateOf(round1.id))!.bank).toBe(0);
    // Every owned asset 1.0 cheaper: 7 x 10 off the 1000.
    await adminPrices(round2.id, at, {
      norris: 270,
      piastri: 240,
      hulkenberg: 85,
      hadjar: 75,
      bearman: 70,
      williams: 160,
      cadillac: 30,
    });
    await openRound(t.db, at, gameId, round2.id);
    expect(await purchasingPower(round2.id)).toBe(930);

    const same = await saveFor(round2, await picksOf(DRIVERS, EXACT));
    await lockRound(t.db, gameId, round2.id);
    expect(await stateOf(round2.id)).toMatchObject({
      lockedVersionId: same.versionId,
      purchasingPower: 930,
      spent: 930,
      bank: 0,
      transfersMade: 0,
    });
  });

  it("a withdrawn driver kept for three events counts at his carried price, and selling him returns it", async () => {
    const first = await saveFor(round1, await picksOf());
    const bearman = await game.assetId("bearman");
    const at = await lockRound(t.db, gameId, round1.id);
    await withdrawPoolAsset(t.db, at, {
      assetId: bearman,
      fromEventId: round2.id,
      reason: "Leaves the grid",
      actor: ACTOR,
    });

    // Rounds 2, 3 and 4: he is kept, at his carried 8.0.
    const rounds = [round2, await round(3), await round(4), await round(5)];
    await openRound(t.db, at, gameId, round2.id);
    for (let i = 0; i < 3; i++) {
      const event = rounds[i]!;
      const [price] = await t.db
        .select()
        .from(assetPrices)
        .where(eq(assetPrices.eventId, event.id))
        .then((rows) => rows.filter((r) => r.assetId === bearman));
      expect(price).toMatchObject({ price: 80, source: "carried" });
      expect(await purchasingPower(event.id)).toBe(1000);
      await advance(event, rounds[i + 1]!);
      expect(await stateOf(event.id)).toMatchObject({
        baseVersionId: first.versionId,
        lockedVersionId: first.versionId,
        purchasingPower: 1000,
        spent: COST,
        bank: 50,
      });
    }

    // Round 5: sold for Stroll (6.0), so his 8.0 goes back to the bank.
    const round5 = rounds[3]!;
    const sold = await saveFor(
      round5,
      await picksOf(["norris", "piastri", "hulkenberg", "hadjar", "stroll"]),
    );
    await lockRound(t.db, gameId, round5.id);
    expect(await stateOf(round5.id)).toMatchObject({
      baseVersionId: first.versionId,
      lockedVersionId: sold.versionId,
      purchasingPower: 1000,
      spent: 930,
      bank: 70,
      transfersMade: 1,
    });
  });

  it("a team created after round 1's lock gets no row there and starts at round 2", async () => {
    await saveFor(round1, await picksOf());
    const after = new Date(round1.lockAt.getTime() + HOUR_MS);
    await setSimulatedClock(t.db, after);
    const late = await createTeam(t.db, after, {
      gameId,
      userId: newId(),
      name: "Late",
    });
    // The lock job runs after the team was created.
    await lockEvent(t.db, after, { gameId, eventId: round1.id });
    expect((await states(round1.id)).map((s) => s.teamId)).toEqual([teamId]);
    expect(await firstEventOf(late)).toBeNull();

    await openRound(t.db, after, gameId, round2.id);
    const { versionId } = await saveFor(round2, await picksOf(), late);
    await lockRound(t.db, gameId, round2.id);
    expect(await stateOf(round2.id, late)).toMatchObject({
      baseVersionId: null,
      lockedVersionId: versionId,
      isFirstEvent: true,
      purchasingPower: 1000,
      freeTransfers: null,
      transferPenalty: 0,
    });
    expect(await firstEventOf(late)).toBe(round2.id);
  });

  it("a team that never saved gets no row", async () => {
    const idle = await team("Idle");
    await saveFor(round1, await picksOf());
    await setSimulatedClock(t.db, round1.lockAt);
    const { written } = await lockEvent(t.db, round1.lockAt, {
      gameId,
      eventId: round1.id,
    });
    expect(written).toBe(1);
    expect((await states()).map((s) => s.teamId)).toEqual([teamId]);
    expect(await firstEventOf(idle)).toBeNull();
  });

  it("a retired team gets no row", async () => {
    const other = await team("Other");
    await saveFor(round1, await picksOf());
    await saveFor(round1, await picksOf(), other);
    const at = await advance(round1, round2);
    expect(await removeTeam(t.db, at, other)).toBe("retired");
    await lockRound(t.db, gameId, round2.id);
    expect((await states(round2.id)).map((s) => s.teamId)).toEqual([teamId]);
    expect(await stateOf(round1.id, other)).toBeDefined();
  });

  it("locking twice writes the same rows", async () => {
    await saveFor(round1, await picksOf());
    await lockRound(t.db, gameId, round1.id);
    const once = await states();
    const again = await lockEvent(t.db, round1.lockAt, {
      gameId,
      eventId: round1.id,
    });
    expect(again).toEqual({ written: 0, lastTeamId: teamId, done: true });
    expect(await states()).toEqual(once);
  });

  it("locking before lock_at is refused", async () => {
    await saveFor(round1, await picksOf());
    const early = new Date(round1.lockAt.getTime() - 1000);
    await setSimulatedClock(t.db, early);
    await expect(
      lockEvent(t.db, early, { gameId, eventId: round1.id }),
    ).rejects.toThrow(/lock_at/);
    expect(await states()).toHaveLength(0);
    const [ge] = await t.db
      .select()
      .from(gameEvents)
      .where(eq(gameEvents.eventId, round1.id));
    expect(ge!.status).toBe("open");
  });

  it("a late lock of round 1, after round 2 opened and teams saved for it, writes what an on-time lock writes", async () => {
    const other = await team("Other");
    await saveFor(round1, await picksOf());
    await saveFor(round1, await picksOf(DRIVERS, EXACT), other);

    // What an on-time run writes, captured and then rolled back.
    await setSimulatedClock(t.db, round1.lockAt);
    const captured: {
      rows: (typeof teamEventStates.$inferSelect)[];
      firsts: { id: string; firstEventId: string | null }[];
    } = { rows: [], firsts: [] };
    await t.db
      .transaction(async (tx) => {
        await lockEvent(tx, round1.lockAt, { gameId, eventId: round1.id });
        captured.rows = await tx
          .select()
          .from(teamEventStates)
          .orderBy(asc(teamEventStates.teamId));
        captured.firsts = await tx
          .select({ id: teams.id, firstEventId: teams.firstEventId })
          .from(teams)
          .orderBy(asc(teams.id));
        tx.rollback();
      })
      .catch((e: unknown) => {
        if (!(e instanceof TransactionRollbackError)) throw e;
      });
    expect(captured.rows).toHaveLength(2);
    expect(await states()).toHaveLength(0);

    // The job didn't run. Round 1 is shut and round 2 opens; teams save for it,
    // and a new team joins.
    const opened = new Date(round1.lockAt.getTime() + 2 * HOUR_MS);
    await setSimulatedClock(t.db, opened);
    await t.db
      .update(gameEvents)
      .set({ status: "locked" })
      .where(eq(gameEvents.eventId, round1.id));
    await openRound(t.db, opened, gameId, round2.id);
    await saveFor(
      round2,
      await picksOf(["norris", "piastri", "lawson", "ocon", "stroll"]),
      teamId,
      30,
    );
    const late = await createTeam(t.db, opened, {
      gameId,
      userId: newId(),
      name: "Late",
    });
    await saveFor(round2, await picksOf(), late, 30);

    // Now the lock job for round 1 runs, a day late.
    const lateNow = new Date(round1.lockAt.getTime() + 24 * HOUR_MS);
    await setSimulatedClock(t.db, lateNow);
    const result = await lockEvent(t.db, lateNow, {
      gameId,
      eventId: round1.id,
    });
    expect(result.written).toBe(2);
    expect(result.done).toBe(true);

    const strip = (rows: (typeof teamEventStates.$inferSelect)[]) =>
      rows.map((row) => ({ ...row, createdAt: null, updatedAt: null }));
    expect(strip(await states(round1.id))).toEqual(strip(captured.rows));
    expect(
      await t.db
        .select({ id: teams.id, firstEventId: teams.firstEventId })
        .from(teams)
        .where(sql`${teams.id} <> ${late}`)
        .orderBy(asc(teams.id)),
    ).toEqual(captured.firsts);
    expect(await firstEventOf(late)).toBeNull();
  });

  it("batches of 2 over 5 teams write all 5 and set locked once", async () => {
    const ids = [teamId];
    for (const name of ["Two", "Three", "Four", "Five"]) {
      ids.push(await team(name));
    }
    ids.sort();
    for (const id of ids) await saveFor(round1, await picksOf(), id);
    await setSimulatedClock(t.db, round1.lockAt);
    const status = async () =>
      (
        await t.db
          .select()
          .from(gameEvents)
          .where(eq(gameEvents.eventId, round1.id))
      )[0]!.status;

    const batch = (afterTeamId?: string) =>
      lockEvent(t.db, round1.lockAt, {
        gameId,
        eventId: round1.id,
        afterTeamId,
        limit: 2,
      });
    expect(await batch()).toEqual({
      written: 2,
      lastTeamId: ids[1],
      done: false,
    });
    expect(await status()).toBe("open");
    expect(await batch(ids[1])).toEqual({
      written: 2,
      lastTeamId: ids[3],
      done: false,
    });
    expect(await status()).toBe("open");
    expect(await batch(ids[3])).toEqual({
      written: 1,
      lastTeamId: ids[4],
      done: true,
    });
    expect(await status()).toBe("locked");
    expect((await states(round1.id)).map((s) => s.teamId)).toEqual(ids);
  });

  it("a Limitless week reverts the next base to the lineup and bank before it", async () => {
    // Chips are Task 7; a limitless version is written directly here.
    const first = await saveFor(round1, await picksOf());
    await advance(round1, round2);
    const now = new Date(round2.lockAt.getTime() - HOUR_MS);
    await setSimulatedClock(t.db, now);
    const limitless = newId();
    // Far over the budget: 280 + 270 + 250 + 220 + 200 + 300 + 270.
    const big = await picksOf(
      ["norris", "max_verstappen", "piastri", "russell", "leclerc"],
      ["mclaren", "mercedes"],
    );
    await t.db.transaction(async (tx) => {
      await tx.insert(lineupVersions).values({
        id: limitless,
        teamId,
        forEventId: round2.id,
        kind: "limitless",
      });
      await tx
        .insert(lineupPicks)
        .values(big.map((p) => ({ lineupVersionId: limitless, ...p })));
    });
    const round3 = await round(3);
    await advance(round2, round3);
    expect(await stateOf(round2.id)).toMatchObject({
      baseVersionId: first.versionId,
      lockedVersionId: limitless,
      purchasingPower: 1000,
      spent: 1790,
      bank: -790,
      freeTransfers: null,
      transferPenalty: 0,
    });

    const { rows } = await t.db.execute(
      sql`select * from team_base_state(${teamId}::uuid, ${round3.id}::uuid)`,
    );
    expect(rows[0]).toEqual({
      base_version_id: first.versionId,
      bank: 50,
      carry_in: 0,
      is_first: false,
    });
    await lockRound(t.db, gameId, round3.id);
    expect(await stateOf(round3.id)).toMatchObject({
      baseVersionId: first.versionId,
      lockedVersionId: first.versionId,
      purchasingPower: 1000,
      spent: COST,
      bank: 50,
      transfersMade: 0,
      freeTransfers: 2,
    });
  });
});
