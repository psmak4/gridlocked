/**
 * Before sign-up opens beyond the owner (M9 Task 1, carried from M5): a
 * half-made sign-up can't be inherited, a document published in the future
 * isn't asked for yet, and the invite list can name Discord accounts.
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../../tests/helpers/test-db";
import {
  authPost,
  clickLink,
  cookieHeader,
  linkIn,
  PASSWORD,
  recordingSender,
  signUpRequest,
  TEST_NOW,
  testAuth,
  type TestAuth,
} from "../../tests/helpers/auth";
import { signInWithDiscord } from "../../tests/helpers/discord";
import {
  auditLog,
  authAccounts,
  authSessions,
  legalAcceptances,
  legalDocuments,
  profiles,
  users,
} from "@/db/schema";
import { newId } from "@/lib/ids";
import { pendingDocuments } from "./consent";

const EMAIL = "ada@example.test";

describe("confirming an address", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let auth: TestAuth;
  let mail: ReturnType<typeof recordingSender>;

  const account = async () => {
    const [user] = await t.db
      .select()
      .from(users)
      .where(eq(users.email, EMAIL));
    const [profile] = await t.db
      .select()
      .from(profiles)
      .where(eq(profiles.userId, user!.id));
    const credential = await t.db
      .select()
      .from(authAccounts)
      .where(
        and(
          eq(authAccounts.userId, user!.id),
          eq(authAccounts.providerId, "credential"),
        ),
      );
    const accepted = await t.db
      .select()
      .from(legalAcceptances)
      .where(eq(legalAcceptances.userId, user!.id));
    const sessions = await t.db
      .select()
      .from(authSessions)
      .where(eq(authSessions.userId, user!.id));
    return { user: user!, profile: profile!, credential, accepted, sessions };
  };

  beforeEach(async () => {
    t = await createTestDb();
    mail = recordingSender();
    auth = testAuth(t.db, { sender: mail.sender });
  });
  afterEach(async () => {
    await t.close();
  });

  it("from a browser not signed in to it deletes the sign-up password, the age and terms record and the other sessions, and sends the person to finish signing up", async () => {
    const signUp = await auth.handler(
      signUpRequest(EMAIL, { username: "squatter" }),
    );
    expect(signUp.status).toBe(200);
    const made = await account();
    expect(made.credential).toHaveLength(1);
    expect(made.profile.ageConfirmedAt).not.toBeNull();
    expect(made.accepted.length).toBeGreaterThan(0);
    const firstSessions = made.sessions.map((s) => s.id);

    // The address's owner clicks the link in their own browser: no cookie.
    const response = await auth.handler(
      clickLink(linkIn(mail.last(EMAIL, "Confirm your email"))),
    );
    expect(response.status).toBeLessThan(400);

    const after = await account();
    expect(after.user.emailVerified).toBe(true);
    expect(after.credential).toHaveLength(0);
    expect(after.profile.ageConfirmedAt).toBeNull();
    expect(after.accepted).toHaveLength(0);
    expect(after.user.username).toBeNull();
    // Only the session the confirmation made is left.
    expect(after.sessions).toHaveLength(1);
    expect(firstSessions).not.toContain(after.sessions[0]!.id);
    // The password the first browser chose no longer signs in.
    const signIn = await auth.handler(
      authPost("/sign-in/email", { email: EMAIL, password: PASSWORD }),
    );
    expect(signIn.status).toBeGreaterThanOrEqual(400);
    // Audited, with no address in it.
    const rows = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "user.sign_up.reset"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entityId).toBe(after.user.id);
    expect(JSON.stringify(rows[0])).not.toContain(EMAIL);
  });

  it("from the browser that signed up keeps everything", async () => {
    const signUp = await auth.handler(
      signUpRequest(EMAIL, { username: "ada_fan" }),
    );
    const response = await auth.handler(
      clickLink(
        linkIn(mail.last(EMAIL, "Confirm your email")),
        cookieHeader(signUp),
      ),
    );
    expect(response.status).toBeLessThan(400);

    const after = await account();
    expect(after.user.emailVerified).toBe(true);
    expect(after.credential).toHaveLength(1);
    expect(after.profile.ageConfirmedAt).not.toBeNull();
    expect(after.accepted.length).toBeGreaterThan(0);
    expect(after.user.username).toBe("ada_fan");
    const rows = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "user.sign_up.reset"));
    expect(rows).toHaveLength(0);
  });

  it("from a browser signed in to another account resets the half-made sign-up, and that browser stays signed in as before", async () => {
    await auth.handler(signUpRequest(EMAIL, { username: "squatter" }));
    const other = await auth.handler(
      signUpRequest("bob@example.test", { username: "bob_fan" }),
    );
    const [bob] = await t.db
      .select()
      .from(users)
      .where(eq(users.email, "bob@example.test"));
    const bobSessions = async () =>
      (
        await t.db
          .select()
          .from(authSessions)
          .where(eq(authSessions.userId, bob!.id))
      ).map((s) => s.id);
    const before = await bobSessions();

    const response = await auth.handler(
      clickLink(
        linkIn(mail.last(EMAIL, "Confirm your email")),
        cookieHeader(other),
      ),
    );
    expect(response.status).toBeLessThan(400);
    const after = await account();
    expect(after.user.emailVerified).toBe(true);
    expect(after.credential).toHaveLength(0);
    expect(after.user.username).toBeNull();
    expect(await bobSessions()).toEqual(before);
  });

  it("by a magic link from another browser resets the half-made sign-up too", async () => {
    await auth.handler(signUpRequest(EMAIL, { username: "squatter" }));
    const ask = await auth.handler(
      authPost(
        "/sign-in/magic-link",
        { email: EMAIL },
        { "x-forwarded-for": "203.0.113.20" },
      ),
    );
    expect(ask.status).toBe(200);
    const response = await auth.handler(
      clickLink(linkIn(mail.last(EMAIL, "sign-in link"))),
    );
    expect(response.status).toBeLessThan(400);

    const after = await account();
    expect(after.user.emailVerified).toBe(true);
    expect(after.credential).toHaveLength(0);
    expect(after.profile.ageConfirmedAt).toBeNull();
    expect(after.accepted).toHaveLength(0);
    expect(after.user.username).toBeNull();
    const rows = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "user.sign_up.reset"));
    expect(rows).toHaveLength(1);
  });

  it("by a forged link changes nothing", async () => {
    await auth.handler(signUpRequest(EMAIL, { username: "squatter" }));
    const forged = new URL(linkIn(mail.last(EMAIL, "Confirm your email")));
    forged.searchParams.set("token", "not-a-real-token");
    await auth.handler(clickLink(forged.toString()));
    const after = await account();
    expect(after.user.emailVerified).toBe(false);
    expect(after.credential).toHaveLength(1);
    expect(after.user.username).toBe("squatter");
  });
});

describe("pendingDocuments", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let auth: TestAuth;

  beforeEach(async () => {
    t = await createTestDb();
    auth = testAuth(t.db);
  });
  afterEach(async () => {
    await t.close();
  });

  it("leaves out a document published in the future", async () => {
    await auth.handler(signUpRequest(EMAIL, { username: "ada_fan" }));
    const [user] = await t.db
      .select()
      .from(users)
      .where(eq(users.email, EMAIL));
    expect(await pendingDocuments(t.db, TEST_NOW, user!.id)).toEqual([]);

    await t.db.insert(legalDocuments).values({
      id: newId(),
      kind: "terms",
      version: "lawyer-1",
      publishedAt: new Date(TEST_NOW.getTime() + 86_400_000),
      requiresReacceptance: true,
      url: "/legal/terms",
    });
    expect(await pendingDocuments(t.db, TEST_NOW, user!.id)).toEqual([]);
    const tomorrow = new Date(TEST_NOW.getTime() + 2 * 86_400_000);
    expect(
      (await pendingDocuments(t.db, tomorrow, user!.id)).map((d) => d.version),
    ).toEqual(["lawyer-1"]);
  });
});

describe("the invite list and Discord", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let auth: TestAuth;
  let fetchStub: ReturnType<typeof vi.fn<typeof fetch>>;
  const DISCORD = {
    clientId: "fake-discord-client-id",
    clientSecret: "fake-discord-client-secret",
  };
  const people = async () =>
    (await t.db.select().from(users)).filter((u) => u.role !== "system");
  const hasSession = (response: Response) =>
    response.headers.getSetCookie().some((c) => c.includes("session_token"));

  beforeEach(async () => {
    t = await createTestDb();
    auth = testAuth(t.db, {
      env: {
        discord: DISCORD,
        signUpAllowlist: ["owner@example.test", "discord:2001"],
      },
    });
    fetchStub = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchStub);
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await t.close();
  });

  it("a Discord account on the list can sign up", async () => {
    const response = await signInWithDiscord(auth, fetchStub, {
      id: "2001",
      email: "tester@example.test",
      verified: true,
    });
    expect(hasSession(response)).toBe(true);
    expect(await people()).toHaveLength(1);
  });

  it("a Discord account not on the list is refused, and nothing is left behind", async () => {
    const response = await signInWithDiscord(auth, fetchStub, {
      id: "2002",
      email: "stranger@example.test",
      verified: true,
    });
    expect(hasSession(response)).toBe(false);
    expect(await people()).toHaveLength(0);
    expect(await t.db.select().from(authAccounts)).toHaveLength(0);
  });

  it("a Discord account whose email is on the list can sign up", async () => {
    const response = await signInWithDiscord(auth, fetchStub, {
      id: "2003",
      email: "owner@example.test",
      verified: true,
    });
    expect(hasSession(response)).toBe(true);
  });

  it("an email sign-up can't use a Discord entry as an address", async () => {
    const response = await auth.handler(signUpRequest("discord:2001"));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await people()).toHaveLength(0);
  });
});
