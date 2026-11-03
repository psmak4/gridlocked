import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import { seedGame2026 } from "../../tests/helpers/game-2026";
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
import { newId } from "@/lib/ids";
import { setSimulatedClock } from "@/replay/clock-loop";
import type { StaffActor } from "@/staff/roster";
import { GameError } from "./errors";
import { lockedLineup, openGame, saveLineup, type LineupPick } from "./lineups";
import { addPoolAsset, withdrawPoolAsset } from "./pool";
import { createTeam, removeTeam } from "./teams";

// Lineups over the recorded 2026 game: saving is a new version each time, and
// the lock is the database's (app_now()), not the app's.

const NOW = new Date("2026-02-01T09:00:00.000Z");
const USER = newId();
const ACTOR: StaffActor = { kind: "admin", label: "staff" };
const SECOND_MS = 1000;
const DRIVERS = ["norris", "max_verstappen", "piastri", "russell", "leclerc"];
const CONSTRUCTORS = ["mclaren", "mercedes"];

describe("lineups (DM 3.7)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let game: Awaited<ReturnType<typeof seedGame2026>>;
  let gameId: string;
  let round1: { id: string; lockAt: Date };
  let teamId: string;

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
      const leclerc = await game.assetId("leclerc");
      await withdrawPoolAsset(t.db, NOW, {
        assetId: leclerc,
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
        assetId: await game.assetId("leclerc"),
        fromEventId: round2!.id,
        reason: "Leaves after round 1",
        actor: ACTOR,
      });
      await save(NOW, await picksOf());
      expect(await versions()).toHaveLength(1);
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

  it("two devices: the later save counts, and the earlier one's next save reports staleBase", async () => {
    const picks = await picksOf();
    const a1 = await save(await at(beforeLock(600)), picks);
    expect(a1.staleBase).toBe(false);

    // Device B was open on a1 and saves a change.
    const swapped = await picksOf(
      ["norris", "max_verstappen", "piastri", "russell", "hamilton"],
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
