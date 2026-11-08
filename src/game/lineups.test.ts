import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import {
  lockRound,
  openRound,
  round2026,
  seedGame2026,
} from "../../tests/helpers/game-2026";
import {
  assetPrices,
  events,
  gameEvents,
  games,
  lineupPicks,
  lineupVersions,
  poolAssets,
  seasons,
  teams,
} from "@/db/schema";
import { seedUser } from "../../tests/helpers/users";
import { newId } from "@/lib/ids";
import { setSimulatedClock } from "@/replay/clock-loop";
import type { StaffActor } from "@/staff/roster";
import { GameError } from "./errors";
import { planGameEvents } from "./games";
import { lockedLineup, openGame, saveLineup, type LineupPick } from "./lineups";
import { addPoolAsset, withdrawPoolAsset } from "./pool";
import { createTeam, removeTeam } from "./teams";

// Lineups over the recorded 2026 game: saving is a new version each time, and
// the lock is the database's (app_now()), not the app's.

const NOW = new Date("2026-02-01T09:00:00.000Z");
const ACTOR: StaffActor = { kind: "admin", label: "staff" };
const SECOND_MS = 1000;
// 280 + 250 + 95 + 85 + 80 + 90 + 70 = 950, within the $100M budget.
const DRIVERS = ["norris", "piastri", "hulkenberg", "hadjar", "bearman"];
const CONSTRUCTORS = ["haas", "audi"];

