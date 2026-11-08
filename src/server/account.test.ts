import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../tests/helpers/test-db";
import { seedLeagueGames } from "../../tests/helpers/leagues-game";
import { seedUser } from "../../tests/helpers/users";
import {
  games,
  legalAcceptances,
  poolAssets,
  profiles,
  settings,
  users,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { newId } from "@/lib/ids";
import type { Viewer } from "@/identity/viewer";
import {
  checkUsernameAction,
  countryChoices,
  emailBusyAction,
  favoriteChoices,
  finishSignUpAction,
  finishSignUpInput,
  onboardingState,
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
    await db
      .update(games)
      .set({ status: "running" })
      .where(eq(games.id, seeded.gameId));
    // Only some of the reference rows are in the running game's pool.
    await db.insert(poolAssets).values([
      ...seeded.constructorIds.slice(0, 2).map((constructorId) => ({
        id: newId(),
        gameId: seeded.gameId,
        assetType: "constructor" as const,
        constructorId,
        status: "active" as const,
        addedFromEventId: seeded.eventIds[0]!,
        createdAt: NOW,
        updatedAt: NOW,
      })),
      ...seeded.driverIds.slice(0, 3).map((driverId) => ({
        id: newId(),
        gameId: seeded.gameId,
        assetType: "driver" as const,
        driverId,
        status: "active" as const,
        addedFromEventId: seeded.eventIds[0]!,
        createdAt: NOW,
        updatedAt: NOW,
      })),
    ]);
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
    it("lists the running game's constructors and drivers, and the countries", async () => {
      const choices = await favoriteChoices(db);
      expect(choices.constructors.map((c) => c.id).sort()).toEqual(
        seeded.constructorIds.slice(0, 2).sort(),
      );
      expect(choices.drivers).toHaveLength(3);
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

    it("refuses a stale version, an unreal country and a favorite the game lacks", async () => {
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
          favoriteConstructorId: seeded.constructorIds.at(-1)!,
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
