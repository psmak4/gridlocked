import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../../tests/helpers/test-db";
import {
  cookieHeader,
  signUpRequest,
  TEST_NOW,
  testAuth,
  testAuthEnv,
} from "../../tests/helpers/auth";
import { signInWithDiscord } from "../../tests/helpers/discord";
import { seedUser } from "../../tests/helpers/users";
import {
  auditLog,
  authAccounts,
  authSessions,
  legalAcceptances,
  legalDocuments,
  privacyRequests,
  profiles,
  users,
} from "@/db/schema";
import { writeAudit } from "@/audit/log";
import { newId } from "@/lib/ids";
import { getViewer, type SessionDeps } from "@/server/session";
import {
  acceptDocuments,
  completeSignUp,
  currentDocuments,
  pendingDocuments,
  purgeIncompleteAccounts,
} from "./consent";
import { IdentityError, requireComplete } from "./viewer";

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(TEST_NOW.getTime() - n * DAY);

describe("consent (DM 6.2, 6.8)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await t.close();
  });

  const userByEmail = async (email: string) =>
    (await t.db.select().from(users).where(eq(users.email, email)))[0]!;
  const profileOf = async (userId: string) =>
    (await t.db.select().from(profiles).where(eq(profiles.userId, userId)))[0]!;
  const acceptedKinds = async (userId: string) =>
    (
      await t.db
        .select({ kind: legalDocuments.kind })
        .from(legalAcceptances)
        .innerJoin(
          legalDocuments,
          eq(legalDocuments.id, legalAcceptances.documentId),
        )
        .where(eq(legalAcceptances.userId, userId))
    )
      .map((r) => r.kind)
      .sort();
  const publish = (
    version: string,
    requiresReacceptance: boolean,
    at = TEST_NOW,
  ) =>
    t.db.insert(legalDocuments).values({
      id: newId(),
      kind: "terms",
      version,
      publishedAt: at,
      requiresReacceptance,
      url: "/legal/terms",
    });

  it("the migration seeds draft-1 of all three documents", async () => {
    const docs = await currentDocuments(t.db);
    expect(docs.map((d) => [d.kind, d.version, d.url])).toEqual([
      ["community_rules", "draft-1", "/legal/community_rules"],
      ["privacy", "draft-1", "/legal/privacy"],
      ["terms", "draft-1", "/legal/terms"],
    ]);
  });

  it("sign-up with the email form records the age and all three documents", async () => {
    const response = await testAuth(t.db).handler(
      signUpRequest("ada@example.test", { username: "grid_fan" }),
    );
    expect(response.status).toBe(200);
    const user = await userByEmail("ada@example.test");
    const profile = await profileOf(user.id);
    expect(profile.ageConfirmedAt).toEqual(TEST_NOW);
    expect(await acceptedKinds(user.id)).toEqual([
      "community_rules",
      "privacy",
      "terms",
    ]);
    expect(await pendingDocuments(t.db, user.id)).toEqual([]);
  });

  it.each([
    ["without the age box", { ageConfirmed: false }],
    ["without the terms box", { accepted: false }],
    ["with the boxes as strings", { ageConfirmed: "true", accepted: "true" }],
    ["with neither", { ageConfirmed: undefined, accepted: undefined }],
  ])("the email form is refused %s", async (_name, over) => {
    const response = await testAuth(t.db).handler(
      signUpRequest("ada@example.test", over),
    );
    expect(response.status).toBe(400);
    expect(
      await t.db
        .select()
        .from(users)
        .where(eq(users.email, "ada@example.test")),
    ).toEqual([]);
  });

  describe("a Discord user", () => {
    let deps: SessionDeps;
    beforeEach(() => {
      deps = {
        withDb: (fn) => fn(t.db),
        env: () =>
          testAuthEnv({ discord: { clientId: "id", clientSecret: "s" } }),
        now: async () => TEST_NOW,
      };
    });

    it("starts incomplete, and requireComplete refuses them", async () => {
      const fetchStub = vi.fn<typeof fetch>();
      vi.stubGlobal("fetch", fetchStub);
      const auth = testAuth(t.db, {
        env: { discord: { clientId: "id", clientSecret: "s" } },
      });
      const response = await signInWithDiscord(auth, fetchStub, {
        id: "1001",
        email: "grid@example.test",
        verified: true,
      });
      const viewer = await getViewer(
        new Request("http://localhost:3000/", {
          headers: { cookie: cookieHeader(response) },
        }),
        deps,
      );
      expect(viewer).not.toBeNull();
      expect(viewer!.complete).toBe(false);
      expect(viewer!.profile.ageConfirmedAt).toBeNull();
      expect(() => requireComplete(viewer)).toThrow(IdentityError);
      expect(await acceptedKinds(viewer!.userId)).toEqual([]);

      await completeSignUp(t.db, TEST_NOW, {
        userId: viewer!.userId,
        ageConfirmed: true,
        accepted: true,
        username: "Grid_Fan",
      });
      const done = await getViewer(
        new Request("http://localhost:3000/", {
          headers: { cookie: cookieHeader(response) },
        }),
        deps,
      );
      expect(done!.complete).toBe(true);
      expect(done!.displayUsername).toBe("Grid_Fan");
      expect(() => requireComplete(done)).not.toThrow();
    });
  });

  it("completeSignUp finishes the account", async () => {
    const userId = await seedUser(t.db, { username: "placeholder" });
    await t.db
      .update(users)
      .set({ username: null, displayUsername: null })
      .where(eq(users.id, userId));
    await completeSignUp(t.db, TEST_NOW, {
      userId,
      ageConfirmed: true,
      accepted: true,
      username: "Fresh_Name",
    });
    const [user] = await t.db.select().from(users).where(eq(users.id, userId));
    expect(user).toMatchObject({
      username: "fresh_name",
      displayUsername: "Fresh_Name",
    });
    expect((await profileOf(userId)).ageConfirmedAt).toEqual(TEST_NOW);
    expect(await acceptedKinds(userId)).toHaveLength(3);
    // Again changes nothing.
    await completeSignUp(t.db, new Date(TEST_NOW.getTime() + DAY), {
      userId,
      ageConfirmed: true,
      accepted: true,
    });
    expect((await profileOf(userId)).ageConfirmedAt).toEqual(TEST_NOW);
  });

  it("completeSignUp refuses a bad username and records nothing", async () => {
    const userId = await seedUser(t.db);
    await t.db
      .update(users)
      .set({ username: null, displayUsername: null })
      .where(eq(users.id, userId));
    await expect(
      completeSignUp(t.db, TEST_NOW, {
        userId,
        ageConfirmed: true,
        accepted: true,
        username: "admin",
      }),
    ).rejects.toMatchObject({ code: "reserved" });
    expect((await profileOf(userId)).ageConfirmedAt).toBeNull();
    expect(await acceptedKinds(userId)).toEqual([]);
  });

  it("we store that they confirmed, never a birth date", async () => {
    const columns = await t.client.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_name in ('profiles', 'users')`,
    );
    const names = columns.rows.map((r) => r.column_name);
    expect(names).toContain("age_confirmed_at");
    expect(names.filter((n) => /birth|dob/.test(n))).toEqual([]);

    await testAuth(t.db).handler(
      signUpRequest("ada@example.test", { username: "grid_fan" }),
    );
    expect(await t.db.select().from(auditLog)).toEqual([]);
  });

  describe("the gate on a signed-in viewer", () => {
    const deps = (): SessionDeps => ({
      withDb: (fn) => fn(t.db),
      env: () => testAuthEnv(),
      now: async () => TEST_NOW,
    });
    const viewerFor = async (cookie: string) =>
      getViewer(
        new Request("http://localhost:3000/", { headers: { cookie } }),
        deps(),
      );
    const signedUp = async () => {
      const response = await testAuth(t.db).handler(
        signUpRequest("ada@example.test", { username: "grid_fan" }),
      );
      return cookieHeader(response);
    };

    it("a version with requires_reacceptance makes the viewer incomplete until accepted", async () => {
      const cookie = await signedUp();
      const first = await viewerFor(cookie);
      expect(first!.complete).toBe(true);

      await publish("2", true, new Date(TEST_NOW.getTime() + 2 * DAY));
      const after = await viewerFor(cookie);
      expect(after!.complete).toBe(false);
      expect(() => requireComplete(after)).toThrow(IdentityError);

      await acceptDocuments(t.db, TEST_NOW, {
        userId: first!.userId,
        documentIds: (await pendingDocuments(t.db, first!.userId)).map(
          (d) => d.id,
        ),
      });
      expect((await viewerFor(cookie))!.complete).toBe(true);
    });

    it("a version without it leaves the viewer complete", async () => {
      const cookie = await signedUp();
      await publish("2", false, new Date(TEST_NOW.getTime() + 2 * DAY));
      const viewer = await viewerFor(cookie);
      expect(viewer!.complete).toBe(true);
      expect(() => requireComplete(viewer)).not.toThrow();
    });
  });

  it("acceptDocuments refuses an unknown id and an old version", async () => {
    const userId = await seedUser(t.db);
    await expect(
      acceptDocuments(t.db, TEST_NOW, { userId, documentIds: [newId()] }),
    ).rejects.toMatchObject({ code: "invalid_document" });
    const [old] = await t.db
      .select()
      .from(legalDocuments)
      .where(eq(legalDocuments.kind, "terms"));
    await publish("2", true, new Date(TEST_NOW.getTime() + DAY));
    await expect(
      acceptDocuments(t.db, TEST_NOW, { userId, documentIds: [old!.id] }),
    ).rejects.toMatchObject({ code: "invalid_document" });
    expect(await acceptedKinds(userId)).toEqual([]);
  });

  it("completeSignUp turns a lost race for the name into taken", async () => {
    const holder = await seedUser(t.db, { username: "taken_name" });
    expect(holder).toBeDefined();
    const userId = await seedUser(t.db);
    await t.db
      .update(users)
      .set({ username: null, displayUsername: null })
      .where(eq(users.id, userId));
    await expect(
      completeSignUp(
        t.db,
        TEST_NOW,
        { userId, ageConfirmed: true, accepted: true, username: "Taken_Name" },
        { check: async () => null },
      ),
    ).rejects.toMatchObject({ code: "taken" });
    expect((await profileOf(userId)).ageConfirmedAt).toBeNull();
  });

  describe("a new document version", () => {
    it("with requires_reacceptance makes an account incomplete again", async () => {
      const userId = await seedUser(t.db);
      await completeSignUp(t.db, TEST_NOW, {
        userId,
        ageConfirmed: true,
        accepted: true,
      });
      await publish("2", true, new Date(TEST_NOW.getTime() + DAY));
      const pending = await pendingDocuments(t.db, userId);
      expect(pending.map((d) => [d.kind, d.version])).toEqual([["terms", "2"]]);

      await acceptDocuments(t.db, TEST_NOW, {
        userId,
        documentIds: pending.map((d) => d.id),
      });
      expect(await pendingDocuments(t.db, userId)).toEqual([]);
      // Later versions that need nothing don't undo that.
      await publish("3", false, new Date(TEST_NOW.getTime() + 2 * DAY));
      expect(await pendingDocuments(t.db, userId)).toEqual([]);
    });

    it("without it doesn't", async () => {
      const userId = await seedUser(t.db);
      await completeSignUp(t.db, TEST_NOW, {
        userId,
        ageConfirmed: true,
        accepted: true,
      });
      await publish("2", false, new Date(TEST_NOW.getTime() + DAY));
      expect(await pendingDocuments(t.db, userId)).toEqual([]);
    });

    it("someone who never accepted is asked for the latest", async () => {
      const userId = await seedUser(t.db);
      await publish("2", false, new Date(TEST_NOW.getTime() + DAY));
      const pending = await pendingDocuments(t.db, userId);
      expect(pending.map((d) => `${d.kind}:${d.version}`)).toEqual([
        "community_rules:draft-1",
        "privacy:draft-1",
        "terms:2",
      ]);
    });
  });

  describe("purgeIncompleteAccounts", () => {
    const incomplete = async (ageDays: number, email: string) => {
      const id = await seedUser(t.db, { email });
      await t.db
        .update(users)
        .set({ createdAt: daysAgo(ageDays) })
        .where(eq(users.id, id));
      await t.db.insert(authAccounts).values({
        id: newId(),
        accountId: id,
        providerId: "credential",
        userId: id,
      });
      await t.db.insert(authSessions).values({
        id: newId(),
        token: `tok-${id}`,
        userId: id,
        expiresAt: new Date(TEST_NOW.getTime() + DAY),
      });
      return id;
    };
    const exists = async (id: string) =>
      (await t.db.select().from(users).where(eq(users.id, id))).length === 1;

    it("an incomplete account past 7 days is removed", async () => {
      const id = await incomplete(8, "old@example.test");
      expect(await purgeIncompleteAccounts(t.db, TEST_NOW)).toBe(1);
      expect(await exists(id)).toBe(false);
      expect(await t.db.select().from(authSessions)).toEqual([]);
      expect(
        (await t.db.select().from(authAccounts)).filter((a) => a.userId === id),
      ).toEqual([]);
      expect(await profileOf(id)).toBeUndefined();
    });

    it("a day-old one isn't", async () => {
      const id = await incomplete(1, "new@example.test");
      expect(await purgeIncompleteAccounts(t.db, TEST_NOW)).toBe(0);
      expect(await exists(id)).toBe(true);
    });

    it("a finished one isn't", async () => {
      const id = await incomplete(30, "done@example.test");
      await completeSignUp(t.db, TEST_NOW, {
        userId: id,
        ageConfirmed: true,
        accepted: true,
      });
      expect(await purgeIncompleteAccounts(t.db, TEST_NOW)).toBe(0);
      expect(await exists(id)).toBe(true);
    });

    it("one an audit row names is skipped, and the rest still go", async () => {
      const named = await incomplete(30, "named@example.test");
      const other = await incomplete(30, "other@example.test");
      await writeAudit(t.db, daysAgo(20), {
        actorUserId: null,
        actorKind: "admin",
        actorLabel: null,
        action: "user.note",
        entityType: "user",
        entityId: named,
        before: null,
        after: null,
        reason: null,
        requestId: null,
      });
      expect(await purgeIncompleteAccounts(t.db, TEST_NOW)).toBe(1);
      expect(await exists(named)).toBe(true);
      expect(await exists(other)).toBe(false);
    });

    const audit = (over: Record<string, unknown>) =>
      writeAudit(t.db, daysAgo(20), {
        actorUserId: null,
        actorKind: "admin",
        actorLabel: null,
        action: "user.note",
        entityType: "thing",
        entityId: newId(),
        before: null,
        after: null,
        reason: null,
        requestId: null,
        ...over,
      });

    it.each(["actorUserId", "impersonatingUserId"])(
      "one an audit row names as %s is skipped",
      async (column) => {
        const named = await incomplete(30, "named@example.test");
        await audit({ [column]: named });
        expect(await purgeIncompleteAccounts(t.db, TEST_NOW)).toBe(0);
        expect(await exists(named)).toBe(true);
      },
    );

    it("one with a privacy request is skipped and the next still goes", async () => {
      const first = await incomplete(40, "first@example.test");
      const second = await incomplete(30, "second@example.test");
      await t.db.insert(privacyRequests).values({
        id: newId(),
        userId: first,
        kind: "export",
        requestedAt: daysAgo(35),
      });
      expect(await purgeIncompleteAccounts(t.db, TEST_NOW)).toBe(1);
      expect(await exists(first)).toBe(true);
      expect(await exists(second)).toBe(false);
    });

    it("a foreign key the SQL doesn't exclude skips that account only", async () => {
      await t.client.exec(
        "create table probe (user_id uuid references users(id))",
      );
      const first = await incomplete(40, "first@example.test");
      const second = await incomplete(30, "second@example.test");
      await t.client.query("insert into probe values ($1)", [first]);
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(await purgeIncompleteAccounts(t.db, TEST_NOW)).toBe(1);
      expect(await exists(first)).toBe(true);
      expect(await exists(second)).toBe(false);
      expect(JSON.stringify(log.mock.calls)).not.toContain("first@example");
      log.mockRestore();
    });

    it("an account with no profile row is purged too", async () => {
      const id = await incomplete(30, "bare@example.test");
      await t.db.delete(profiles).where(eq(profiles.userId, id));
      expect(await purgeIncompleteAccounts(t.db, TEST_NOW)).toBe(1);
      expect(await exists(id)).toBe(false);
    });

    it("one that finishes after the candidates are read is kept", async () => {
      const id = await incomplete(30, "racer@example.test");
      const racing = new Proxy(t.db, {
        get(target, prop, receiver) {
          if (prop === "transaction") {
            return async (...args: unknown[]) => {
              await completeSignUp(target, TEST_NOW, {
                userId: id,
                ageConfirmed: true,
                accepted: true,
              });
              return (target.transaction as (...a: unknown[]) => unknown)(
                ...args,
              );
            };
          }
          return Reflect.get(target, prop, receiver) as unknown;
        },
      });
      expect(await purgeIncompleteAccounts(racing, TEST_NOW)).toBe(0);
      expect(await exists(id)).toBe(true);
      expect(await acceptedKinds(id)).toHaveLength(3);
    });

    it("a purge is audited in the same step", async () => {
      const id = await incomplete(30, "gone@example.test");
      await purgeIncompleteAccounts(t.db, TEST_NOW);
      const rows = await t.db.select().from(auditLog);
      expect(rows.map((r) => [r.action, r.entityId])).toEqual([
        ["user.purge_incomplete", id],
      ]);
    });

    it("the system user is never removed", async () => {
      await purgeIncompleteAccounts(t.db, new Date("2100-01-01T00:00:00Z"));
      const system = await t.db
        .select()
        .from(users)
        .where(eq(users.role, "system"));
      expect(system).toHaveLength(1);
    });
  });
});