describe("lineups (DM 3.7)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let game: Awaited<ReturnType<typeof seedGame2026>>;
  let gameId: string;
  let round1: { id: string; lockAt: Date };
  let teamId: string;
  let USER: string;

  beforeEach(async () => {
    t = await createTestDb();
    game = await seedGame2026(t.db, NOW);
    gameId = game.gameId;
    await setSimulatedClock(t.db, NOW);
    const [first] = await t.db
      .select({ id: events.id, lockAt: events.lockAt })
      .from(events)
      .where(eq(events.round, 1));
    round1 = first!;
    await openGame(t.db, NOW, gameId);
    USER = await seedUser(t.db);
    teamId = await createTeam(t.db, NOW, { gameId, userId: USER, name: "One" });
  });
  afterEach(async () => {
    await t.close();
  });

  /** Moves both clocks, the app's and the database's, to the same instant. */
  const at = async (time: Date) => {
    await setSimulatedClock(t.db, time);
    return time;
  };
  const beforeLock = (seconds: number) =>
    new Date(round1.lockAt.getTime() - seconds * SECOND_MS);

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
  const save = async (
    now: Date,
    picks: LineupPick[],
    basedOnVersionId: string | null = null,
    id = teamId,
  ) => saveLineup(t.db, now, { teamId: id, picks, basedOnVersionId });
  const versions = () => t.db.select().from(lineupVersions);

  async function expectGameError(promise: Promise<unknown>, code: string) {
    const error = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error, "expected a GameError").toBeInstanceOf(GameError);
    expect((error as GameError).code).toBe(code);
  }

  describe("openGame", () => {
    it("opens the game and its first event", async () => {
      const [g] = await t.db.select().from(games).where(eq(games.id, gameId));
      expect(g!.status).toBe("open");
      const open = await t.db
        .select()
        .from(gameEvents)
        .where(eq(gameEvents.status, "open"));
      expect(open.map((e) => [e.sequence, e.eventId])).toEqual([
        [1, round1.id],
      ]);
    });

    it("is refused for a game that isn't in setup", async () => {
      await expect(openGame(t.db, NOW, gameId)).rejects.toThrow(/setup/);
    });

    it("is refused while an active asset in the pool has no price", async () => {
      await t.db.update(games).set({ status: "setup" });
      await t.db.update(gameEvents).set({ status: "upcoming" });
      await t.db
        .delete(assetPrices)
        .where(eq(assetPrices.assetId, await game.assetId("norris")));
      await expect(openGame(t.db, NOW, gameId)).rejects.toThrow(/price/);
      const [g] = await t.db.select().from(games).where(eq(games.id, gameId));
      expect(g!.status).toBe("setup");
    });

    it("is refused while an asset withdrawn from a later event has no price", async () => {
      await t.db.update(games).set({ status: "setup" });
      await t.db.update(gameEvents).set({ status: "upcoming" });
      const round2 = await round2026(t.db, 2);
      const bottas = await game.assetId("bottas");
      // Withdrawn in the pool at once, but pickable at round 1.
      await withdrawPoolAsset(t.db, NOW, {
        assetId: bottas,
        fromEventId: round2.id,
        reason: "Leaves after Australia",
        actor: ACTOR,
      });
      await t.db.delete(assetPrices).where(eq(assetPrices.assetId, bottas));
      await expect(openGame(t.db, NOW, gameId)).rejects.toThrow(/price/);
      const [g] = await t.db.select().from(games).where(eq(games.id, gameId));
      expect(g!.status).toBe("setup");
    });
  });

  it("a save one second before lock counts", async () => {
    const now = await at(beforeLock(1));
    const picks = await picksOf();
    const { versionId, staleBase } = await save(now, picks);
    expect(staleBase).toBe(false);

    const [row] = await versions();
    expect(row!.id).toBe(versionId);
    expect(row!.forEventId).toBe(round1.id);
    expect(row!.kind).toBe("regular");
    expect(row!.savedAt).toEqual(now);

    const locked = await lockedLineup(t.db, {
      teamId,
      eventId: round1.id,
    });
    expect(locked!.versionId).toBe(versionId);
    expect(locked!.picks).toHaveLength(7);
    expect(locked!.picks.filter((p) => p.isBoost)).toEqual([
      { assetId: await game.assetId("norris"), isBoost: true },
    ]);
  });

  it("a save at lock_at is refused with window_closed", async () => {
    const now = await at(round1.lockAt);
    await expectGameError(save(now, await picksOf()), "window_closed");
    expect(await versions()).toHaveLength(0);
    expect(await t.db.select().from(lineupPicks)).toHaveLength(0);
  });

  it("a save before the game opens is refused with window_closed", async () => {
    await t.db.update(gameEvents).set({ status: "upcoming" });
    await expectGameError(save(NOW, await picksOf()), "window_closed");
    expect(await versions()).toHaveLength(0);
  });

  it("the app clock says open but app_now() says locked", async () => {
    // The app thinks it is one second before lock; the database says lock.
    const appNow = beforeLock(1);
    await at(round1.lockAt);
    await expectGameError(save(appNow, await picksOf()), "window_closed");
    expect(await versions()).toHaveLength(0);
    expect(await t.db.select().from(lineupPicks)).toHaveLength(0);
    expect(await lockedLineup(t.db, { teamId, eventId: round1.id })).toBeNull();
  });

  it("a save nested in a caller's transaction is refused with window_closed at the lock", async () => {
    const appNow = beforeLock(1);
    await at(round1.lockAt);
    const picks = await picksOf();
    // The refusal comes from saveLineup itself, not from the caller's commit.
    const refused = await t.db.transaction(async (outer) => {
      const error = await saveLineup(outer, appNow, {
        teamId,
        picks,
        basedOnVersionId: null,
      }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(await outer.select().from(lineupVersions)).toHaveLength(0);
      return error;
    });
    expect(refused).toBeInstanceOf(GameError);
    expect((refused as GameError).code).toBe("window_closed");
    expect(await versions()).toHaveLength(0);

    // A nested save that is accepted counts, and the caller's own writes after
    // it are unaffected.
    await at(beforeLock(5));
    const { versionId } = await t.db.transaction((outer) =>
      saveLineup(outer, beforeLock(5), {
        teamId,
        picks,
        basedOnVersionId: null,
      }),
    );
    expect(
      (await lockedLineup(t.db, { teamId, eventId: round1.id }))!.versionId,
    ).toBe(versionId);
  });

  it("six drivers, one constructor, two Boosts, or a Boost on a constructor are refused with composition", async () => {
    const six = await picksOf([...DRIVERS, "hamilton"], CONSTRUCTORS);
    const oneConstructor = await picksOf(DRIVERS, ["mclaren"]);
    const base = await picksOf();
    const twoBoosts = base.map((p, i) => ({ ...p, isBoost: i < 2 }));
    const noBoost = base.map((p) => ({ ...p, isBoost: false }));
    const constructorBoost = base.map((p, i) => ({ ...p, isBoost: i === 5 }));
    const swapped = [
      ...(await picksOf(DRIVERS.slice(0, 4), ["mclaren", "mercedes"])),
      { assetId: await game.assetId("williams"), isBoost: false },
    ];
    for (const picks of [
      six,
      oneConstructor,
      twoBoosts,
      noBoost,
      constructorBoost,
      swapped,
    ]) {
      await expectGameError(save(NOW, picks), "composition");
    }
    expect(await versions()).toHaveLength(0);
    expect(await t.db.select().from(lineupPicks)).toHaveLength(0);
  });

  it("a partial lineup can't be saved", async () => {
    const full = await picksOf();
    await expectGameError(save(NOW, full.slice(0, 4)), "composition");
    await expectGameError(save(NOW, []), "composition");
    // The same asset twice is not a full lineup either.
    await expectGameError(
      save(NOW, [...full.slice(0, 6), full[0]!]),
      "composition",
    );
    expect(await versions()).toHaveLength(0);
  });

  describe("asset availability", () => {
    /** Swaps the last driver for another asset. */
    const withLastDriverAs = async (assetId: string) => {
      const picks = await picksOf();
      picks[4] = { assetId, isBoost: false };
      return picks;
    };

    it("an asset added from a later event is refused with asset_unavailable", async () => {
      const [round2] = await t.db
        .select({ id: events.id })
        .from(events)
        .where(eq(events.round, 2));
      const tsunoda = await t.db.query.providerIds.findFirst({
        where: (p, { and, eq }) =>
          and(eq(p.providerKey, "tsunoda"), eq(p.entityType, "driver")),
      });
      const assetId = await addPoolAsset(t.db, NOW, {
        gameId,
        driverId: tsunoda!.entityId,
        fromEventId: round2!.id,
        price: 56,
        reason: "Replaces an injured driver",
        actor: ACTOR,
      });
      await expectGameError(
        save(NOW, await withLastDriverAs(assetId)),
        "asset_unavailable",
      );
      expect(await versions()).toHaveLength(0);
    });

    it("a withdrawn asset is refused with asset_unavailable", async () => {
      const bearman = await game.assetId("bearman");
      await withdrawPoolAsset(t.db, NOW, {
        assetId: bearman,
        fromEventId: round1.id,
        reason: "Leaves the grid",
        actor: ACTOR,
      });
      await expectGameError(save(NOW, await picksOf()), "asset_unavailable");
      expect(await versions()).toHaveLength(0);
    });

    it("an asset withdrawn from a later event can still be picked", async () => {
      const [round2] = await t.db
        .select({ id: events.id })
        .from(events)
        .where(eq(events.round, 2));
      await withdrawPoolAsset(t.db, NOW, {
        assetId: await game.assetId("bearman"),
        fromEventId: round2!.id,
        reason: "Leaves after round 1",
        actor: ACTOR,
      });
      await save(NOW, await picksOf());
      expect(await versions()).toHaveLength(1);
    });

    it("a withdrawn asset already owned can be kept, but not bought back after it's sold", async () => {
      await save(await at(beforeLock(60)), await picksOf());
      const locked = await lockRound(t.db, gameId, round1.id);
      const round2 = await round2026(t.db, 2);
      await withdrawPoolAsset(t.db, locked, {
        assetId: await game.assetId("bearman"),
        fromEventId: round2.id,
        reason: "Leaves the grid",
        actor: ACTOR,
      });
      await openRound(t.db, locked, gameId, round2.id);
      const inRound2 = await at(new Date(round2.lockAt.getTime() - 3_600_000));

      // Owned in the base: kept through another change.
      const kept = await picksOf([
        "norris",
        "piastri",
        "hulkenberg",
        "lawson",
        "bearman",
      ]);
      await save(inRound2, kept);
      // Sold, and that sale locks.
      const sold = await picksOf([
        "norris",
        "piastri",
        "hulkenberg",
        "hadjar",
        "stroll",
      ]);
      await save(inRound2, sold);
      const locked2 = await lockRound(t.db, gameId, round2.id);
      const round3 = await round2026(t.db, 3);
      await openRound(t.db, locked2, gameId, round3.id);

      const before = (await versions()).length;
      await expectGameError(
        save(await at(new Date(round3.lockAt.getTime() - 3_600_000)), kept),
        "asset_unavailable",
      );
      expect(await versions()).toHaveLength(before);
    });

    it("another game's asset is refused with asset_unavailable", async () => {
      const [season2025] = await t.db
        .insert(seasons)
        .values({ id: newId(), year: 2025, status: "completed" })
        .returning({ id: seasons.id });
      const otherGameId = newId();
      await t.db.insert(games).values({
        id: otherGameId,
        seasonId: season2025!.id,
        gameType: "season_fantasy",
        slug: "2025-fantasy",
        name: "2025 Fantasy",
        status: "setup",
      });
      const [norris] = await t.db
        .select()
        .from(poolAssets)
        .where(eq(poolAssets.id, await game.assetId("norris")));
      const foreign = newId();
      await t.db.insert(poolAssets).values({
        id: foreign,
        gameId: otherGameId,
        assetType: "driver",
        driverId: norris!.driverId,
        status: "active",
        addedFromEventId: round1.id,
      });
      await expectGameError(
        save(NOW, await withLastDriverAs(foreign)),
        "asset_unavailable",
      );
      expect(await versions()).toHaveLength(0);
    });
  });

  describe("the budget (DM 3.8)", () => {
    it("an over-budget save is refused with over_budget", async () => {
      // 790 for the drivers, 300 + 70 for McLaren and Audi: 1160.
      await expectGameError(
        save(NOW, await picksOf(DRIVERS, ["mclaren", "audi"])),
        "over_budget",
      );
      expect(await versions()).toHaveLength(0);
      expect(await t.db.select().from(lineupPicks)).toHaveLength(0);
    });

    it("a save that spends exactly the purchasing power is accepted", async () => {
      // 790 + 170 + 40: exactly the 1000 of a first event.
      const { versionId } = await save(
        NOW,
        await picksOf(DRIVERS, ["williams", "cadillac"]),
      );
      expect((await versions()).map((v) => v.id)).toEqual([versionId]);
      // Alpine instead of Cadillac is 20 over.
      await expectGameError(
        save(NOW, await picksOf(DRIVERS, ["williams", "alpine"])),
        "over_budget",
      );
    });
  });

  it("two devices: the later save counts, and the earlier one's next save reports staleBase", async () => {
    const picks = await picksOf();
    const a1 = await save(await at(beforeLock(600)), picks);
    expect(a1.staleBase).toBe(false);

    // Device B was open on a1 and saves a change.
    const swapped = await picksOf(
      ["norris", "piastri", "hulkenberg", "hadjar", "lawson"],
      CONSTRUCTORS,
    );
    const b = await save(await at(beforeLock(300)), swapped, a1.versionId);
    expect(b.staleBase).toBe(false);
    expect(
      (await lockedLineup(t.db, { teamId, eventId: round1.id }))!.versionId,
    ).toBe(b.versionId);

    // Device A still shows a1: its next save is stale, but it is saved and,
    // being the latest, it counts.
    const a2 = await save(await at(beforeLock(60)), picks, a1.versionId);
    expect(a2.staleBase).toBe(true);
    expect(
      (await lockedLineup(t.db, { teamId, eventId: round1.id }))!.versionId,
    ).toBe(a2.versionId);
    expect(await versions()).toHaveLength(3);

    // A save built on nothing, when the team already has versions, is stale.
    const blank = await save(await at(beforeLock(30)), picks, null);
    expect(blank.staleBase).toBe(true);
  });

  it("two saves with the same saved_at: the later id counts", async () => {
    const now = await at(beforeLock(10));
    const picks = await picksOf();
    const first = await save(now, picks);
    const second = await save(now, picks, first.versionId);
    const [a, b] = await versions().then((rows) =>
      rows.sort((x, y) => (x.id < y.id ? -1 : 1)),
    );
    expect(a!.savedAt).toEqual(b!.savedAt);
    expect(second.versionId > first.versionId).toBe(true);
    expect(
      (await lockedLineup(t.db, { teamId, eventId: round1.id }))!.versionId,
    ).toBe(second.versionId);

    // The id decides, not the order of the inserts: write the higher id first.
    const other = await createTeam(t.db, NOW, {
      gameId,
      userId: USER,
      name: "Two",
    });
    const low = newId();
    const high = newId();
    expect(high > low).toBe(true);
    for (const id of [high, low]) {
      await t.db.transaction(async (tx) => {
        await tx.insert(lineupVersions).values({
          id,
          teamId: other,
          forEventId: round1.id,
          kind: "regular",
        });
        await tx
          .insert(lineupPicks)
          .values(picks.map((p) => ({ lineupVersionId: id, ...p })));
      });
    }
    expect(
      (await lockedLineup(t.db, { teamId: other, eventId: round1.id }))!
        .versionId,
    ).toBe(high);
  });

  it("swapping only the Boost is a new version with the same assets", async () => {
    const first = await save(await at(beforeLock(120)), await picksOf());
    const moved = await save(
      await at(beforeLock(60)),
      await picksOf(DRIVERS, CONSTRUCTORS, "piastri"),
      first.versionId,
    );
    expect(moved.versionId).not.toBe(first.versionId);
    expect(moved.staleBase).toBe(false);

    const assetsOf = async (versionId: string) =>
      (
        await t.db
          .select()
          .from(lineupPicks)
          .where(eq(lineupPicks.lineupVersionId, versionId))
          .orderBy(asc(lineupPicks.assetId))
      ).map((p) => p.assetId);
    expect(await assetsOf(moved.versionId)).toEqual(
      await assetsOf(first.versionId),
    );
    const locked = await lockedLineup(t.db, { teamId, eventId: round1.id });
    expect(locked!.versionId).toBe(moved.versionId);
    expect(locked!.picks.filter((p) => p.isBoost)).toEqual([
      { assetId: await game.assetId("piastri"), isBoost: true },
    ]);
    const [stored] = await t.db
      .select()
      .from(lineupVersions)
      .where(eq(lineupVersions.id, moved.versionId));
    expect(stored!.basedOnVersionId).toBe(first.versionId);
  });

  it("a team with no saved lineup has none locked", async () => {
    expect(await lockedLineup(t.db, { teamId, eventId: round1.id })).toBeNull();
  });

  it("a lineup saved for a cancelled event counts until the team's next lock, and not after", async () => {
    const round2 = await round2026(t.db, 2);
    const round3 = await round2026(t.db, 3);
    const round4 = await round2026(t.db, 4);
    const hourBefore = (event: { lockAt: Date }) =>
      at(new Date(event.lockAt.getTime() - 3600 * SECOND_MS));
    const first = await save(await at(beforeLock(3600)), await picksOf());
    const locked1 = await lockRound(t.db, gameId, round1.id);
    await openRound(t.db, locked1, gameId, round2.id);
    const cancelled = await save(
      await hourBefore(round2),
      await picksOf(DRIVERS, CONSTRUCTORS, "piastri"),
    );
    // Round 2 is cancelled while it's open, and round 3 opens at once.
    const now = await at(new Date(round2.lockAt.getTime() - 1800 * SECOND_MS));
    await t.db
      .update(events)
      .set({ status: "cancelled" })
      .where(eq(events.id, round2.id));
    await planGameEvents(t.db, now, gameId);
    expect(
      (await lockedLineup(t.db, { teamId, eventId: round3.id }))?.versionId,
    ).toBe(cancelled.versionId);

    const third = await save(
      await hourBefore(round3),
      await picksOf(DRIVERS, CONSTRUCTORS, "hadjar"),
    );
    expect(
      (await lockedLineup(t.db, { teamId, eventId: round3.id }))?.versionId,
    ).toBe(third.versionId);
    const locked3 = await lockRound(t.db, gameId, round3.id);
    await openRound(t.db, locked3, gameId, round4.id);
    // Round 3's lock is the base now: the cancelled event's save no longer
    // counts, nor does round 1's.
    expect(
      (await lockedLineup(t.db, { teamId, eventId: round4.id }))?.versionId,
    ).toBe(third.versionId);
    expect(first.versionId).not.toBe(third.versionId);
  });

  it("a team that saved but never locked can still be deleted", async () => {
    await save(await at(beforeLock(60)), await picksOf());
    expect(await removeTeam(t.db, NOW, teamId)).toBe("deleted");
    expect(
      await t.db.select().from(teams).where(eq(teams.id, teamId)),
    ).toHaveLength(0);
    expect(await versions()).toHaveLength(0);
    expect(await t.db.select().from(lineupPicks)).toHaveLength(0);
  });

  it("each save is its own version and an earlier one is never changed", async () => {
    const first = await save(await at(beforeLock(120)), await picksOf());
    await save(
      await at(beforeLock(60)),
      await picksOf(DRIVERS, CONSTRUCTORS, "piastri"),
      first.versionId,
    );
    const rows = await t.db
      .select()
      .from(lineupPicks)
      .where(
        and(
          eq(lineupPicks.lineupVersionId, first.versionId),
          eq(lineupPicks.isBoost, true),
        ),
      );
    expect(rows.map((r) => r.assetId)).toEqual([await game.assetId("norris")]);
  });
});
