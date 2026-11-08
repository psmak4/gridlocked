import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../tests/helpers/test-db";
import {
  authPost,
  cookieHeader,
  PASSWORD,
  signUpRequest,
  testAuth,
  type TestAuth,
} from "../../tests/helpers/auth";
import { authRateLimits, authSessions, profiles, users } from "@/db/schema";

const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("Better Auth on the real tables", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let auth: TestAuth;
  // The migrations make the reserved system user; the tests count the rest.
  const people = async () =>
    (await t.db.select().from(users)).filter((u) => u.role !== "system");

  beforeEach(async () => {
    t = await createTestDb();
    auth = testAuth(t.db);
  });
  afterEach(async () => {
    await t.close();
  });

  it("sign-up writes a uuidv7 user and a profile", async () => {
    const response = await auth.handler(signUpRequest("ada@example.test"));
    expect(response.status).toBe(200);

    const [user] = await t.db
      .select()
      .from(users)
      .where(eq(users.email, "ada@example.test"));
    expect(user?.id).toMatch(UUID_V7);
    expect(user?.role).toBe("user");
    const [profile] = await t.db
      .select()
      .from(profiles)
      .where(eq(profiles.userId, user!.id));
    expect(profile?.status).toBe("active");
    expect(profile?.avatarSeed).toBeTruthy();
    // The profile's times come from the caller's `now`.
    expect(profile?.createdAt.toISOString()).toBe("2026-11-07T12:00:00.000Z");
  });

  it("the session cookie is Secure, HttpOnly and SameSite=Lax", async () => {
    const response = await auth.handler(signUpRequest("ada@example.test"));
    const cookies = response.headers.getSetCookie();
    const session = cookies.find((c) => c.includes("session_token"));
    expect(session).toBeDefined();
    expect(session).toMatch(/^__Secure-/);
    expect(session).toMatch(/;\s*Secure/i);
    expect(session).toMatch(/;\s*HttpOnly/i);
    expect(session).toMatch(/;\s*SameSite=Lax/i);
  });

  it("a password under 10 characters is refused", async () => {
    const response = await auth.handler(
      signUpRequest("ada@example.test", { password: "123456789" }),
    );
    expect(response.status).toBe(400);
    expect(await people()).toHaveLength(0);
  });

  it("sign-in with the right password works, and with the wrong one doesn't", async () => {
    await auth.handler(signUpRequest("ada@example.test"));

    const good = await auth.handler(
      authPost("/sign-in/email", {
        email: "ada@example.test",
        password: PASSWORD,
      }),
    );
    expect(good.status).toBe(200);
    expect(good.headers.getSetCookie().join()).toContain("session_token");

    const bad = await auth.handler(
      authPost("/sign-in/email", {
        email: "ada@example.test",
        password: "not the password",
      }),
    );
    expect(bad.status).toBe(401);
    expect(bad.headers.getSetCookie()).toHaveLength(0);
  });

  it("the built-in delete-user path is 404", async () => {
    for (const path of ["/delete-user", "/delete-user/callback"]) {
      const response = await auth.handler(authPost(path, {}));
      expect(response.status).toBe(404);
    }
  });

  it("an admin path other than impersonation is 404 over HTTP", async () => {
    for (const path of [
      "/admin/set-role",
      "/admin/ban-user",
      "/admin/create-user",
      "/admin/remove-user",
      "/admin/set-user-password",
    ]) {
      const response = await auth.handler(authPost(path, {}));
      expect(response.status, path).toBe(404);
    }
    // The two impersonation paths stay routed: they refuse (no admin session)
    // rather than answering 404.
    for (const path of [
      "/admin/impersonate-user",
      "/admin/stop-impersonating",
    ]) {
      const response = await auth.handler(authPost(path, {}));
      expect(response.status, path).not.toBe(404);
    }
  });

  it("an address outside the allowlist can't sign up", async () => {
    const closed = testAuth(t.db, {
      env: { signUpAllowlist: ["friend@example.test"] },
    });
    const refused = await closed.handler(
      signUpRequest("stranger@example.test"),
    );
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(await people()).toHaveLength(0);

    const allowed = await closed.handler(signUpRequest("Friend@Example.test"));
    expect(allowed.status).toBe(200);
    expect(await people()).toHaveLength(1);
  });

  it("a .invalid address can't sign up", async () => {
    const response = await auth.handler(signUpRequest("ghost@example.invalid"));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await people()).toHaveLength(0);
  });

  it("repeated bad sign-ins hit the database-backed rate limit", async () => {
    await auth.handler(signUpRequest("ada@example.test"));
    const attempt = () =>
      auth.handler(
        authPost(
          "/sign-in/email",
          { email: "ada@example.test", password: "not the password" },
          { "x-forwarded-for": "203.0.113.9" },
        ),
      );
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await attempt()).status);
    expect(statuses).toContain(429);
    expect(statuses[0]).toBe(401);
    expect(await t.db.select().from(authRateLimits)).not.toHaveLength(0);
  });

  it("an impersonation session records the admin's uuid", async () => {
    // The one admin route left over HTTP, and the one column that is a uuid
    // foreign key here where Better Auth says string.
    await auth.handler(signUpRequest("boss@example.test"));
    await auth.handler(signUpRequest("ada@example.test"));
    const byEmail = async (email: string) =>
      (await t.db.select().from(users).where(eq(users.email, email)))[0]!;
    const boss = await byEmail("boss@example.test");
    const ada = await byEmail("ada@example.test");
    await t.db
      .update(users)
      .set({ role: "admin" })
      .where(eq(users.id, boss.id));

    const signIn = await auth.handler(
      authPost("/sign-in/email", {
        email: "boss@example.test",
        password: PASSWORD,
      }),
    );
    const response = await auth.handler(
      authPost(
        "/admin/impersonate-user",
        { userId: ada.id },
        { cookie: cookieHeader(signIn) },
      ),
    );
    expect(response.status).toBe(200);
    const rows = await t.db
      .select()
      .from(authSessions)
      .where(eq(authSessions.userId, ada.id));
    // Her own sign-up session, and the impersonation.
    expect(rows.map((r) => r.impersonatedBy).sort()).toEqual([boss.id, null]);
  });
});
