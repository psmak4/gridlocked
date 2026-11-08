import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import { seedUser } from "../../tests/helpers/users";
import { SYSTEM_USER_ID } from "@/identity/system";
import { newId } from "@/lib/ids";
import { seedLeagueGames } from "../../tests/helpers/leagues-game";
import {
  auditLog,
  authAccounts,
  emailOutbox,
  filterRules,
  gameSessionExceptions,
  leagues,
  profiles,
  resultOverrides,
  reviewItems,
  sessions,
  settings,
  teams,
  users,
} from "./schema";

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

const AT = new Date("2026-02-01T00:00:00Z");
const RESTRICT_VIOLATION = "23001";
const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";
const FOREIGN_KEY_VIOLATION = "23503";

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

describe("identity tables", () => {
  let t: TestDb;

  beforeEach(async () => {
    t = await createTestDb();
  });

  afterEach(async () => {
    await t.close();
  });

  it("the system user exists with role system and no sign-in accounts", async () => {
    const [user] = await t.db
      .select()
      .from(users)
      .where(eq(users.id, SYSTEM_USER_ID));
    expect(user).toMatchObject({
      role: "system",
      email: "system@gridlocked.invalid",
      name: "system",
    });
    const accounts = await t.db
      .select()
      .from(authAccounts)
      .where(eq(authAccounts.userId, SYSTEM_USER_ID));
    expect(accounts).toEqual([]);
    const [profile] = await t.db
      .select()
      .from(profiles)
      .where(eq(profiles.userId, SYSTEM_USER_ID));
    expect(profile?.status).toBe("active");
  });

  it("an auth account for the system user is refused", async () => {
    await expectPgError(
      t.db.insert(authAccounts).values({
        id: newId(),
        accountId: SYSTEM_USER_ID,
        providerId: "credential",
        userId: SYSTEM_USER_ID,
        createdAt: AT,
        updatedAt: AT,
      }),
      RESTRICT_VIOLATION,
    );
  });

  it("an auth account for an ordinary user is accepted", async () => {
    const userId = await seedUser(t.db);
    await t.db.insert(authAccounts).values({
      id: newId(),
      accountId: userId,
      providerId: "credential",
      userId,
      createdAt: AT,
      updatedAt: AT,
    });
  });

  it("usernames are unique whatever their case", async () => {
    // Inserted as written: seedUser lowercases, which would let Better Auth's
    // plain unique constraint answer instead of the lower(username) index.
    const row = (email: string, username: string) => ({
      id: newId(),
      name: username,
      email,
      username,
    });
    await t.db.insert(users).values(row("a@example.test", "Senna"));
    const error = await t.db
      .insert(users)
      .values(row("b@example.test", "senna"))
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(error, "expected the statement to be rejected").toBeDefined();
    const cause = (error as { cause?: { code?: string; constraint?: string } })
      .cause;
    expect(cause?.code).toBe(UNIQUE_VIOLATION);
    expect(cause?.constraint).toBe("users_username_lower_idx");
  });

  it("trust_level outside 0 to 3 is refused", async () => {
    const userId = await seedUser(t.db);
    await expectPgError(
      t.db
        .update(profiles)
        .set({ trustLevel: 4 })
        .where(eq(profiles.userId, userId)),
      CHECK_VIOLATION,
    );
    await expectPgError(
      t.db
        .update(profiles)
        .set({ trustLevel: -1 })
        .where(eq(profiles.userId, userId)),
      CHECK_VIOLATION,
    );
    await t.db
      .update(profiles)
      .set({ trustLevel: 3 })
      .where(eq(profiles.userId, userId));
  });

  it("a filter rule's scope, match type and effect are checked", async () => {
    const base = {
      pattern: "x",
      matchType: "word",
      effect: "block",
      scope: "usernames",
      createdBy: SYSTEM_USER_ID,
      createdAt: AT,
      updatedAt: AT,
    } as const;
    const insert = (over: Record<string, string>) =>
      t.db
        .insert(filterRules)
        .values({ id: newId(), ...base, ...over } as never);
    await insert({});
    await expectPgError(insert({ scope: "everywhere" }), CHECK_VIOLATION);
    await expectPgError(insert({ matchType: "glob" }), CHECK_VIOLATION);
    await expectPgError(insert({ effect: "delete" }), CHECK_VIOLATION);
  });

  it("seeds the reserved usernames as word and regex rules by the system user", async () => {
    const rows = await t.db
      .select()
      .from(filterRules)
      .where(eq(filterRules.scope, "usernames"));
    const words = rows
      .filter((r) => r.matchType === "word")
      .map((r) => r.pattern);
    expect(words.sort()).toEqual(
      ["admin", "gridlocked", "moderator", "support", "system"].sort(),
    );
    expect(
      rows.every(
        (r) =>
          r.effect === "block" && r.createdBy === SYSTEM_USER_ID && r.active,
      ),
    ).toBe(true);
    const regexes = rows
      .filter((r) => r.matchType === "regex")
      .map((r) => new RegExp(r.pattern, "i"));
    expect(regexes).toHaveLength(5);
    for (const name of [
      "F1_Official",
      "Formula1Fan",
      "formula_1",
      "FIA",
      "TheOfficial",
    ]) {
      expect(
        regexes.some((re) => re.test(name)),
        name,
      ).toBe(true);
    }
    for (const name of ["mf1", "fiat", "senna"]) {
      expect(
        regexes.some((re) => re.test(name)),
        name,
      ).toBe(false);
    }
  });

  it("email_outbox allows one queued row per address and template", async () => {
    const row = (over: Record<string, unknown> = {}) => ({
      id: newId(),
      toEmail: "Fan@Example.test",
      template: "verify_email",
      status: "queued",
      sendAfter: AT,
      createdAt: AT,
      ...over,
    });
    await t.db.insert(emailOutbox).values(row() as never);
    // Same address in another case, same template, still queued.
    await expectPgError(
      t.db
        .insert(emailOutbox)
        .values(row({ toEmail: "fan@example.test" }) as never),
      UNIQUE_VIOLATION,
    );
    // Another template, or a row that is no longer queued, is fine.
    await t.db
      .insert(emailOutbox)
      .values(row({ template: "magic_link" }) as never);
    await t.db.insert(emailOutbox).values(row({ status: "sent" }) as never);
  });

  it("a queued email needs an address, and other rows may have none", async () => {
    const row = (over: Record<string, unknown>) =>
      ({
        id: newId(),
        template: "delete_confirm",
        sendAfter: AT,
        createdAt: AT,
        ...over,
      }) as never;
    await expectPgError(
      t.db.insert(emailOutbox).values(row({ status: "queued", toEmail: null })),
      CHECK_VIOLATION,
    );
    await t.db
      .insert(emailOutbox)
      .values(row({ status: "expired", toEmail: null }));
  });
});

