import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../tests/helpers/test-db";
import { seedLeagueGames } from "../../tests/helpers/leagues-game";
import { seedUser } from "../../tests/helpers/users";
import {
  auditLog,
  authAccounts,
  authSessions,
  leagues,
  privacyRequests,
  profiles,
  teams,
  users,
} from "@/db/schema";
import type { Db } from "@/db/types";
import type { EmailSender } from "@/identity/email/sender";
import type { Viewer } from "@/identity/viewer";
import { newId } from "@/lib/ids";
import {
  changeUsernameAction,
  confirmDeletionAction,
  deletePageState,
  exportState,
  profileState,
  removeSignInMethodAction,
  requestDeletionAction,
  requestExportAction,
  saveSpoilerSettingAction,
  securityState,
  settingsOverview,
  signInMethodsState,
  usernameState,
} from "./settings-actions";

const NOW = new Date("2026-11-08T09:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const later = (days: number) => new Date(NOW.getTime() + days * DAY_MS);

describe("settings actions (M5 task 13)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: Db;

  beforeEach(async () => {
    t = await createTestDb();
    db = t.db as unknown as Db;
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
      twoFactorEnabled: user!.twoFactorEnabled,
      sessionId: newId(),
      impersonatedBy: null,
      staffVerifiedAt: null,
      profile: profile!,
      complete: true,
      ...over,
    };
  }

  async function addAccount(userId: string, providerId: string) {
    await db.insert(authAccounts).values({
      id: newId(),
      accountId: providerId === "credential" ? userId : `discord-${userId}`,
      providerId,
      userId,
      password: providerId === "credential" ? "hash" : null,
      createdAt: NOW,
      updatedAt: NOW,
    });
  }

  const impersonated = (v: Viewer): Viewer => ({
    ...v,
    impersonatedBy: newId(),
  });

  describe("profile", () => {
    it("shows the username, the trust level in words and the join date", async () => {
      const userId = await seedUser(db, { username: "Late_Braker" });
      await db
        .update(profiles)
        .set({ trustLevel: 2, countryCode: "IT", reputation: 12 })
        .where(eq(profiles.userId, userId));
      const state = await profileState(db, await viewerOf(userId));
      expect(state).toMatchObject({
        username: "Late_Braker",
        trust: { name: "Member" },
        joined: "Jan 2026",
        reputation: 12,
        favorites: { team: null, driver: null, country: "Italy" },
      });
      expect(state.trust.allows).toMatch(/^Member means you can /);
    });

    it("names the favorites from the reference data", async () => {
      const seeded = await seedLeagueGames(db, NOW);
      const userId = await seedUser(db);
      await db
        .update(profiles)
        .set({
          favoriteConstructorId: seeded.constructorIds[0]!,
          favoriteDriverId: seeded.driverIds[0]!,
        })
        .where(eq(profiles.userId, userId));
      const state = await profileState(db, await viewerOf(userId));
      expect(state.favorites.team?.name).toEqual(expect.any(String));
      expect(state.favorites.team?.color).toMatch(/^#/);
      expect(state.favorites.driver).toEqual(expect.any(String));
    });

    it("can be read through an impersonated session", async () => {
      const userId = await seedUser(db);
      const state = await profileState(
        db,
        impersonated(await viewerOf(userId)),
      );
      expect(state.username).toEqual(expect.any(String));
    });
  });

  describe("username", () => {
    it("says a first change can happen now, then gives the next date", async () => {
      const userId = await seedUser(db, { username: "first_name" });
      expect(await usernameState(db, NOW, await viewerOf(userId))).toEqual({
        username: "first_name",
        nextChange: null,
        changeDays: 30,
        holdDays: 90,
      });

      const result = await changeUsernameAction(
        db,
        NOW,
        await viewerOf(userId),
        { username: "Second_Name" },
      );
      expect(result).toEqual({
        ok: true,
        username: "Second_Name",
        nextChange: "8 Dec",
      });
      expect(await usernameState(db, later(1), await viewerOf(userId))).toEqual(
        expect.objectContaining({
          username: "Second_Name",
          nextChange: "8 Dec",
        }),
      );
      // Thirty days on, it's open again.
      expect(
        (await usernameState(db, later(30), await viewerOf(userId))).nextChange,
      ).toBeNull();
    });

    it("refuses a second rename inside the wait, and says when", async () => {
      const userId = await seedUser(db, { username: "first_name" });
      await changeUsernameAction(db, NOW, await viewerOf(userId), {
        username: "second_name",
      });
      const again = await changeUsernameAction(
        db,
        later(2),
        await viewerOf(userId),
        { username: "third_name" },
      );
      expect(again).toEqual({
        ok: false,
        error: "username_too_soon",
        nextChange: "8 Dec",
      });
      const [user] = await db.select().from(users).where(eq(users.id, userId));
      expect(user!.username).toBe("second_name");
    });

    it("writes the date in the person's time zone", async () => {
      const userId = await seedUser(db, { username: "first_name" });
      await db
        .update(profiles)
        .set({ timezone: "Pacific/Auckland" })
        .where(eq(profiles.userId, userId));
      const at = new Date("2026-11-08T13:00:00.000Z"); // 9 Nov 02:00 there
      const result = await changeUsernameAction(
        db,
        at,
        await viewerOf(userId),
        { username: "second_name" },
      );
      expect(result).toMatchObject({ ok: true, nextChange: "9 Dec" });
    });

    it("says why a name is refused", async () => {
      const taken = await seedUser(db, { username: "taken_name" });
      const userId = await seedUser(db, { username: "first_name" });
      expect(taken).toBeTruthy();
      expect(
        await changeUsernameAction(db, NOW, await viewerOf(userId), {
          username: "Taken_Name",
        }),
      ).toEqual({ ok: false, error: "taken" });
      expect(
        await changeUsernameAction(db, NOW, await viewerOf(userId), {
          username: "no spaces",
        }),
      ).toEqual({ ok: false, error: "format" });
    });

    it("is read-only through an impersonated session", async () => {
      const userId = await seedUser(db, { username: "first_name" });
      expect(
        await changeUsernameAction(
          db,
          NOW,
          impersonated(await viewerOf(userId)),
          { username: "second_name" },
        ),
      ).toEqual({ ok: false, error: "read_only" });
      const [user] = await db.select().from(users).where(eq(users.id, userId));
      expect(user!.username).toBe("first_name");
    });
  });

  describe("sign-in methods", () => {
    it("lists the methods", async () => {
      const userId = await seedUser(db, { email: "me@example.test" });
      await addAccount(userId, "credential");
      await addAccount(userId, "discord");
      expect(await signInMethodsState(db, await viewerOf(userId))).toEqual({
        email: "me@example.test",
        methods: [
          { providerId: "credential", label: "Email and password" },
          { providerId: "discord", label: "Discord" },
        ],
      });
    });

    it("refuses to remove the last method of a password-only account", async () => {
      const userId = await seedUser(db);
      await addAccount(userId, "credential");
      expect(
        await removeSignInMethodAction(db, NOW, await viewerOf(userId), {
          providerId: "credential",
        }),
      ).toEqual({ ok: false, error: "last_method" });
      const left = await db
        .select()
        .from(authAccounts)
        .where(eq(authAccounts.userId, userId));
      expect(left).toHaveLength(1);
    });

    it("removes one of two, with an audit row", async () => {
      const userId = await seedUser(db);
      await addAccount(userId, "credential");
      await addAccount(userId, "discord");
      expect(
        await removeSignInMethodAction(db, NOW, await viewerOf(userId), {
          providerId: "discord",
        }),
      ).toEqual({ ok: true });
      const left = await db
        .select({ providerId: authAccounts.providerId })
        .from(authAccounts)
        .where(eq(authAccounts.userId, userId));
      expect(left).toEqual([{ providerId: "credential" }]);
      const [audit] = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, "user.sign_in_method.remove"));
      expect(audit).toMatchObject({
        actorUserId: userId,
        actorKind: "user",
        entityId: userId,
        before: { providerId: "discord" },
      });
      // Then the last one stays.
      expect(
        await removeSignInMethodAction(db, NOW, await viewerOf(userId), {
          providerId: "credential",
        }),
      ).toEqual({ ok: false, error: "last_method" });
    });

    it("refuses a method that isn't linked, and an impersonated session", async () => {
      const userId = await seedUser(db);
      await addAccount(userId, "credential");
      await addAccount(userId, "discord");
      expect(
        await removeSignInMethodAction(db, NOW, await viewerOf(userId), {
          providerId: "github",
        }),
      ).toEqual({ ok: false, error: "not_linked" });
      expect(
        await removeSignInMethodAction(
          db,
          NOW,
          impersonated(await viewerOf(userId)),
          { providerId: "discord" },
        ),
      ).toEqual({ ok: false, error: "read_only" });
      const left = await db
        .select()
        .from(authAccounts)
        .where(eq(authAccounts.userId, userId));
      expect(left).toHaveLength(2);
    });
  });

  describe("settings overview and spoilers", () => {
    it("sums up the account", async () => {
      const userId = await seedUser(db, { username: "late_braker" });
      await addAccount(userId, "credential");
      await addAccount(userId, "discord");
      await db
        .update(profiles)
        .set({ countryCode: "IT" })
        .where(eq(profiles.userId, userId));
      expect(await settingsOverview(db, NOW, await viewerOf(userId))).toEqual({
        version: 1,
        spoilerProtection: true,
        username: "late_braker",
        nextUsernameChange: null,
        favorites: "Italy",
        methods: "Email and Discord",
      });
    });

    it("saves the spoiler setting, and refuses an impersonated session plainly", async () => {
      const userId = await seedUser(db);
      expect(
        await saveSpoilerSettingAction(db, NOW, await viewerOf(userId), {
          expectedVersion: 1,
          spoilerProtection: false,
        }),
      ).toEqual({ ok: true, version: 2 });
      expect(
        await saveSpoilerSettingAction(
          db,
          NOW,
          impersonated(await viewerOf(userId)),
          { expectedVersion: 2, spoilerProtection: true },
        ),
      ).toEqual({ ok: false, error: "read_only" });
      const [profile] = await db
        .select()
        .from(profiles)
        .where(eq(profiles.userId, userId));
      expect(profile!.spoilerProtection).toBe(false);
    });
  });

  describe("security", () => {
    it("offers two-step set-up to staff only", async () => {
      const userId = await seedUser(db);
      await addAccount(userId, "credential");
      expect(await securityState(db, await viewerOf(userId))).toEqual({
        hasPassword: true,
        staff: false,
        twoFactorEnabled: false,
        staffUnlocked: false,
      });
      const adminId = await seedUser(db, { role: "admin" });
      expect(
        await securityState(
          db,
          await viewerOf(adminId, {
            twoFactorEnabled: true,
            staffVerifiedAt: NOW,
          }),
        ),
      ).toEqual({
        hasPassword: false,
        staff: true,
        twoFactorEnabled: true,
        staffUnlocked: true,
      });
    });
  });

  describe("data export", () => {
    it("goes from nothing, to on its way, to ready, to expired", async () => {
      const userId = await seedUser(db);
      const viewer = await viewerOf(userId);
      expect(await exportState(db, NOW, viewer)).toEqual({ status: "none" });

      expect(await requestExportAction(db, NOW, viewer)).toEqual({ ok: true });
      expect(await exportState(db, NOW, viewer)).toEqual({
        status: "pending",
      });
      // Asking again while it's open.
      expect(await requestExportAction(db, NOW, viewer)).toEqual({
        ok: false,
        error: "export_pending",
      });

      await db
        .update(privacyRequests)
        .set({
          status: "completed",
          completedAt: NOW,
          exportUrl: "https://exports.example.test/file",
          exportExpiresAt: later(7),
        })
        .where(eq(privacyRequests.userId, userId));
      expect(await exportState(db, later(1), viewer)).toEqual({
        status: "ready",
        url: "https://exports.example.test/file",
        worksUntil: "15 Nov",
      });
      // A second one the same day is refused.
      expect(await requestExportAction(db, later(0.5), viewer)).toEqual({
        ok: false,
        error: "export_too_soon",
      });
      expect(await exportState(db, later(8), viewer)).toEqual({
        status: "expired",
      });
    });

    it("says when the job gave up", async () => {
      const userId = await seedUser(db);
      const viewer = await viewerOf(userId);
      await requestExportAction(db, NOW, viewer);
      await db
        .update(privacyRequests)
        .set({ status: "failed" })
        .where(eq(privacyRequests.userId, userId));
      expect(await exportState(db, NOW, viewer)).toEqual({ status: "failed" });
    });

    it("is read-only through an impersonated session", async () => {
      const userId = await seedUser(db);
      expect(
        await requestExportAction(
          db,
          NOW,
          impersonated(await viewerOf(userId)),
        ),
      ).toEqual({ ok: false, error: "read_only" });
    });
  });

  describe("deletion", () => {
    function captureSender() {
      const sent: { to: string; text: string }[] = [];
      const sender: EmailSender = {
        async send(message) {
          sent.push({ to: message.to, text: message.text });
          return { id: `sent-${sent.length}` };
        },
      };
      return { sent, sender };
    }

    it("names the teams that stop and the leagues that carry on", async () => {
      const seeded = await seedLeagueGames(db, NOW);
      const userId = await seedUser(db, { username: "late_braker" });
      await db.insert(teams).values({
        id: newId(),
        gameId: seeded.gameId,
        userId,
        slot: 1,
        name: "Late Brakers",
        status: "active",
        createdAt: NOW,
        updatedAt: NOW,
      });
      await db.insert(leagues).values({
        id: newId(),
        gameId: seeded.gameId,
        kind: "private",
        name: "Thursday Pub Quiz",
        slug: "thursday-pub-quiz",
        ownerUserId: userId,
        joinCode: "ABCDEFGH",
        status: "active",
        createdAt: NOW,
        updatedAt: NOW,
      });
      expect(await deletePageState(db, await viewerOf(userId))).toEqual({
        username: "late_braker",
        emailVerified: true,
        teams: ["Late Brakers"],
        leagues: ["Thursday Pub Quiz"],
      });
    });

    it("emails a link to the settings confirm page on the site's address", async () => {
      const userId = await seedUser(db, {
        username: "late_braker",
        email: "late@example.test",
      });
      const { sent, sender } = captureSender();
      const deps = { sender, baseUrl: "https://gridlocked.example" };
      expect(
        await requestDeletionAction(
          db,
          NOW,
          await viewerOf(userId),
          { typedUsername: "someone_else" },
          deps,
        ),
      ).toEqual({ ok: false, error: "wrong_username" });
      expect(
        await requestDeletionAction(
          db,
          NOW,
          await viewerOf(userId),
          { typedUsername: "LATE_BRAKER" },
          deps,
        ),
      ).toEqual({ ok: true, confirm: "email" });
      expect(sent).toHaveLength(1);
      const link = sent[0]!.text.match(/https:\/\/\S+/)![0];
      expect(link).toMatch(
        /^https:\/\/gridlocked\.example\/settings\/delete\/confirm\?token=/,
      );

      const token = decodeURIComponent(
        new URL(link).searchParams.get("token")!,
      );
      expect(
        await confirmDeletionAction(db, NOW, null, { token: "not-it" }),
      ).toEqual({ ok: false, error: "invalid_link" });
      expect(await confirmDeletionAction(db, NOW, null, { token })).toEqual({
        ok: true,
      });
      const [profile] = await db
        .select()
        .from(profiles)
        .where(eq(profiles.userId, userId));
      expect(profile!.status).toBe("deleted");
      // Used up.
      expect(await confirmDeletionAction(db, NOW, null, { token })).toEqual({
        ok: false,
        error: "invalid_link",
      });
    });

    it("with no confirmed address, a fresh sign-in deletes at once and an old one asks to sign in again", async () => {
      const userId = await seedUser(db, {
        username: "late_braker",
        emailVerified: false,
      });
      const sessionId = newId();
      await db.insert(authSessions).values({
        id: sessionId,
        token: `token-${sessionId}`,
        userId,
        expiresAt: later(7),
        createdAt: new Date(NOW.getTime() - 20 * 60_000),
        updatedAt: NOW,
      });
      const deps = { sender: null, baseUrl: "https://gridlocked.example" };
      const viewer = await viewerOf(userId, { sessionId });
      expect(
        await requestDeletionAction(
          db,
          NOW,
          viewer,
          { typedUsername: "late_braker" },
          deps,
        ),
      ).toEqual({ ok: false, error: "sign_in_again" });
      await db
        .update(authSessions)
        .set({ createdAt: NOW })
        .where(eq(authSessions.id, sessionId));
      expect(
        await requestDeletionAction(
          db,
          NOW,
          viewer,
          { typedUsername: "late_braker" },
          deps,
        ),
      ).toEqual({ ok: true, confirm: "fresh_sign_in" });
    });

    it("is read-only through an impersonated session, both ways", async () => {
      const userId = await seedUser(db, { username: "late_braker" });
      const viewer = impersonated(await viewerOf(userId));
      const deps = { sender: null, baseUrl: "https://gridlocked.example" };
      expect(
        await requestDeletionAction(
          db,
          NOW,
          viewer,
          { typedUsername: "late_braker" },
          deps,
        ),
      ).toEqual({ ok: false, error: "read_only" });
      expect(
        await confirmDeletionAction(db, NOW, viewer, { token: "anything" }),
      ).toEqual({ ok: false, error: "read_only" });
      const open = await db
        .select()
        .from(privacyRequests)
        .where(
          and(
            eq(privacyRequests.userId, userId),
            eq(privacyRequests.kind, "delete"),
          ),
        );
      expect(open).toHaveLength(0);
    });

    it("refuses the last admin", async () => {
      const adminId = await seedUser(db, {
        username: "only_admin",
        role: "admin",
      });
      const deps = { sender: null, baseUrl: "https://gridlocked.example" };
      expect(
        await requestDeletionAction(
          db,
          NOW,
          await viewerOf(adminId),
          { typedUsername: "only_admin" },
          deps,
        ),
      ).toEqual({ ok: false, error: "last_admin" });
    });
  });
});
