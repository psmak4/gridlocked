import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { DrizzleQueryError } from "drizzle-orm/errors";
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
  testAuth,
  type TestAuth,
} from "../../tests/helpers/auth";
import { DISABLED_AUTH_PATHS } from "./auth";
import {
  authRateLimits,
  authSessions,
  authVerifications,
  emailOutbox,
  profiles,
  users,
} from "@/db/schema";

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
    expect(refused.status).toBe(403);
    expect(await refused.text()).not.toContain("stranger@example.test");
    expect(await people()).toHaveLength(0);

    const allowed = await closed.handler(signUpRequest("Friend@Example.test"));
    expect(allowed.status).toBe(200);
    expect(await people()).toHaveLength(1);
  });

  it("a .invalid address can't sign up", async () => {
    const response = await auth.handler(signUpRequest("ghost@example.invalid"));
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("ghost@example.invalid");
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

  it("a failing database write logs and returns no address", async () => {
    const address = "leaky@example.test";
    const failing = new Proxy(t.db, {
      get(target, prop, receiver) {
        if (prop === "transaction") {
          return async () => {
            throw new DrizzleQueryError(
              'insert into "users" ("email") values ($1)',
              [address],
              new Error("connection reset"),
            );
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const logged: string[] = [];
    const spies = (["log", "info", "warn", "error"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(
          args.map((a) => (a instanceof Error ? a.stack : String(a))).join(" "),
        );
      }),
    );
    try {
      // The failure reaches the caller (the route logs its name only) or
      // comes back as an error response; either way, nothing is logged here.
      const outcome = await testAuth(failing)
        .handler(signUpRequest(address))
        .then(
          (response) => response,
          (error: unknown) => error,
        );
      if (outcome instanceof Response) {
        expect(outcome.status).toBeGreaterThanOrEqual(400);
        expect(await outcome.text()).not.toContain(address);
      } else {
        expect(outcome).toBeInstanceOf(DrizzleQueryError);
      }
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
    expect(logged.join("\n")).not.toContain(address);
  });

  it("closes every admin endpoint but the two impersonation ones", () => {
    expect(DISABLED_AUTH_PATHS).not.toContain("/admin/impersonate-user");
    expect(DISABLED_AUTH_PATHS).not.toContain("/admin/stop-impersonating");
    expect(DISABLED_AUTH_PATHS).toContain("/admin/set-role");
    expect(DISABLED_AUTH_PATHS).toContain("/delete-user");
    expect(
      DISABLED_AUTH_PATHS.filter((p) => p.startsWith("/admin/")).length,
    ).toBe(13);
  });
});

describe("magic link, verification and reset", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let auth: TestAuth;
  let mail: ReturnType<typeof recordingSender>;
  const EMAIL = "ada@example.test";
  const FROM_IP = { "x-forwarded-for": "203.0.113.20" };
  const requestLink = (email = EMAIL, extra: Record<string, unknown> = {}) =>
    auth.handler(authPost("/sign-in/magic-link", { email, ...extra }, FROM_IP));
  const hasSession = (response: Response) =>
    response.headers.getSetCookie().some((c) => c.includes("session_token"));

  beforeEach(async () => {
    t = await createTestDb();
    mail = recordingSender();
    auth = testAuth(t.db, { sender: mail.sender });
  });
  afterEach(async () => {
    await t.close();
  });

  it("a magic link signs in once and not twice", async () => {
    expect((await requestLink()).status).toBe(200);
    const link = linkIn(mail.last(EMAIL, "sign-in link"));

    const first = await auth.handler(clickLink(link));
    expect(first.status).toBe(302);
    expect(hasSession(first)).toBe(true);

    const second = await auth.handler(clickLink(link));
    expect(hasSession(second)).toBe(false);
    expect(second.headers.get("location") ?? "").toContain("error=");
  });

  it("an expired link sends you to the error page, which offers a new one", async () => {
    await requestLink();
    const url = new URL(linkIn(mail.last(EMAIL, "sign-in link")));
    url.searchParams.set("errorCallbackURL", "/sign-in/link-expired");
    await t.db
      .update(authVerifications)
      .set({ expiresAt: new Date("2020-01-01T00:00:00Z") });

    const response = await auth.handler(clickLink(url.toString()));
    expect(hasSession(response)).toBe(false);
    const location = new URL(response.headers.get("location") ?? "", url);
    expect(location.pathname).toBe("/sign-in/link-expired");
    expect(location.searchParams.get("error")).toBeTruthy();
    // The error page's "send a new one" is this same request again.
    expect((await requestLink()).status).toBe(200);
  });

  it("magic links are stored hashed", async () => {
    await requestLink();
    const link = new URL(linkIn(mail.last(EMAIL, "sign-in link")));
    const token = link.searchParams.get("token")!;
    const rows = await t.db.select().from(authVerifications);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.identifier).toMatch(/^magic-link:/);
    expect(rows[0]!.identifier).not.toContain(token);
    // Better Auth's own hash: SHA-256 of the token, base64url, no padding.
    const hash = createHash("sha256").update(token).digest("base64url");
    expect(rows[0]!.identifier).toBe(`magic-link:${hash}`);
    // And it still works: the hash is of the token in the link.
    expect(hasSession(await auth.handler(clickLink(link.toString())))).toBe(
      true,
    );
  });

  it("a magic link for system@gridlocked.invalid does nothing", async () => {
    const response = await requestLink("system@gridlocked.invalid");
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("gridlocked.invalid");
    expect(mail.sent).toHaveLength(0);
    expect(await t.db.select().from(authVerifications)).toHaveLength(0);
    expect(await t.db.select().from(emailOutbox)).toHaveLength(0);
  });

  it("a reset and a verification for a .invalid address are refused the same way", async () => {
    const address = "ghost@example.invalid";
    const refusals = await Promise.all([
      requestLink(address),
      auth.handler(authPost("/request-password-reset", { email: address })),
      auth.handler(authPost("/send-verification-email", { email: address })),
    ]);
    for (const response of refusals) {
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain(address);
    }
    expect(mail.sent).toHaveLength(0);
  });

  it("the link email expires with the link, in 15 minutes", async () => {
    // No sender: the row stays queued, so its expiry can be read.
    const queued = testAuth(t.db);
    await queued.handler(
      authPost("/sign-in/magic-link", { email: EMAIL }, FROM_IP),
    );
    const [row] = await t.db.select().from(emailOutbox);
    expect(row?.template).toBe("magic_link");
    expect(row?.expiresAt?.toISOString()).toBe("2026-11-07T12:15:00.000Z");
  });

  it("a reset revokes other sessions", async () => {
    await auth.handler(signUpRequest(EMAIL));
    await auth.handler(
      authPost("/sign-in/email", { email: EMAIL, password: PASSWORD }),
    );
    expect(await t.db.select().from(authSessions)).toHaveLength(2);

    const ask = await auth.handler(
      authPost("/request-password-reset", { email: EMAIL }, FROM_IP),
    );
    expect(ask.status).toBe(200);
    const link = linkIn(mail.last(EMAIL, "Reset your"));
    const token = new URL(link).pathname.split("/").pop()!;
    const reset = await auth.handler(
      authPost("/reset-password", {
        newPassword: "a brand new password",
        token,
      }),
    );
    expect(reset.status).toBe(200);
    expect(await t.db.select().from(authSessions)).toHaveLength(0);

    const signIn = await auth.handler(
      authPost("/sign-in/email", {
        email: EMAIL,
        password: "a brand new password",
      }),
    );
    expect(signIn.status).toBe(200);
  });

  it("a verification link marks the address verified", async () => {
    const signUp = await auth.handler(signUpRequest(EMAIL));
    expect(signUp.status).toBe(200);
    const link = linkIn(mail.last(EMAIL, "Confirm your email"));
    const [before] = await t.db
      .select()
      .from(users)
      .where(eq(users.email, EMAIL));
    expect(before?.emailVerified).toBe(false);

    const response = await auth.handler(clickLink(link));
    expect(response.status).toBeLessThan(400);
    const [after] = await t.db
      .select()
      .from(users)
      .where(eq(users.email, EMAIL));
    expect(after?.emailVerified).toBe(true);
  });

  it("verifying an account ends the sessions it had, even with no sign-in link", async () => {
    await auth.handler(signUpRequest(EMAIL));
    await auth.handler(
      authPost("/sign-in/email", { email: EMAIL, password: PASSWORD }),
    );
    const stray = (await t.db.select().from(authSessions)).map((s) => s.id);
    expect(stray).toHaveLength(2);

    const link = linkIn(mail.last(EMAIL, "Confirm your email"));
    const response = await auth.handler(clickLink(link));
    expect(response.status).toBeLessThan(400);
    const after = await t.db.select().from(authSessions);
    expect(after).toHaveLength(1);
    expect(stray).not.toContain(after[0]!.id);
    expect(hasSession(response)).toBe(true);
  });

  it("a resend inside 40 seconds is refused", async () => {
    await auth.handler(signUpRequest(EMAIL));
    const resend = () =>
      auth.handler(
        authPost("/send-verification-email", { email: EMAIL }, FROM_IP),
      );
    expect((await resend()).status).toBe(200);
    expect((await resend()).status).toBe(429);
  });
});
