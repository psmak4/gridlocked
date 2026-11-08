import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { is } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import {
  GAME_NOW,
  seedOpenGame,
  seedPlayer,
} from "../../tests/helpers/account-2026";
import {
  authPost,
  cookieHeader,
  PASSWORD,
  recordingSender,
  signUpRequest,
  testAuth,
  type TestAuth,
} from "../../tests/helpers/auth";
import { signInWithDiscord } from "../../tests/helpers/discord";
import { errorCode, viewerFor } from "../../tests/helpers/staff";
import { seedUser } from "../../tests/helpers/users";
import { lockRound } from "../../tests/helpers/game-2026";
import * as schema from "@/db/schema";
import {
  auditLog,
  authAccounts,
  authSessions,
  authTwoFactors,
  authVerifications,
  emailOutbox,
  leagueMemberships,
  leagues,
  leagueStandings,
  legalAcceptances,
  privacyRequests,
  profiles,
  teamEventStates,
  teams,
  usernameHistory,
  users,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { writeAudit } from "@/audit/log";
import { createGameHandlers } from "@/game/jobs";
import { joinLeague } from "@/leagues/leagues";
import { gameLockKey } from "@/jobs/kinds";
import { enqueue } from "@/jobs/queue";
import { runDue } from "@/jobs/runner";
import { simulatedClock } from "@/lib/clock";
import { newId } from "@/lib/ids";
import { setSimulatedClock } from "@/replay/clock-loop";
import { completeSignUp, purgeIncompleteAccountsCounted } from "./consent";
import { pruneIdentity } from "./daily";
import {
  confirmDeletion,
  requestDeletion,
  scrubAccount,
  tombstoneEmail,
  type DeletionActor,
} from "./delete";
import { requestExport } from "./export";
import { SYSTEM_USER_ID } from "./system";
import { checkUsername } from "./usernames";
import type { Viewer } from "./viewer";

const NOW = new Date("2026-11-08T06:00:00Z");
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const after = (ms: number, from = NOW) => new Date(from.getTime() + ms);

const self = (userId: string): DeletionActor => ({
  kind: "user",
  userId,
  label: "self",
});

/** A session for `userId` made at `createdAt`, and the viewer it gives. */
async function viewerWithSession(
  db: Db,
  userId: string,
  createdAt: Date,
): Promise<Viewer> {
  const sessionId = newId();
  await db.insert(authSessions).values({
    id: sessionId,
    userId,
    token: `tok-${sessionId}`,
    expiresAt: after(30 * DAY, createdAt),
    createdAt,
    updatedAt: createdAt,
  });
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  const [profile] = await db
    .select()
    .from(profiles)
    .where(eq(profiles.userId, userId));
  return {
    userId,
    role: user!.role,
    banned: user!.banned,
    username: user!.username,
    displayUsername: user!.displayUsername,
    emailVerified: user!.emailVerified,
    twoFactorEnabled: user!.twoFactorEnabled,
    sessionId,
    impersonatedBy: null,
    staffVerifiedAt: null,
    profile: profile!,
    complete: true,
  };
}

/** The token in the newest delete_confirm email's link. */
async function confirmToken(db: Db): Promise<string> {
  const rows = await db
    .select()
    .from(emailOutbox)
    .where(
      and(
        eq(emailOutbox.template, "delete_confirm"),
        eq(emailOutbox.status, "queued"),
      ),
    );
  const row = rows.at(-1);
  const url = (row?.payload as { url?: string } | undefined)?.url;
  if (!url) throw new Error("no delete_confirm email");
  const token = new URL(url, "http://localhost").searchParams.get("token");
  if (!token) throw new Error("no token in the link");
  return token;
}

const userRow = async (db: Db, id: string) =>
  (await db.select().from(users).where(eq(users.id, id)))[0]!;
const profileRow = async (db: Db, id: string) =>
  (await db.select().from(profiles).where(eq(profiles.userId, id)))[0]!;

describe("account deletion (DM 6.7)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.close();
  });

  describe("the scrub", () => {
    let game: Awaited<ReturnType<typeof seedOpenGame>>;
    beforeEach(async () => {
      game = await seedOpenGame(t.db);
    });

    it("deletion leaves a tombstone that every foreign key still accepts", async () => {
      const player = await seedPlayer(t.db, game, { username: "Ada_Fan" });
      const { userId } = player;
      await completeSignUp(t.db, GAME_NOW, {
        userId,
        ageConfirmed: true,
        accepted: true,
      });
      await writeAudit(t.db, NOW, {
        actorUserId: userId,
        actorKind: "user",
        actorLabel: null,
        action: "profile.update",
        entityType: "user",
        entityId: userId,
        before: null,
        after: { timezone: "UTC" },
        reason: null,
        requestId: null,
      });
      const { requestId } = await requestExport(t.db, NOW, { userId });

      await scrubAccount(t.db, NOW, { userId, actor: self(userId) });
      // The scrub ran: the check below can't fail on its own, since the
      // database enforces those keys and the row is never deleted.
      expect((await userRow(t.db, userId)).email).toBe(tombstoneEmail(userId));
      expect((await profileRow(t.db, userId)).status).toBe("deleted");

      // Every foreign key to users, read from the schema, still resolves.
      for (const table of Object.values(schema) as unknown[]) {
        if (!is(table, PgTable)) continue;
        const config = getTableConfig(table);
        for (const fk of config.foreignKeys) {
          const ref = fk.reference();
          if (getTableConfig(ref.foreignTable).name !== "users") continue;
          for (const column of ref.columns) {
            const { rows } = await t.db.execute(sql`
              select count(*)::int as n from ${sql.identifier(config.name)} t
              left join users u on u.id = t.${sql.identifier(column.name)}
              where t.${sql.identifier(column.name)} is not null and u.id is null`);
            expect(
              (rows[0] as { n: number }).n,
              `${config.name}.${column.name}`,
            ).toBe(0);
          }
        }
      }
      // And the rows that name the user are still there, on the tombstone.
      expect(await userRow(t.db, userId)).toBeTruthy();
      expect(
        await t.db.select().from(teams).where(eq(teams.userId, userId)),
      ).toHaveLength(1);
      expect(
        await t.db
          .select()
          .from(legalAcceptances)
          .where(eq(legalAcceptances.userId, userId)),
      ).not.toHaveLength(0);
      expect(
        await t.db
          .select()
          .from(auditLog)
          .where(eq(auditLog.actorUserId, userId)),
      ).not.toHaveLength(0);
      const [request] = await t.db
        .select()
        .from(privacyRequests)
        .where(eq(privacyRequests.id, requestId));
      expect(request?.userId).toBe(userId);
    });

    it("no personal field survives", async () => {
      const { userId } = await seedPlayer(t.db, game, { username: "Ada_Fan" });
      await t.db
        .update(users)
        .set({
          image: "https://cdn.example.test/ada.png",
          name: "Ada Lovelace",
          banned: true,
          banReason: "spam",
        })
        .where(eq(users.id, userId));
      await t.db
        .update(profiles)
        .set({
          countryCode: "GB",
          timezone: "Europe/London",
          ageConfirmedAt: NOW,
          lastSeenAt: NOW,
          daysVisited: 12,
          reputation: 30,
          trustLevel: 2,
          spoilerProtection: false,
        })
        .where(eq(profiles.userId, userId));
      await t.db.insert(authAccounts).values({
        id: newId(),
        accountId: "4242",
        providerId: "discord",
        userId,
        accessToken: "a",
      });
      await t.db.insert(authTwoFactors).values({
        id: newId(),
        userId,
        secret: "s",
        backupCodes: "b",
      });
      await viewerWithSession(t.db, userId, NOW);
      const before = await userRow(t.db, userId);

      await scrubAccount(t.db, NOW, { userId, actor: self(userId) });

      const user = await userRow(t.db, userId);
      // The allow-list: everything else is empty, a default or the tombstone.
      expect(user).toEqual({
        id: userId,
        name: "",
        email: `deleted-${userId}@deleted.invalid`,
        emailVerified: false,
        image: null,
        createdAt: before.createdAt,
        updatedAt: NOW,
        role: "user",
        banned: false,
        banReason: null,
        banExpires: null,
        username: null,
        displayUsername: null,
        twoFactorEnabled: false,
      });
      expect(tombstoneEmail(userId)).toBe(user.email);
      const profile = await profileRow(t.db, userId);
      expect(profile).toEqual({
        userId,
        status: "deleted",
        avatarSeed: userId,
        favoriteConstructorId: null,
        favoriteDriverId: null,
        countryCode: null,
        timezone: "UTC",
        spoilerProtection: true,
        ageConfirmedAt: null,
        trustLevel: 0,
        trustLevelLocked: false,
        reputation: 0,
        daysVisited: 0,
        lastSeenAt: null,
        broadcastsReadAt: null,
        usernameChangedAt: null,
        createdAt: profile.createdAt,
        updatedAt: NOW,
        version: profile.version,
      });
      for (const table of [authSessions, authAccounts, authTwoFactors]) {
        expect(
          await t.db.select().from(table).where(eq(table.userId, userId)),
        ).toEqual([]);
      }
    });

    it("the email stays unique", async () => {
      const a = await seedUser(t.db);
      const b = await seedUser(t.db);
      await scrubAccount(t.db, NOW, { userId: a, actor: self(a) });
      await scrubAccount(t.db, after(MIN), { userId: b, actor: self(b) });
      const emails = [
        (await userRow(t.db, a)).email,
        (await userRow(t.db, b)).email,
      ];
      expect(emails).toEqual([tombstoneEmail(a), tombstoneEmail(b)]);
      expect(new Set(emails).size).toBe(2);
      // Deleting again changes nothing.
      await scrubAccount(t.db, after(2 * MIN), { userId: a, actor: self(a) });
      expect((await userRow(t.db, a)).updatedAt).toEqual(NOW);
    });

    it("the teams leave every league and show as Deleted team", async () => {
      const player = await seedPlayer(t.db, game);
      const other = await seedPlayer(t.db, game);
      await scrubAccount(t.db, NOW, {
        userId: player.userId,
        actor: self(player.userId),
      });
      const [team] = await t.db
        .select()
        .from(teams)
        .where(eq(teams.id, player.teamId));
      expect(team).toMatchObject({ status: "retired", name: "Deleted team" });
      const memberships = await t.db
        .select()
        .from(leagueMemberships)
        .where(eq(leagueMemberships.teamId, player.teamId));
      expect(memberships).toHaveLength(1);
      expect(
        memberships.every((m) => m.leftAt?.getTime() === NOW.getTime()),
      ).toBe(true);
      // Someone else's team is untouched.
      const [kept] = await t.db
        .select()
        .from(leagueMemberships)
        .where(eq(leagueMemberships.teamId, other.teamId));
      expect(kept?.leftAt).toBeNull();
    });

    it("past standings keep them", async () => {
      const player = await seedPlayer(t.db, game);
      await lockRound(t.db, game.gameId, game.round1.id);
      await t.db.insert(leagueStandings).values({
        leagueId: player.leagueId,
        teamId: player.teamId,
        points: 42,
        firstReachedSequence: 1,
        rank: 1,
        throughEventId: game.round1.id,
        status: "final",
      });
      await scrubAccount(t.db, NOW, {
        userId: player.userId,
        actor: self(player.userId),
      });
      expect(
        await t.db
          .select()
          .from(teamEventStates)
          .where(eq(teamEventStates.teamId, player.teamId)),
      ).toHaveLength(1);
      expect(
        await t.db
          .select()
          .from(leagueStandings)
          .where(eq(leagueStandings.teamId, player.teamId)),
      ).toMatchObject([{ points: 42, rank: 1 }]);
    });

    it("a league they own stays active with no owner", async () => {
      const owner = await seedPlayer(t.db, game);
      const member = await seedPlayer(t.db, game);
      // The other player's team joins the owner's league too.
      await joinLeague(t.db, GAME_NOW, {
        joinCode: owner.joinCode,
        teamId: member.teamId,
        userId: member.userId,
      });
      await scrubAccount(t.db, NOW, {
        userId: owner.userId,
        actor: self(owner.userId),
      });
      const [league] = await t.db
        .select()
        .from(leagues)
        .where(eq(leagues.id, owner.leagueId));
      expect(league).toMatchObject({ status: "active", ownerUserId: null });
      const [stays] = await t.db
        .select()
        .from(leagueMemberships)
        .where(
          and(
            eq(leagueMemberships.leagueId, owner.leagueId),
            eq(leagueMemberships.teamId, member.teamId),
          ),
        );
      expect(stays?.leftAt).toBeNull();
    });

    it("a moderator can delete an under-16 account, audited", async () => {
      const moderator = await seedUser(t.db, { role: "moderator" });
      const { userId } = await seedPlayer(t.db, game);
      await scrubAccount(t.db, NOW, {
        userId,
        actor: { kind: "moderator", userId: moderator, label: "mod_one" },
        reason: "under 16",
      });
      expect((await profileRow(t.db, userId)).status).toBe("deleted");
      const rows = await t.db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.entityId, userId),
            eq(auditLog.action, "user.delete"),
          ),
        );
      expect(rows).toMatchObject([
        {
          actorUserId: moderator,
          actorKind: "moderator",
          actorLabel: "mod_one",
          entityType: "user",
          reason: "under 16",
        },
      ]);
    });

    it("a staff deletion needs a reason", async () => {
      const moderator = await seedUser(t.db, { role: "moderator" });
      const userId = await seedUser(t.db);
      for (const reason of [undefined, "  "]) {
        await expect(
          scrubAccount(t.db, NOW, {
            userId,
            actor: { kind: "moderator", userId: moderator, label: "mod_one" },
            reason,
          }),
        ).rejects.toThrow(/reason/);
      }
      expect((await profileRow(t.db, userId)).status).toBe("active");
    });

    it("the purge of unfinished sign-ups leaves a tombstone older than 7 days", async () => {
      const userId = await seedUser(t.db);
      await scrubAccount(t.db, NOW, { userId, actor: self(userId) });
      // The scrub clears the age confirmation, and the seeded account is
      // months old: it looks like an unfinished sign-up.
      expect((await profileRow(t.db, userId)).ageConfirmedAt).toBeNull();
      const counted = await purgeIncompleteAccountsCounted(
        t.db,
        after(8 * DAY),
      );
      expect(counted).toEqual({ purged: 0, skipped: 0 });
      expect(await userRow(t.db, userId)).toMatchObject({
        email: tombstoneEmail(userId),
      });
    });

    it("the audit row has no email", async () => {
      const userId = await seedUser(t.db, {
        username: "Ada_Fan",
        email: "ada.lovelace@example.test",
      });
      await scrubAccount(t.db, NOW, { userId, actor: self(userId) });
      const [row] = await t.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, "user.delete"));
      const text = JSON.stringify(row);
      expect(text).not.toContain("ada.lovelace");
      expect(text).not.toContain("example.test");
      expect(text.toLowerCase()).not.toContain("ada_fan");
      expect(text).not.toContain("deleted.invalid");
    });

    it("the system user can't be deleted", async () => {
      expect(
        await errorCode(() =>
          scrubAccount(t.db, NOW, {
            userId: SYSTEM_USER_ID,
            actor: self(SYSTEM_USER_ID),
          }),
        ),
      ).toBe("role_reserved");
    });

    it("the sign-in leftovers for the address go: links, sessions and queued mail", async () => {
      const userId = await seedUser(t.db, { email: "ada@example.test" });
      const v = async (identifier: string, value: string) =>
        t.db.insert(authVerifications).values({
          id: `v-${newId()}`,
          identifier,
          value,
          expiresAt: after(DAY),
        });
      await v("ada@example.test", "reset");
      await v("reset-password:abc", userId);
      await v(
        "magic-link:hash1",
        JSON.stringify({ email: "Ada@Example.test" }),
      );
      await v(
        "magic-link:hash2",
        JSON.stringify({ email: "bob@example.test" }),
      );
      await t.db.insert(emailOutbox).values([
        {
          id: newId(),
          toEmail: "ada@example.test",
          template: "magic_link",
          status: "queued",
          sendAfter: NOW,
          attempts: 2,
        },
        {
          id: newId(),
          toEmail: "ADA@example.test",
          template: "password_reset",
          status: "failed",
          sendAfter: NOW,
        },
      ]);
      await scrubAccount(t.db, NOW, { userId, actor: self(userId) });
      const left = await t.db.select().from(authVerifications);
      expect(left.map((r) => r.identifier)).toEqual(["magic-link:hash2"]);
      const outbox = await t.db.select().from(emailOutbox);
      expect(outbox).toMatchObject([
        { status: "failed", toEmail: tombstoneEmail(userId) },
      ]);
    });
  });

  describe("asking and confirming", () => {
    let mail: ReturnType<typeof recordingSender>;
    beforeEach(() => {
      mail = recordingSender();
    });
    const deps = () => ({
      sender: null,
      baseUrl: "http://localhost:3000",
    });

    it("the wrong typed username is refused", async () => {
      const userId = await seedUser(t.db, { username: "Ada_Fan" });
      const viewer = await viewerWithSession(t.db, userId, NOW);
      expect(
        await errorCode(() =>
          requestDeletion(
            t.db,
            NOW,
            { viewer, typedUsername: "ada_fam" },
            deps(),
          ),
        ),
      ).toBe("wrong_username");
      expect(await t.db.select().from(privacyRequests)).toEqual([]);
      expect(await t.db.select().from(emailOutbox)).toEqual([]);
      // Any case will do, as for the name itself.
      expect(
        await requestDeletion(
          t.db,
          NOW,
          { viewer, typedUsername: " ADA_FAN " },
          deps(),
        ),
      ).toEqual({ confirm: "email" });
    });

    it("an account with no username confirms by typing its email address", async () => {
      const userId = await seedUser(t.db, { email: "Ada@Example.test" });
      await t.db
        .update(users)
        .set({ username: null, displayUsername: null })
        .where(eq(users.id, userId));
      const viewer = await viewerWithSession(t.db, userId, NOW);
      for (const typed of ["", "ada", "bob@example.test"]) {
        expect(
          await errorCode(() =>
            requestDeletion(
              t.db,
              NOW,
              { viewer, typedUsername: typed },
              deps(),
            ),
          ),
          typed,
        ).toBe("wrong_username");
      }
      expect(
        await requestDeletion(
          t.db,
          NOW,
          { viewer, typedUsername: " ada@EXAMPLE.test " },
          deps(),
        ),
      ).toEqual({ confirm: "email" });
    });

    it("an account with a username can't confirm by its email address", async () => {
      const userId = await seedUser(t.db, {
        username: "Ada_Fan",
        email: "ada@example.test",
      });
      const viewer = await viewerWithSession(t.db, userId, NOW);
      expect(
        await errorCode(() =>
          requestDeletion(
            t.db,
            NOW,
            { viewer, typedUsername: "ada@example.test" },
            deps(),
          ),
        ),
      ).toBe("wrong_username");
    });

    it("an impersonated session can't ask", async () => {
      const userId = await seedUser(t.db, { username: "Ada_Fan" });
      const admin = await seedUser(t.db, { role: "admin" });
      const viewer = {
        ...(await viewerWithSession(t.db, userId, NOW)),
        impersonatedBy: admin,
      };
      expect(
        await errorCode(() =>
          requestDeletion(
            t.db,
            NOW,
            { viewer, typedUsername: "Ada_Fan" },
            deps(),
          ),
        ),
      ).toBe("read_only");
    });

    it("an expired or reused link does nothing", async () => {
      const userId = await seedUser(t.db, {
        username: "Ada_Fan",
        email: "ada@example.test",
      });
      const viewer = await viewerWithSession(t.db, userId, NOW);
      await requestDeletion(
        t.db,
        NOW,
        { viewer, typedUsername: "Ada_Fan" },
        { ...deps(), sender: mail.sender },
      );
      expect(mail.last("ada@example.test", "Confirm deleting")).toBeTruthy();
      // The email is sent, so it no longer holds the link; read it from the row first.
      const [request] = await t.db.select().from(privacyRequests);
      expect(request).toMatchObject({
        kind: "delete",
        status: "pending",
        confirmExpiresAt: after(60 * MIN),
      });
      const link = mail.last("ada@example.test", "Confirm deleting")!.text;
      const token = new URL(link.match(/https?:\/\/\S+/)![0]).searchParams.get(
        "token",
      )!;
      expect(request!.confirmTokenHash).not.toContain(token);

      // An hour and a minute later, the link does nothing.
      expect(
        await errorCode(() =>
          confirmDeletion(t.db, after(61 * MIN), { token }),
        ),
      ).toBe("invalid_link");
      expect((await profileRow(t.db, userId)).status).toBe("active");

      // A new request replaces the old link; the new one works once.
      const later = after(2 * 60 * MIN);
      await requestDeletion(
        t.db,
        later,
        { viewer, typedUsername: "Ada_Fan" },
        deps(),
      );
      const fresh = await confirmToken(t.db);
      expect(
        await errorCode(() => confirmDeletion(t.db, later, { token })),
      ).toBe("invalid_link");
      await confirmDeletion(t.db, after(MIN, later), { token: fresh });
      expect((await profileRow(t.db, userId)).status).toBe("deleted");
      expect(
        await errorCode(() =>
          confirmDeletion(t.db, after(2 * MIN, later), { token: fresh }),
        ),
      ).toBe("invalid_link");
      const requests = await t.db
        .select()
        .from(privacyRequests)
        .where(eq(privacyRequests.status, "completed"));
      expect(requests).toHaveLength(1);
      expect(requests[0]!.confirmTokenHash).toBeNull();
    });

    it("the confirmation email expires with its link", async () => {
      const userId = await seedUser(t.db, { username: "Ada_Fan" });
      const viewer = await viewerWithSession(t.db, userId, NOW);
      await requestDeletion(
        t.db,
        NOW,
        { viewer, typedUsername: "Ada_Fan" },
        deps(),
      );
      const [row] = await t.db.select().from(emailOutbox);
      expect(row).toMatchObject({
        template: "delete_confirm",
        status: "queued",
        expiresAt: after(60 * MIN),
      });
      expect((row!.payload as { url: string }).url).toMatch(
        /^http:\/\/localhost:3000\/settings\/delete\/confirm\?token=/,
      );
    });

    it("an account with no verified email needs a recent sign-in", async () => {
      const userId = await seedUser(t.db, {
        username: "Ada_Fan",
        emailVerified: false,
      });
      const stale = await viewerWithSession(t.db, userId, after(-11 * MIN));
      expect(
        await errorCode(() =>
          requestDeletion(
            t.db,
            NOW,
            { viewer: stale, typedUsername: "Ada_Fan" },
            deps(),
          ),
        ),
      ).toBe("sign_in_again");
      expect((await profileRow(t.db, userId)).status).toBe("active");

      const fresh = await viewerWithSession(t.db, userId, after(-9 * MIN));
      expect(
        await requestDeletion(
          t.db,
          NOW,
          { viewer: fresh, typedUsername: "Ada_Fan" },
          deps(),
        ),
      ).toEqual({ confirm: "fresh_sign_in" });
      expect((await profileRow(t.db, userId)).status).toBe("deleted");
      expect(await t.db.select().from(emailOutbox)).toEqual([]);
      expect(await t.db.select().from(privacyRequests)).toMatchObject([
        { kind: "delete", status: "completed", completedAt: NOW },
      ]);
    });

    it("the only admin can't delete themself", async () => {
      const admin = await seedUser(t.db, {
        role: "admin",
        username: "Chief",
        emailVerified: false,
      });
      const viewer = await viewerWithSession(t.db, admin, NOW);
      expect(
        await errorCode(() =>
          requestDeletion(
            t.db,
            NOW,
            { viewer, typedUsername: "Chief" },
            deps(),
          ),
        ),
      ).toBe("last_admin");
      expect(
        await errorCode(() =>
          scrubAccount(t.db, NOW, { userId: admin, actor: self(admin) }),
        ),
      ).toBe("last_admin");
      expect((await profileRow(t.db, admin)).status).toBe("active");
      // A banned or deleted admin doesn't count as another.
      const banned = await seedUser(t.db, { role: "admin" });
      await t.db
        .update(users)
        .set({ banned: true })
        .where(eq(users.id, banned));
      expect(
        await errorCode(() =>
          scrubAccount(t.db, NOW, { userId: admin, actor: self(admin) }),
        ),
      ).toBe("last_admin");

      // With another active admin, it goes, and the role goes with it.
      await seedUser(t.db, { role: "admin" });
      await scrubAccount(t.db, NOW, { userId: admin, actor: self(admin) });
      expect(await userRow(t.db, admin)).toMatchObject({ role: "user" });
    });
  });

  describe("coming back (Review Focus 4)", () => {
    let auth: TestAuth;
    let mail: ReturnType<typeof recordingSender>;
    const EMAIL = "ada@example.test";
    const FROM_IP = { "x-forwarded-for": "203.0.113.20" };
    const byEmail = async (email: string) =>
      (await t.db.select().from(users).where(eq(users.email, email)))[0];

    beforeEach(() => {
      mail = recordingSender();
      auth = testAuth(t.db, {
        sender: mail.sender,
        env: {
          discord: {
            clientId: "fake-discord-client-id",
            clientSecret: "fake-discord-client-secret",
          },
        },
      });
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    const signUpAndDelete = async () => {
      const response = await auth.handler(signUpRequest(EMAIL));
      expect(response.status).toBe(200);
      const user = (await byEmail(EMAIL))!;
      await scrubAccount(t.db, NOW, { userId: user.id, actor: self(user.id) });
      return { userId: user.id, cookie: cookieHeader(response) };
    };

    it("a deleted address can't sign in by password, magic link or reset", async () => {
      const { userId, cookie } = await signUpAndDelete();
      const tombstone = tombstoneEmail(userId);
      // The old session is gone.
      expect(await viewerFor(t.db as never, cookie, () => NOW)).toBeNull();
      for (const email of [EMAIL, tombstone]) {
        const signIn = await auth.handler(
          authPost("/sign-in/email", { email, password: PASSWORD }),
        );
        expect(signIn.status, email).not.toBe(200);
      }
      const link = await auth.handler(
        authPost("/sign-in/magic-link", { email: tombstone }, FROM_IP),
      );
      expect(link.status).toBe(403);
      const reset = await auth.handler(
        authPost("/request-password-reset", { email: tombstone }, FROM_IP),
      );
      expect(reset.status).toBe(403);
      expect(mail.sent.filter((m) => m.to === tombstone)).toEqual([]);
      expect(
        await t.db
          .select()
          .from(authSessions)
          .where(eq(authSessions.userId, userId)),
      ).toEqual([]);
    });

    it("Discord makes a new account, not the tombstone", async () => {
      const fetchStub = vi.fn<typeof fetch>();
      vi.stubGlobal("fetch", fetchStub);
      const discordUser = { id: "1001", email: EMAIL, verified: true };
      const first = await signInWithDiscord(auth, fetchStub, discordUser);
      expect(first.status).toBe(302);
      const old = (await byEmail(EMAIL))!;
      await scrubAccount(t.db, NOW, { userId: old.id, actor: self(old.id) });

      const again = await signInWithDiscord(auth, fetchStub, discordUser);
      expect(again.status).toBe(302);
      const fresh = (await byEmail(EMAIL))!;
      expect(fresh.id).not.toBe(old.id);
      const accounts = await t.db.select().from(authAccounts);
      expect(accounts).toMatchObject([
        { providerId: "discord", accountId: "1001", userId: fresh.id },
      ]);
      expect((await profileRow(t.db, old.id)).status).toBe("deleted");
    });

    it("the old email can sign up again", async () => {
      const { userId } = await signUpAndDelete();
      const response = await auth.handler(signUpRequest(EMAIL));
      expect(response.status).toBe(200);
      const fresh = (await byEmail(EMAIL))!;
      expect(fresh.id).not.toBe(userId);
      expect((await profileRow(t.db, fresh.id)).status).toBe("active");
    });

    it("the username stays held for 90 days", async () => {
      const userId = await seedUser(t.db, { username: "Ada_Fan" });
      const other = await seedUser(t.db);
      await scrubAccount(t.db, NOW, { userId, actor: self(userId) });
      expect(
        await t.db
          .select()
          .from(usernameHistory)
          .where(eq(usernameHistory.userId, userId)),
      ).toMatchObject([{ username: "Ada_Fan", changedAt: NOW }]);

      expect(
        await checkUsername(t.db, after(89 * DAY), "ada_fan", {
          userId: other,
        }),
      ).toBe("held");
      const released = after(91 * DAY);
      await pruneIdentity(t.db, released);
      expect(
        await checkUsername(t.db, released, "ada_fan", { userId: other }),
      ).toBeNull();
    });
  });

  describe("racing a lock (Review Focus 5)", () => {
    it("a team deleted just before a lock isn't locked", async () => {
      const game = await seedOpenGame(t.db);
      const gone = await seedPlayer(t.db, game);
      const kept = await seedPlayer(t.db, game);
      const lockAt = game.round1.lockAt;
      await scrubAccount(t.db, after(-MIN, lockAt), {
        userId: gone.userId,
        actor: self(gone.userId),
      });

      const clock = simulatedClock(lockAt);
      await setSimulatedClock(t.db, lockAt);
      await enqueue(t.db, {
        kind: "game_lock",
        dedupeKey: gameLockKey(game.gameId, game.round1.id),
        runAt: lockAt,
        payload: { gameId: game.gameId, eventId: game.round1.id },
      });
      const result = await runDue(t.db, clock, createGameHandlers(), {
        maxJobs: 10,
        leaseMs: 5 * MIN,
      });
      expect(result.failed).toBe(0);
      const states = await t.db.select().from(teamEventStates);
      expect(states.map((s) => s.teamId)).toEqual([kept.teamId]);
      const [team] = await t.db
        .select()
        .from(teams)
        .where(eq(teams.id, gone.teamId));
      expect(team?.firstEventId).toBeNull();
    });
  });
});
