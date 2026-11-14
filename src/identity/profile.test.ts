import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../../tests/helpers/test-db";
import { seedLeagueGames } from "../../tests/helpers/leagues-game";
import { seedUser } from "../../tests/helpers/users";
import {
  games,
  leagueMemberships,
  leagues,
  poolAssets,
  profiles,
} from "@/db/schema";
import { newId } from "@/lib/ids";
import { createTeam } from "@/game/teams";
import { favoriteIsStale, updateProfile } from "./profile";

// The real league sync, unless a test sets `syncFails` to make it throw.
const sync = vi.hoisted(() => ({ fails: false }));
vi.mock("@/leagues/leagues", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/leagues/leagues")>();
  return {
    ...real,
    syncAutoLeagues: async (
      ...args: Parameters<typeof real.syncAutoLeagues>
    ) => {
      if (sync.fails) throw new Error("sync failed");
      return real.syncAutoLeagues(...args);
    },
  };
});

const NOW = new Date("2026-02-01T09:00:00.000Z");
const LATER = new Date("2026-02-01T10:00:00.000Z");

describe("the profile (DM 6.2, 6.11)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let seeded: Awaited<ReturnType<typeof seedLeagueGames>>;
  let userId: string;
  let teamId: string;

  beforeEach(async () => {
    t = await createTestDb();
    seeded = await seedLeagueGames(t.db, NOW);
    await t.db
      .update(games)
      .set({ status: "running" })
      .where(eq(games.id, seeded.gameId));
    // Only the first two constructors are in the game's pool.
    await t.db.insert(poolAssets).values(
      seeded.constructorIds.slice(0, 2).map((constructorId) => ({
        id: newId(),
        gameId: seeded.gameId,
        assetType: "constructor" as const,
        constructorId,
        status: "active" as const,
        addedFromEventId: seeded.eventIds[0]!,
        createdAt: NOW,
        updatedAt: NOW,
      })),
    );
    userId = await seedUser(t.db);
    teamId = await createTeam(t.db, NOW, {
      gameId: seeded.gameId,
      userId,
      name: "Team",
    });
  });
  afterEach(async () => {
    sync.fails = false;
    await t.close();
  });

  const profile = async () =>
    (await t.db.select().from(profiles).where(eq(profiles.userId, userId)))[0]!;
  const autoLeagues = async () =>
    (
      await t.db
        .select({
          kind: leagues.kind,
          constructorId: leagues.constructorId,
          countryCode: leagues.countryCode,
        })
        .from(leagueMemberships)
        .innerJoin(leagues, eq(leagues.id, leagueMemberships.leagueId))
        .where(
          and(
            eq(leagueMemberships.teamId, teamId),
            isNull(leagueMemberships.leftAt),
          ),
        )
    ).filter((l) => l.kind.startsWith("auto_"));
  const save = async (over: Partial<Parameters<typeof updateProfile>[2]>) =>
    updateProfile(t.db, LATER, {
      userId,
      expectedVersion: (await profile()).version,
      ...over,
    });

  it("changing favorite team moves auto leagues", async () => {
    const [ferrari, mclaren] = seeded.constructorIds;
    await save({ favoriteConstructorId: ferrari! });
    expect(await autoLeagues()).toMatchObject([
      { kind: "auto_constructor", constructorId: ferrari },
    ]);
    await save({ favoriteConstructorId: mclaren! });
    expect(await autoLeagues()).toMatchObject([
      { kind: "auto_constructor", constructorId: mclaren },
    ]);
    expect((await profile()).version).toBe(3);
  });

  it("a null favorite leaves them", async () => {
    await save({
      favoriteConstructorId: seeded.constructorIds[0]!,
      countryCode: "gb",
    });
    expect(await autoLeagues()).toHaveLength(2);
    await save({ favoriteConstructorId: null });
    expect(await autoLeagues()).toMatchObject([{ kind: "auto_country" }]);
    expect((await profile()).countryCode).toBe("GB");
  });

  it("a game that no longer has the favorite prompts again, and the flair stays", async () => {
    const inGame = seeded.constructorIds[0]!;
    const notInGame = seeded.constructorIds[2]!;
    await save({ favoriteConstructorId: inGame });
    expect(await favoriteIsStale(t.db, userId, seeded.gameId)).toBe(false);

    await save({ favoriteConstructorId: notInGame });
    expect(await favoriteIsStale(t.db, userId, seeded.gameId)).toBe(true);
    expect((await profile()).favoriteConstructorId).toBe(notInGame);
    // The game has no such constructor, so it has no league for it.
    expect(await autoLeagues()).toEqual([]);

    // No favorite, nothing to ask.
    await save({ favoriteConstructorId: null });
    expect(await favoriteIsStale(t.db, userId, seeded.gameId)).toBe(false);
  });

  it("two tabs saving a profile: the second gets a version conflict", async () => {
    const opened = (await profile()).version;
    await updateProfile(t.db, LATER, {
      userId,
      expectedVersion: opened,
      timezone: "Europe/London",
    });
    await expect(
      updateProfile(t.db, LATER, {
        userId,
        expectedVersion: opened,
        spoilerProtection: false,
      }),
    ).rejects.toMatchObject({ code: "version_conflict" });
    const saved = await profile();
    expect(saved).toMatchObject({
      timezone: "Europe/London",
      spoilerProtection: true,
      version: opened + 1,
    });
  });

  it.each([
    [{ countryCode: "X" }, "invalid_country"],
    [{ countryCode: "QQ" }, "invalid_country"],
    [{ countryCode: "ZZ" }, "invalid_country"],
    [{ countryCode: "GB1" }, "invalid_country"],
    [{ countryCode: "USA" }, "invalid_country"],
    [{ countryCode: "XYZ" }, "invalid_country"],
    // Named by CLDR, but not a country (Ruling 58): no "European Union fans".
    [{ countryCode: "EU" }, "invalid_country"],
    [{ countryCode: "UN" }, "invalid_country"],
    [{ countryCode: "XA" }, "invalid_country"],
    [{ countryCode: "xa" }, "invalid_country"],
    [{ timezone: "Mars/Base" }, "invalid_timezone"],
    [{ timezone: "" }, "invalid_timezone"],
  ])("a bad country or timezone is refused: %j", async (over, code) => {
    const before = await profile();
    await expect(save(over)).rejects.toMatchObject({ code });
    expect(await profile()).toEqual(before);
  });

  it("changing favorite team moves auto leagues in an open game", async () => {
    // A game is open, not running, until its first lock (M6 plan, finding 2).
    const otherTeam = await createTeam(t.db, NOW, {
      gameId: seeded.otherGameId,
      userId,
      name: "Other",
    });
    await save({ countryCode: "GB" });
    const rows = await t.db
      .select({ kind: leagues.kind, countryCode: leagues.countryCode })
      .from(leagueMemberships)
      .innerJoin(leagues, eq(leagues.id, leagueMemberships.leagueId))
      .where(
        and(
          eq(leagueMemberships.teamId, otherTeam),
          isNull(leagueMemberships.leftAt),
        ),
      );
    expect(rows).toEqual([{ kind: "auto_country", countryCode: "GB" }]);
  });

  it("a failing syncAutoLeagues rolls the profile change back", async () => {
    const before = await profile();
    sync.fails = true;
    await expect(
      save({ favoriteConstructorId: seeded.constructorIds[0]! }),
    ).rejects.toThrow("sync failed");
    expect(await profile()).toEqual(before);
    expect(await autoLeagues()).toEqual([]);
  });

  it("a completed game keeps its memberships", async () => {
    const otherTeam = await createTeam(t.db, NOW, {
      gameId: seeded.otherGameId,
      userId,
      name: "Other",
    });
    await t.db
      .update(games)
      .set({ status: "completed" })
      .where(eq(games.id, seeded.otherGameId));
    await save({
      favoriteConstructorId: seeded.constructorIds[0]!,
      countryCode: "GB",
    });
    const rows = await t.db
      .select()
      .from(leagueMemberships)
      .where(eq(leagueMemberships.teamId, otherTeam));
    expect(rows).toEqual([]);
    const kinds = await t.db
      .select({ kind: leagues.kind })
      .from(leagues)
      .where(eq(leagues.gameId, seeded.otherGameId));
    expect(kinds.filter((k) => k.kind.startsWith("auto_"))).toEqual([]);
  });

  it("a timezone-only change writes no membership", async () => {
    await save({
      favoriteConstructorId: seeded.constructorIds[0]!,
      countryCode: "GB",
    });
    const before = await t.db.select().from(leagueMemberships);
    await updateProfile(t.db, new Date("2026-03-01T00:00:00Z"), {
      userId,
      expectedVersion: (await profile()).version,
      timezone: "Europe/London",
    });
    expect(await t.db.select().from(leagueMemberships)).toEqual(before);
  });

  it("a good country and timezone are saved, the country upper-cased", async () => {
    await save({ countryCode: " nl ", timezone: "Europe/Amsterdam" });
    expect(await profile()).toMatchObject({
      countryCode: "NL",
      timezone: "Europe/Amsterdam",
    });
  });
});