describe("user columns point at users", () => {
  let t: TestDb;
  let gameId: string;
  let sessionId: string;
  let driverId: string;

  beforeEach(async () => {
    t = await createTestDb();
    const seeded = await seedLeagueGames(t.db, AT);
    gameId = seeded.gameId;
    driverId = seeded.driverIds[0]!;
    const [session] = await t.db.select().from(sessions).limit(1);
    sessionId = session!.id;
  });

  afterEach(async () => {
    await t.close();
  });

  const team = (userId: string) => ({
    id: newId(),
    gameId,
    userId,
    slot: 1,
    name: "Team",
    status: "active" as const,
  });

  it("a team needs a real user", async () => {
    await expectPgError(
      t.db.insert(teams).values(team(newId())),
      FOREIGN_KEY_VIOLATION,
    );
    const userId = await seedUser(t.db);
    await t.db.insert(teams).values(team(userId));
    expect(await t.db.select().from(teams)).toHaveLength(1);
  });

  it("a user with a team can't be deleted", async () => {
    const userId = await seedUser(t.db);
    await t.db.insert(teams).values(team(userId));
    await t.db.delete(profiles).where(eq(profiles.userId, userId));
    await expectPgError(
      t.db.delete(users).where(eq(users.id, userId)),
      RESTRICT_VIOLATION,
    );
  });

  const columns: Array<{
    column: string;
    write: (userId: string) => Promise<unknown>;
  }> = [
    {
      column: "leagues.owner_user_id",
      write: (userId) =>
        t.db.insert(leagues).values({
          id: newId(),
          gameId,
          kind: "public",
          name: "League",
          slug: "league",
          ownerUserId: userId,
          joinCode: "ABCD2345",
          status: "active",
          createdAt: AT,
          updatedAt: AT,
        }),
    },
    {
      column: "game_session_exceptions.decided_by",
      write: (userId) =>
        t.db.insert(gameSessionExceptions).values({
          gameId,
          sessionId,
          policy: "skip",
          reason: "abandoned",
          decidedBy: userId,
          decidedAt: AT,
          createdAt: AT,
          updatedAt: AT,
        }),
    },
    {
      column: "result_overrides.created_by",
      write: (userId) =>
        t.db.insert(resultOverrides).values({
          id: newId(),
          sessionId,
          driverId,
          kind: "suppress",
          reason: "stewards decision",
          createdBy: userId,
          createdAt: AT,
        }),
    },
    {
      column: "result_overrides.revoked_by",
      write: (userId) =>
        t.db.insert(resultOverrides).values({
          id: newId(),
          sessionId,
          driverId,
          kind: "suppress",
          reason: "stewards decision",
          createdBy: SYSTEM_USER_ID,
          createdAt: AT,
          revokedAt: AT,
          revokedBy: userId,
        }),
    },
    {
      column: "review_items.resolved_by",
      write: (userId) =>
        t.db.insert(reviewItems).values({
          id: newId(),
          kind: "validation_failed",
          severity: "warning",
          details: {},
          status: "resolved",
          resolvedBy: userId,
          resolvedAt: AT,
          dedupeKey: "k",
          createdAt: AT,
        }),
    },
    {
      column: "audit_log.actor_user_id",
      write: (userId) =>
        t.db.insert(auditLog).values({
          id: newId(),
          actorUserId: userId,
          actorKind: "user",
          action: "x.y",
          entityType: "x",
          entityId: newId(),
          createdAt: AT,
        }),
    },
    {
      column: "audit_log.impersonating_user_id",
      write: (userId) =>
        t.db.insert(auditLog).values({
          id: newId(),
          impersonatingUserId: userId,
          actorKind: "admin",
          action: "x.y",
          entityType: "x",
          entityId: newId(),
          createdAt: AT,
        }),
    },
    {
      column: "settings.updated_by",
      write: (userId) =>
        t.db.insert(settings).values({ key: "k", value: 1, updatedBy: userId }),
    },
  ];

  it.each(columns)("$column refuses an unknown user", async ({ write }) => {
    await expectPgError(write(newId()), FOREIGN_KEY_VIOLATION);
  });

  it.each(columns)("$column accepts a real user", async ({ write }) => {
    await write(await seedUser(t.db));
  });

  it("the override written with the system user id is accepted", async () => {
    await t.db.insert(resultOverrides).values({
      id: newId(),
      sessionId,
      driverId,
      kind: "suppress",
      reason: "stewards decision",
      createdBy: SYSTEM_USER_ID,
      createdAt: AT,
    });
    expect(await t.db.select().from(resultOverrides)).toHaveLength(1);
  });
});
