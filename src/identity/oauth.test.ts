import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../../tests/helpers/test-db";
import {
  cookieHeader,
  signUpRequest,
  TEST_NOW,
  testAuth,
  testAuthEnv,
  type TestAuth,
} from "../../tests/helpers/auth";
import { signInWithDiscord } from "../../tests/helpers/discord";
import { authAccounts, profiles, users } from "@/db/schema";
import { handleAuth } from "@/server/auth-handler";
import { getViewer, type SessionDeps } from "@/server/session";
import { canPost, IdentityError } from "./viewer";

const DISCORD = {
  clientId: "fake-discord-client-id",
  clientSecret: "fake-discord-client-secret",
};

describe("Discord sign-in", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let auth: TestAuth;
  let fetchStub: ReturnType<typeof vi.fn<typeof fetch>>;
  const env = { discord: DISCORD };
  const people = async () =>
    (await t.db.select().from(users)).filter((u) => u.role !== "system");
  const byEmail = async (email: string) =>
    (await t.db.select().from(users).where(eq(users.email, email)))[0];
  const discordAccounts = async () =>
    (await t.db.select().from(authAccounts)).filter(
      (a) => a.providerId === "discord",
    );
  const hasSession = (response: Response) =>
    response.headers.getSetCookie().some((c) => c.includes("session_token"));
  const localAccount = async (email: string, verified: boolean) => {
    await auth.handler(signUpRequest(email));
    await t.db
      .update(users)
      .set({ emailVerified: verified })
      .where(eq(users.email, email));
  };

  beforeEach(async () => {
    t = await createTestDb();
    auth = testAuth(t.db, { env });
    fetchStub = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchStub);
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await t.close();
  });

  it("a new Discord user gets an account and a profile", async () => {
    const response = await signInWithDiscord(auth, fetchStub, {
      id: "1001",
      email: "grid@example.test",
      verified: true,
    });
    expect(response.status).toBe(302);
    expect(hasSession(response)).toBe(true);

    const user = await byEmail("grid@example.test");
    expect(user?.emailVerified).toBe(true);
    const [profile] = await t.db
      .select()
      .from(profiles)
      .where(eq(profiles.userId, user!.id));
    expect(profile?.status).toBe("active");
    expect(await discordAccounts()).toMatchObject([
      { accountId: "1001", userId: user!.id },
    ]);
  });

  it("a verified Discord email links to a verified account, and it's the same user id", async () => {
    await localAccount("ada@example.test", true);
    const before = await byEmail("ada@example.test");

    const response = await signInWithDiscord(auth, fetchStub, {
      id: "1002",
      email: "ada@example.test",
      verified: true,
    });
    expect(hasSession(response)).toBe(true);
    expect(await people()).toHaveLength(1);
    expect(await discordAccounts()).toMatchObject([{ userId: before!.id }]);
  });

  it("an unverified Discord email matching an account can't get in", async () => {
    // The takeover from the M5 plan's finding 1: anyone can set an unverified
    // email on their Discord account. This fails if `discord` is ever added
    // to `trustedProviders`.
    await localAccount("victim@example.test", true);

    const response = await signInWithDiscord(auth, fetchStub, {
      id: "6666",
      email: "victim@example.test",
      verified: false,
    });
    expect(hasSession(response)).toBe(false);
    expect(response.headers.get("location") ?? "").toContain("error=");
    expect(await discordAccounts()).toHaveLength(0);
    expect(await people()).toHaveLength(1);
  });

  it("a verified Discord email can't link to an unverified local account", async () => {
    await localAccount("squat@example.test", false);

    const response = await signInWithDiscord(auth, fetchStub, {
      id: "1003",
      email: "squat@example.test",
      verified: true,
    });
    expect(hasSession(response)).toBe(false);
    expect(response.headers.get("location") ?? "").toContain("error=");
    expect(await discordAccounts()).toHaveLength(0);
    expect(await people()).toHaveLength(1);
  });

  it("a brand-new Discord user with an unverified email has email_verified false", async () => {
    const response = await signInWithDiscord(auth, fetchStub, {
      id: "1004",
      email: "newbie@example.test",
      verified: false,
    });
    expect(hasSession(response)).toBe(true);
    expect((await byEmail("newbie@example.test"))?.emailVerified).toBe(false);

    const deps: SessionDeps = {
      withDb: (fn) => fn(t.db),
      env: () => testAuthEnv({ discord: DISCORD }),
      now: async () => TEST_NOW,
    };
    const viewer = await getViewer(
      new Request("http://localhost:3000/", {
        headers: { cookie: cookieHeader(response) },
      }),
      deps,
    );
    expect(viewer?.emailVerified).toBe(false);
    expect(() => canPost(viewer)).toThrow(IdentityError);
  });

  it("a Discord user who signs in again gets the same user", async () => {
    const profile = { id: "1005", email: "again@example.test", verified: true };
    await signInWithDiscord(auth, fetchStub, profile);
    const first = await byEmail("again@example.test");

    const response = await signInWithDiscord(auth, fetchStub, profile);
    expect(hasSession(response)).toBe(true);
    expect(await people()).toHaveLength(1);
    expect(await discordAccounts()).toHaveLength(1);
    expect((await discordAccounts())[0]?.userId).toBe(first!.id);
  });

  it("Discord's callback redirect is private, no-store", async () => {
    const deps: SessionDeps = {
      withDb: (fn) => fn(t.db),
      env: () => testAuthEnv({ discord: DISCORD }),
      now: async () => TEST_NOW,
    };
    const route = { handler: (request: Request) => handleAuth(request, deps) };
    const response = await signInWithDiscord(route, fetchStub, {
      id: "1006",
      email: "cache@example.test",
      verified: true,
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("Discord is off unless both variables are set", async () => {
    const off = testAuth(t.db, {
      env: { discord: null },
    });
    const response = await off.handler(
      new Request("http://localhost:3000/api/auth/sign-in/social", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:3000",
        },
        body: JSON.stringify({ provider: "discord", callbackURL: "/" }),
      }),
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});
