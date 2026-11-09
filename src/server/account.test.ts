import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../../tests/helpers/test-db";
import { seedLeagueGames } from "../../tests/helpers/leagues-game";
import { seedUser } from "../../tests/helpers/users";
import {
  constructorSeasons,
  constructors,
  drivers,
  legalAcceptances,
  profiles,
  seasons,
  seatAssignments,
  settings,
  users,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { newId } from "@/lib/ids";
import { RETIRED_REGION_CODES, normalizeCountryCode } from "@/identity/profile";
import type { Viewer } from "@/identity/viewer";
import {
  checkUsernameAction,
  countryChoices,
  emailBusyAction,
  favoriteChoices,
  finishSignUpAction,
  finishSignUpInput,
  onboardingState,
  usernameCheckKey,
  saveFavoritesAction,
  saveSpoilersAction,
} from "./account-actions";

const NOW = new Date("2026-02-01T09:00:00.000Z");

describe("account actions (M5 task 12)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: Db;
  let seeded: Awaited<ReturnType<typeof seedLeagueGames>>;

  beforeEach(async () => {
    t = await createTestDb();
    db = t.db as unknown as Db;
    seeded = await seedLeagueGames(db, NOW);
  });
  afterEach(async () => {
    await t.close();
  });

  /** A signed-in viewer for a user row, as `getViewer` would build one. */
  async function viewerOf(
    userId: string,
    over: Partial<Viewer> = {},
  ): Promise<Viewer> {
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    const [profile] = await db
      .select()
      .from(profiles)
      .where(eq(profiles.userId, userId));
    return {
      userId,
      role: user!.role,
      banned: false,
      username: user!.username,
      displayUsername: user!.displayUsername,
      emailVerified: user!.emailVerified,
      twoFactorEnabled: false,
      sessionId: newId(),
      impersonatedBy: null,
      staffVerifiedAt: null,
      profile: profile!,
      complete: true,
      ...over,
    };
  }

  /** A person who has signed in (say by magic link) and has not finished. */
  async function newcomer() {
    const userId = await seedUser(db);
    await db
      .update(users)
      .set({ username: null, displayUsername: null })
      .where(eq(users.id, userId));
    await db
      .update(profiles)
      .set({ ageConfirmedAt: null })
      .where(eq(profiles.userId, userId));
    return { userId, viewer: await viewerOf(userId, { complete: false }) };
  }

  describe("finishSignUp", () => {
    it("takes the username and the two boxes, and records them", async () => {
      const { userId, viewer } = await newcomer();
      const result = await finishSignUpAction(db, NOW, viewer, {
        username: "Late_Braker",
        ageConfirmed: true,
        accepted: true,
      });
      expect(result).toEqual({ ok: true });
      const [user] = await db.select().from(users).where(eq(users.id, userId));
      expect(user!.username).toBe("late_braker");
      expect(user!.displayUsername).toBe("Late_Braker");
      const [profile] = await db
        .select()
        .from(profiles)
        .where(eq(profiles.userId, userId));
      expect(profile!.ageConfirmedAt).not.toBeNull();
      const accepted = await db
        .select()
        .from(legalAcceptances)
        .where(eq(legalAcceptances.userId, userId));
      expect(accepted).toHaveLength(3);
    });

    it("says why a name is refused, and records nothing", async () => {
      for (const [name, error] of [
        ["admin", "reserved"],
        ["a!", "format"],
      ] as const) {
        const { userId, viewer } = await newcomer();
        expect(
          await finishSignUpAction(db, NOW, viewer, {
            username: name,
            ageConfirmed: true,
            accepted: true,
          }),
        ).toEqual({ ok: false, error });
        const [profile] = await db
          .select()
          .from(profiles)
          .where(eq(profiles.userId, userId));
        expect(profile!.ageConfirmedAt).toBeNull();
      }
    });

    it("says a name is taken", async () => {
      await seedUser(db, { username: "Taken_Name" });
      const { viewer } = await newcomer();
      expect(
        await finishSignUpAction(db, NOW, viewer, {
          username: "taken_name",
          ageConfirmed: true,
          accepted: true,
        }),
      ).toEqual({ ok: false, error: "taken" });
    });

    it("needs a username when the person has none", async () => {
      const { viewer } = await newcomer();
      expect(
        await finishSignUpAction(db, NOW, viewer, {
          ageConfirmed: true,
          accepted: true,
        }),
      ).toEqual({ ok: false, error: "username_required" });
    });

    it("refuses an impersonated session, and records nothing", async () => {
      const { userId, viewer } = await newcomer();
      await expect(
        finishSignUpAction(
          db,
          NOW,
          { ...viewer, impersonatedBy: newId() },
          { username: "not_theirs", ageConfirmed: true, accepted: true },
        ),
      ).rejects.toMatchObject({ code: "read_only" });
      const [user] = await db.select().from(users).where(eq(users.id, userId));
      expect(user!.username).toBeNull();
      const accepted = await db
        .select()
        .from(legalAcceptances)
        .where(eq(legalAcceptances.userId, userId));
      expect(accepted).toHaveLength(0);
    });

    it("needs someone signed in", async () => {
      await expect(
        finishSignUpAction(db, NOW, null, {
          username: "someone",
          ageConfirmed: true,
          accepted: true,
        }),
      ).rejects.toMatchObject({ code: "unauthenticated" });
    });

    it("refuses input where either box is not true", () => {
      const base = { username: "someone" };
      expect(
        finishSignUpInput.safeParse({
          ...base,
          ageConfirmed: false,
          accepted: true,
        }).success,
      ).toBe(false);
      expect(
        finishSignUpInput.safeParse({
          ...base,
          ageConfirmed: true,
          accepted: false,
        }).success,
      ).toBe(false);
      expect(finishSignUpInput.safeParse({ ...base }).success).toBe(false);
      expect(
        finishSignUpInput.safeParse({
          ...base,
          ageConfirmed: true,
          accepted: true,
        }).success,
      ).toBe(true);
    });
  });

  describe("the favorites and spoilers steps", () => {
    it("lists the latest season's constructors and drivers, and the countries", async () => {
      const choices = await favoriteChoices(db);
      const [season] = await db
        .select({ id: seasons.id })
        .from(seasons)
        .where(eq(seasons.year, 2026));
      const [{ n: constructorCount }] = (await db
        .select({ n: sql<number>`count(*)::int` })
        .from(constructorSeasons)
        .where(eq(constructorSeasons.seasonId, season!.id))) as [{ n: number }];
      expect(choices.constructors).toHaveLength(constructorCount);
      expect(choices.constructors.length).toBeGreaterThan(0);
      expect(choices.drivers.length).toBeGreaterThan(0);
      expect(choices.constructors[0]).toMatchObject({
        name: expect.any(String),
        color: expect.stringMatching(/^#[0-9a-f]{6}$/i),
      });

      const countries = countryChoices();
      expect(countries.find((c) => c.code === "IT")?.name).toBe("Italy");
      expect(countries.some((c) => c.code === "ZZ")).toBe(false);
      expect(countries.some((c) => c.name === c.code)).toBe(false);
      expect([...countries].map((c) => c.name)).toEqual(
        [...countries].map((c) => c.name).sort((a, b) => a.localeCompare(b)),
      );
    });

    it("saves the favorites with the profile version, then the spoiler choice", async () => {
      const userId = await seedUser(db);
      let viewer = await viewerOf(userId);
      const state = await onboardingState(db, viewer);
      expect(state.version).toBe(1);
      expect(state.spoilerProtection).toBe(true);

      const saved = await saveFavoritesAction(db, NOW, viewer, {
        expectedVersion: state.version,
        favoriteConstructorId: seeded.constructorIds[0]!,
        favoriteDriverId: seeded.driverIds[0]!,
        countryCode: "it",
      });
      expect(saved).toEqual({ ok: true, version: 2 });
      viewer = await viewerOf(userId);
      expect(viewer.profile).toMatchObject({
        favoriteConstructorId: seeded.constructorIds[0],
        favoriteDriverId: seeded.driverIds[0],
        countryCode: "IT",
      });

      expect(
        await saveSpoilersAction(db, NOW, viewer, {
          expectedVersion: 2,
          spoilerProtection: false,
        }),
      ).toEqual({ ok: true, version: 3 });
      expect((await viewerOf(userId)).profile.spoilerProtection).toBe(false);
    });

    it("refuses a stale version, an unreal country and a favorite that is not on the grid", async () => {
      const userId = await seedUser(db);
      const viewer = await viewerOf(userId);
      const ok = {
        favoriteConstructorId: null,
        favoriteDriverId: null,
        countryCode: null,
      };
      expect(
        await saveFavoritesAction(db, NOW, viewer, {
          ...ok,
          expectedVersion: 7,
        }),
      ).toEqual({ ok: false, error: "version_conflict" });
      expect(
        await saveFavoritesAction(db, NOW, viewer, {
          ...ok,
          expectedVersion: 1,
          countryCode: "ZZ",
        }),
      ).toEqual({ ok: false, error: "invalid_country" });
      expect(
        await saveFavoritesAction(db, NOW, viewer, {
          ...ok,
          expectedVersion: 1,
          favoriteConstructorId: newId(),
        }),
      ).toEqual({ ok: false, error: "invalid_choice" });
      expect(
        await saveSpoilersAction(db, NOW, viewer, {
          expectedVersion: 9,
          spoilerProtection: true,
        }),
      ).toEqual({ ok: false, error: "version_conflict" });
    });

    it("needs a finished, writable account", async () => {
      const userId = await seedUser(db);
      const input = {
        expectedVersion: 1,
        favoriteConstructorId: null,
        favoriteDriverId: null,
        countryCode: null,
      };
      await expect(
        saveFavoritesAction(db, NOW, null, input),
      ).rejects.toMatchObject({ code: "unauthenticated" });
      await expect(
        saveFavoritesAction(
          db,
          NOW,
          await viewerOf(userId, { complete: false }),
          input,
        ),
      ).rejects.toMatchObject({ code: "incomplete" });
      await expect(
        saveSpoilersAction(
          db,
          NOW,
          await viewerOf(userId, { impersonatedBy: newId() }),
          { expectedVersion: 1, spoilerProtection: true },
        ),
      ).rejects.toMatchObject({ code: "read_only" });
    });
  });

  describe("the username check's rate-limit key", () => {
    const headers = (init: Record<string, string>) => new Headers(init);
    const random = () => "request-1";

    it("is the user id when signed in", () => {
      expect(
        usernameCheckKey(
          headers({ "x-forwarded-for": "1.2.3.4" }),
          "u1",
          random,
        ),
      ).toBe("username-check:user:u1");
    });

    it("is the address from the headers Better Auth trusts, Vercel's first", () => {
      expect(
        usernameCheckKey(
          headers({
            "x-vercel-forwarded-for": "9.9.9.9",
            "x-forwarded-for": "1.2.3.4, 5.6.7.8",
          }),
          undefined,
          random,
        ),
      ).toBe("username-check:ip:9.9.9.9");
      expect(
        usernameCheckKey(
          headers({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" }),
          undefined,
          random,
        ),
      ).toBe("username-check:ip:1.2.3.4");
    });

    it("with no address is its own bucket, never a shared one", () => {
      expect(usernameCheckKey(headers({}), undefined, random)).toBe(
        "username-check:request:request-1",
      );
    });
  });

  describe("the checks a form asks without a reload", () => {
    it("names the problem with a username, or none", async () => {
      await seedUser(db, { username: "Someone_Else" });
      expect(await checkUsernameAction(db, NOW, "ok_name")).toBeNull();
      expect(await checkUsernameAction(db, NOW, "admin")).toBe("reserved");
      expect(await checkUsernameAction(db, NOW, "someone_else")).toBe("taken");
      expect(await checkUsernameAction(db, NOW, "x")).toBe("format");
    });

    it("says the email is busy when the day's allowance is tight", async () => {
      expect(await emailBusyAction(db, NOW)).toBe(false);
      await db.insert(settings).values({
        key: "email_caps",
        value: {
          perDay: 20,
          perMonth: 3000,
          reservedForUrgent: 20,
          alertAt: 0.8,
        },
      });
      // Nothing left for ordinary email: the notice shows.
      expect(await emailBusyAction(db, NOW)).toBe(true);
    });
  });
});

describe("the favorites grid (Ruling 57)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: Db;
  beforeEach(async () => {
    t = await createTestDb();
    db = t.db as unknown as Db;
  });
  afterEach(async () => {
    await t.close();
  });

  async function season(year: number) {
    const id = newId();
    await db.insert(seasons).values({
      id,
      year,
      status: "upcoming",
      createdAt: NOW,
      updatedAt: NOW,
    });
    return id;
  }
  async function team(seasonId: string | null, name: string) {
    const id = newId();
    await db.insert(constructors).values({
      id,
      slug: `${name}-${id}`,
      name,
      nationality: "British",
      createdAt: NOW,
      updatedAt: NOW,
    });
    if (seasonId) {
      await db.insert(constructorSeasons).values({
        constructorId: id,
        seasonId,
        displayName: `${name} F1`,
        shortName: name.slice(0, 3),
        color: "#112233",
        createdAt: NOW,
        updatedAt: NOW,
      });
    }
    return id;
  }
  async function driver(name: string) {
    const id = newId();
    await db.insert(drivers).values({
      id,
      slug: `${name}-${id}`,
      givenName: name,
      familyName: "Tester",
      nationality: "British",
      createdAt: NOW,
      updatedAt: NOW,
    });
    return id;
  }
  async function seat(
    seasonId: string,
    driverId: string,
    constructorId: string,
    carNumber: number,
    validFrom: string,
    validTo: string | null,
    role: "race" | "reserve" = "race",
  ) {
    await db.insert(seatAssignments).values({
      id: newId(),
      seasonId,
      driverId,
      constructorId,
      carNumber,
      role,
      validFrom,
      validTo,
      createdAt: NOW,
      updatedAt: NOW,
    });
  }

  it("lists the season's grid with no game at all", async () => {
    const s = await season(2026);
    const haas = await team(s, "Haas");
    const a = await driver("Aaa");
    await seat(s, a, haas, 31, "2026-01-01", null);
    const choices = await favoriteChoices(db);
    expect(choices.constructors).toEqual([
      { id: haas, name: "Haas F1", color: "#112233" },
    ]);
    expect(choices.drivers).toEqual([{ id: a, name: "Aaa Tester" }]);
  });

  it("uses only the newest season that has constructors", async () => {
    const old = await season(2025);
    const current = await season(2026);
    await season(2027); // newer, but no constructors yet
    const oldTeam = await team(old, "Old");
    const newTeam = await team(current, "New");
    const oldDriver = await driver("Olga");
    const newDriver = await driver("Nina");
    await seat(old, oldDriver, oldTeam, 1, "2025-01-01", "2025-12-31");
    await seat(current, newDriver, newTeam, 2, "2026-01-01", null);
    const choices = await favoriteChoices(db);
    expect(choices.constructors.map((c) => c.id)).toEqual([newTeam]);
    expect(choices.drivers.map((d) => d.id)).toEqual([newDriver]);
  });

  it("lists a driver who held a seat for only part of the season", async () => {
    const s = await season(2026);
    const haas = await team(s, "Haas");
    const ocon = await driver("Esteban");
    const camara = await driver("Camara");
    const reserve = await driver("Reggie");
    await seat(s, ocon, haas, 31, "2026-01-01", "2026-10-31");
    await seat(s, camara, haas, 31, "2026-11-01", null);
    await seat(s, reserve, haas, 99, "2026-01-01", null, "reserve");
    const ids = (await favoriteChoices(db)).drivers.map((d) => d.id);
    expect(ids.sort()).toEqual([ocon, camara].sort());
  });

  it("saves a favorite from the grid and still refuses an unknown id", async () => {
    const s = await season(2026);
    const haas = await team(s, "Haas");
    const a = await driver("Aaa");
    await seat(s, a, haas, 31, "2026-01-01", null);
    const userId = await seedUser(db);
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    const [profile] = await db
      .select()
      .from(profiles)
      .where(eq(profiles.userId, userId));
    const viewer = {
      userId,
      role: user!.role,
      banned: false,
      username: user!.username,
      displayUsername: user!.displayUsername,
      emailVerified: user!.emailVerified,
      twoFactorEnabled: false,
      sessionId: newId(),
      impersonatedBy: null,
      staffVerifiedAt: null,
      profile: profile!,
      complete: true,
    } as Viewer;
    const base = {
      expectedVersion: 1,
      favoriteConstructorId: null,
      favoriteDriverId: null,
      countryCode: null,
    };
    expect(
      await saveFavoritesAction(db, NOW, viewer, {
        ...base,
        favoriteDriverId: newId(),
      }),
    ).toEqual({ ok: false, error: "invalid_choice" });
    expect(
      await saveFavoritesAction(db, NOW, viewer, {
        ...base,
        favoriteConstructorId: haas,
        favoriteDriverId: a,
      }),
    ).toEqual({ ok: true, version: 2 });
  });
});

describe("country choices (Ruling 57)", () => {
  it("refuses every retired code", () => {
    for (const code of RETIRED_REGION_CODES) {
      expect(normalizeCountryCode(code)).toBeNull();
      expect(normalizeCountryCode(code.toLowerCase())).toBeNull();
    }
    expect(RETIRED_REGION_CODES.size).toBe(18);
  });

  it("has no duplicate names and none of the retired codes", () => {
    const countries = countryChoices();
    const names = countries.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const c of countries) {
      expect(RETIRED_REGION_CODES.has(c.code)).toBe(false);
    }
  });

  it("stays duplicate-free when the runtime names the retired codes", async () => {
    const RealDisplayNames = Intl.DisplayNames;
    const alias: Record<string, string> = {
      UK: "United Kingdom",
      DD: "Germany",
      BU: "Myanmar",
      YU: "Serbia",
      CS: "Serbia",
      SU: "Russia",
      FX: "France",
      ZR: "Congo - Kinshasa",
    };
    const spy = vi.spyOn(Intl, "DisplayNames").mockImplementation(function (
      this: unknown,
      ...args: ConstructorParameters<typeof Intl.DisplayNames>
    ) {
      const real = new RealDisplayNames(...args);
      return {
        of: (code: string) =>
          alias[code] ??
          (RETIRED_REGION_CODES.has(code)
            ? code + " (retired)"
            : real.of(code)),
        resolvedOptions: () => real.resolvedOptions(),
      } as Intl.DisplayNames;
    } as unknown as typeof Intl.DisplayNames);
    try {
      // profile.ts builds its own DisplayNames when first loaded, so load a
      // fresh copy of both modules under the stub.
      vi.resetModules();
      const fresh = await import("./account-actions");
      const countries = fresh.countryChoices();
      const names = countries.map((c) => c.name);
      expect(new Set(names).size).toBe(names.length);
      expect(countries.some((c) => RETIRED_REGION_CODES.has(c.code))).toBe(
        false,
      );
      expect(countries.find((c) => c.code === "GB")).toBeDefined();
    } finally {
      spy.mockRestore();
    }
  });
});
