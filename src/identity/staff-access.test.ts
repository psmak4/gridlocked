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
  TEST_NOW,
  testAuth,
  type TestAuth,
} from "../../tests/helpers/auth";
import { signInWithDiscord } from "../../tests/helpers/discord";
import {
  enableTotp,
  errorCode,
  signInWithTotp,
  signUpAs,
  totpCode,
  viewerFor,
} from "../../tests/helpers/staff";
import { auditLog, authSessions, users } from "@/db/schema";
import { requireStaff, verifyStaffSession } from "./staff-access";

const DISCORD = {
  clientId: "fake-discord-client-id",
  clientSecret: "fake-discord-client-secret",
};
const BOSS = "boss@example.test";
const SECOND = 30_000;

describe("the staff two-step (DM 6.4)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let auth: TestAuth;
  let mail: ReturnType<typeof recordingSender>;
  let fetchStub: ReturnType<typeof vi.fn<typeof fetch>>;
  // Better Auth's clock and ours move together.
  const now = () => new Date();
  const viewer = (cookie: string) => viewerFor(t.db, cookie, now);
  const later = (ms: number) =>
    vi.setSystemTime(new Date(now().getTime() + ms));

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: TEST_NOW });
    t = await createTestDb();
    mail = recordingSender();
    fetchStub = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchStub);
    auth = testAuth(t.db, {
      now,
      sender: mail.sender,
      env: { discord: DISCORD },
    });
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    await t.close();
  });

  /** An admin who signed up by password and turned TOTP on. */
  const adminWithTotp = async (role: "admin" | "moderator" = "admin") => {
    const { userId, cookie } = await signUpAs(auth, t.db, BOSS, role);
    const totp = await enableTotp(auth, cookie, { password: PASSWORD });
    return { userId, ...totp };
  };

  it("an admin without TOTP can sign in, and staff tools stay locked", async () => {
    await signUpAs(auth, t.db, BOSS, "admin");
    const signIn = await auth.handler(
      authPost("/sign-in/email", { email: BOSS, password: PASSWORD }),
    );
    expect(signIn.status).toBe(200);
    const v = await viewer(cookieHeader(signIn));
    expect(v).not.toBeNull();
    expect(v!.role).toBe("admin");
    expect(await errorCode(() => requireStaff(v, "admin"))).toBe(
      "staff_two_factor_required",
    );
    // There is nothing to check a code against.
    expect(
      await errorCode(() =>
        verifyStaffSession(auth, t.db, now(), { viewer: v!, code: "123456" }),
      ),
    ).toBe("staff_two_factor_required");
  });

  it("password and TOTP sign-in, then a code, unlocks", async () => {
    const { userId, secret } = await adminWithTotp();
    later(5 * 60_000);
    const cookie = await signInWithTotp(auth, BOSS, secret);
    // Ruling 34: no sign-in sets it, not even password and TOTP.
    const locked = await viewer(cookie);
    expect(locked!.staffVerifiedAt).toBeNull();
    expect(await errorCode(() => requireStaff(locked, "admin"))).toBe(
      "staff_session_unverified",
    );

    later(SECOND);
    const at = now();
    await verifyStaffSession(auth, t.db, at, {
      viewer: locked!,
      code: await totpCode(auth, secret),
    });
    const unlocked = await viewer(cookie);
    expect(unlocked!.staffVerifiedAt).toEqual(at);
    expect(requireStaff(unlocked, "admin")).toBe(unlocked);
    expect(requireStaff(unlocked, "moderator")).toBe(unlocked);

    const audits = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "staff.session.verify"));
    expect(audits).toMatchObject([
      {
        actorUserId: userId,
        actorKind: "admin",
        entityType: "user",
        entityId: userId,
        after: { method: "totp", sessionId: unlocked!.sessionId },
      },
    ]);
  });

  it("an admin with TOTP who signs in by magic link isn't unlocked", async () => {
    const { userId, secret } = await adminWithTotp();
    // A proved address. (For an unproved one, Better Auth's cleanup reserves
    // a verification row with a non-uuid id and the link fails: a separate,
    // earlier bug, reported with this task.)
    await t.db
      .update(users)
      .set({ emailVerified: true })
      .where(eq(users.id, userId));
    await auth.handler(
      authPost(
        "/sign-in/magic-link",
        { email: BOSS },
        { "x-forwarded-for": "203.0.113.30" },
      ),
    );
    const clicked = await auth.handler(
      clickLink(linkIn(mail.last(BOSS, "sign-in link"))),
    );
    expect(clicked.status).toBe(302);
    const cookie = cookieHeader(clicked);
    const v = await viewer(cookie);
    expect(v!.twoFactorEnabled).toBe(true);
    expect(v!.staffVerifiedAt).toBeNull();
    expect(await errorCode(() => requireStaff(v, "admin"))).toBe(
      "staff_session_unverified",
    );

    // Decision 5: a code unlocks it, however the person signed in.
    later(SECOND);
    await verifyStaffSession(auth, t.db, now(), {
      viewer: v!,
      code: await totpCode(auth, secret),
    });
    expect(requireStaff(await viewer(cookie), "admin")).toBeTruthy();
  });

  it("the same for Discord", async () => {
    const person = { id: "2001", email: BOSS, verified: true };
    const first = await signInWithDiscord(auth, fetchStub, person);
    const [user] = await t.db.select().from(users).where(eq(users.email, BOSS));
    await t.db
      .update(users)
      .set({ role: "admin" })
      .where(eq(users.id, user!.id));
    // No password: `allowPasswordless` lets a Discord staff member enrol.
    const { secret } = await enableTotp(auth, cookieHeader(first));

    later(5 * 60_000);
    const again = await signInWithDiscord(auth, fetchStub, person);
    const cookie = cookieHeader(again);
    const v = await viewer(cookie);
    expect(v!.twoFactorEnabled).toBe(true);
    expect(v!.staffVerifiedAt).toBeNull();
    expect(await errorCode(() => requireStaff(v, "admin"))).toBe(
      "staff_session_unverified",
    );

    await verifyStaffSession(auth, t.db, now(), {
      viewer: v!,
      code: await totpCode(auth, secret),
    });
    expect(requireStaff(await viewer(cookie), "admin")).toBeTruthy();
  });

  it("a wrong code leaves it locked, and repeated wrong codes hit the limit", async () => {
    const { secret } = await adminWithTotp();
    const cookie = await signInWithTotp(auth, BOSS, secret);
    const v = (await viewer(cookie))!;
    const right = await totpCode(auth, secret);
    const wrong = right === "000000" ? "111111" : "000000";

    expect(
      await errorCode(() =>
        verifyStaffSession(auth, t.db, now(), { viewer: v, code: wrong }),
      ),
    ).toBe("invalid_code");
    expect((await viewer(cookie))!.staffVerifiedAt).toBeNull();
    expect(
      await errorCode(() =>
        verifyStaffSession(auth, t.db, now(), {
          viewer: v,
          code: "not-a-backup",
        }),
      ),
    ).toBe("invalid_code");

    // Five failures in the window; the sixth attempt waits.
    const codes: (string | null)[] = [];
    for (let i = 0; i < 4; i++) {
      codes.push(
        await errorCode(() =>
          verifyStaffSession(auth, t.db, now(), { viewer: v, code: wrong }),
        ),
      );
    }
    expect(codes).toEqual([
      "invalid_code",
      "invalid_code",
      "invalid_code",
      "rate_limited",
    ]);
    // Once limited, even the right code waits.
    expect(
      await errorCode(() =>
        verifyStaffSession(auth, t.db, now(), { viewer: v, code: right }),
      ),
    ).toBe("rate_limited");
    expect((await viewer(cookie))!.staffVerifiedAt).toBeNull();
    // The limit is per user and the window ends.
    later(16 * 60_000);
    await verifyStaffSession(auth, t.db, now(), {
      viewer: v,
      code: await totpCode(auth, secret),
    });
    expect((await viewer(cookie))!.staffVerifiedAt).not.toBeNull();
  });

  it("a burst of wrong codes at once still hits the limit", async () => {
    const { secret } = await adminWithTotp();
    const cookie = await signInWithTotp(auth, BOSS, secret);
    const v = (await viewer(cookie))!;
    const right = await totpCode(auth, secret);
    const wrong = right === "000000" ? "111111" : "000000";
    // All twelve start before any finishes; their database calls interleave
    // on the one PGlite connection. Each attempt is counted by a single
    // upsert before its code is checked, so only five can be checked.
    const codes = await Promise.all(
      Array.from({ length: 12 }, () =>
        errorCode(() =>
          verifyStaffSession(auth, t.db, now(), { viewer: v, code: wrong }),
        ),
      ),
    );
    expect(codes.filter((c) => c === "invalid_code")).toHaveLength(5);
    expect(codes.filter((c) => c === "rate_limited")).toHaveLength(7);
    expect((await viewer(cookie))!.staffVerifiedAt).toBeNull();
  });

  it("only failed codes count toward the limit", async () => {
    const { secret } = await adminWithTotp();
    const cookie = await signInWithTotp(auth, BOSS, secret);
    const v = (await viewer(cookie))!;
    for (let i = 0; i < 7; i++) {
      await verifyStaffSession(auth, t.db, now(), {
        viewer: v,
        code: await totpCode(auth, secret),
      });
    }
    expect((await viewer(cookie))!.staffVerifiedAt).not.toBeNull();
  });

  it("a backup code works once", async () => {
    const { secret, backupCodes } = await adminWithTotp();
    const first = await signInWithTotp(auth, BOSS, secret);
    const code = backupCodes[0]!;
    await verifyStaffSession(auth, t.db, now(), {
      viewer: (await viewer(first))!,
      code,
    });
    expect(requireStaff(await viewer(first), "admin")).toBeTruthy();
    const [audit] = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "staff.session.verify"));
    expect(audit!.after).toMatchObject({ method: "backup_code" });
    // The code itself is never stored in the log.
    expect(JSON.stringify(audit)).not.toContain(code);

    later(SECOND);
    const second = await signInWithTotp(auth, BOSS, secret);
    const secondViewer = (await viewer(second))!;
    expect(
      await errorCode(() =>
        verifyStaffSession(auth, t.db, now(), { viewer: secondViewer, code }),
      ),
    ).toBe("invalid_code");
    // Another one still works.
    await verifyStaffSession(auth, t.db, now(), {
      viewer: (await viewer(second))!,
      code: backupCodes[1]!,
    });
    expect(requireStaff(await viewer(second), "admin")).toBeTruthy();
  });

  it("a new session starts locked", async () => {
    const { secret } = await adminWithTotp();
    const first = await signInWithTotp(auth, BOSS, secret);
    await verifyStaffSession(auth, t.db, now(), {
      viewer: (await viewer(first))!,
      code: await totpCode(auth, secret),
    });
    expect(requireStaff(await viewer(first), "admin")).toBeTruthy();

    later(SECOND);
    const second = await signInWithTotp(auth, BOSS, secret);
    expect((await viewer(second))!.staffVerifiedAt).toBeNull();
    // The first session keeps its unlock.
    expect((await viewer(first))!.staffVerifiedAt).not.toBeNull();
  });

  it("no client can set staff_verified_at", async () => {
    const { secret } = await adminWithTotp();
    const cookie = await signInWithTotp(auth, BOSS, secret);
    const response = await auth.handler(
      authPost(
        "/update-session",
        { staffVerifiedAt: now().toISOString() },
        { cookie },
      ),
    );
    expect(response.status).toBe(400);
    const v = await viewer(cookie);
    const [row] = await t.db
      .select()
      .from(authSessions)
      .where(
        and(
          eq(authSessions.id, v!.sessionId),
          eq(authSessions.userId, v!.userId),
        ),
      );
    expect(row!.staffVerifiedAt).toBeNull();
  });

  it("a moderator can't pass an admin check", async () => {
    const { secret } = await adminWithTotp("moderator");
    const cookie = await signInWithTotp(auth, BOSS, secret);
    await verifyStaffSession(auth, t.db, now(), {
      viewer: (await viewer(cookie))!,
      code: await totpCode(auth, secret),
    });
    const v = await viewer(cookie);
    expect(requireStaff(v, "moderator")).toBe(v);
    expect(await errorCode(() => requireStaff(v, "admin"))).toBe("forbidden");
    // And a user is no staff at all, verified or not.
    expect(
      await errorCode(() => requireStaff({ ...v!, role: "user" }, "moderator")),
    ).toBe("forbidden");
    expect(
      await errorCode(() =>
        requireStaff({ ...v!, role: "system" }, "moderator"),
      ),
    ).toBe("forbidden");
    expect(
      await errorCode(() =>
        requireStaff({ ...v!, impersonatedBy: v!.userId }, "moderator"),
      ),
    ).toBe("read_only");
    expect(
      await errorCode(() => requireStaff({ ...v!, banned: true }, "moderator")),
    ).toBe("forbidden");
    expect(await errorCode(() => requireStaff(null, "moderator"))).toBe(
      "unauthenticated",
    );
  });

  describe("managing the second factor (ruling 37)", () => {
    // A fixed address per request, so no two share a rate-limit bucket.
    let sent = 0;
    const post = (
      path: string,
      cookie: string,
      body: unknown = {},
      on: TestAuth = auth,
    ) =>
      on.handler(
        authPost(path, body, {
          cookie,
          "x-forwarded-for": `198.51.100.${++sent}`,
        }),
      );

    /** A Discord admin with TOTP: no password guards their factor. */
    const discordAdmin = async () => {
      const person = { id: "2002", email: BOSS, verified: true };
      const first = await signInWithDiscord(auth, fetchStub, person);
      const [user] = await t.db
        .select()
        .from(users)
        .where(eq(users.email, BOSS));
      await t.db
        .update(users)
        .set({ role: "admin" })
        .where(eq(users.id, user!.id));
      const { secret } = await enableTotp(auth, cookieHeader(first));
      later(5 * 60_000);
      // A new session, as a phished link or a taken Discord account gives.
      const again = await signInWithDiscord(auth, fetchStub, person);
      return { secret, cookie: cookieHeader(again) };
    };

    it("a passwordless staff session can't mint a factor to unlock itself", async () => {
      const { cookie } = await discordAdmin();
      const minted = await post("/two-factor/generate-backup-codes", cookie);
      expect(minted.status).toBe(403);
      const text = await minted.text();
      expect(text).toContain("STAFF_SESSION_UNVERIFIED");
      expect(text).not.toMatch(/backupCodes|totpURI|secret/i);
      // Nor turn TOTP off and enrol another authenticator.
      expect((await post("/two-factor/disable", cookie)).status).toBe(403);
      expect((await post("/two-factor/enable", cookie)).status).toBe(403);
      const v = await viewer(cookie);
      expect(v!.twoFactorEnabled).toBe(true);
      expect(await errorCode(() => requireStaff(v, "admin"))).toBe(
        "staff_session_unverified",
      );
    });

    it("the check holds when our clock runs ahead of Better Auth's", async () => {
      const { cookie } = await discordAdmin();
      // A replay deployment whose simulated now is past the session's expiry,
      // which Better Auth (on the wall clock) still accepts.
      const ahead = testAuth(t.db, {
        now: () => new Date(Date.now() + 30 * 24 * 3_600_000),
        sender: mail.sender,
        env: { discord: DISCORD },
      });
      const minted = await post(
        "/two-factor/generate-backup-codes",
        cookie,
        {},
        ahead,
      );
      expect(minted.status).toBe(403);
      expect(await minted.text()).toContain("STAFF_SESSION_UNVERIFIED");
    });

    it("every /two-factor path needs an unlocked staff session", async () => {
      const { cookie } = await discordAdmin();
      const checked: string[] = [];
      for (const endpoint of Object.values(auth.api)) {
        const path = (endpoint as { path?: string }).path;
        if (!path?.startsWith("/two-factor/")) continue;
        const response = await post(path, cookie, { code: "000000" });
        expect(response.status, path).toBe(403);
        expect(await response.text(), path).toContain(
          "STAFF_SESSION_UNVERIFIED",
        );
        checked.push(path);
      }
      for (const path of [
        "/two-factor/enable",
        "/two-factor/disable",
        "/two-factor/generate-backup-codes",
        "/two-factor/get-totp-uri",
        "/two-factor/verify-totp",
        "/two-factor/verify-backup-code",
      ]) {
        expect(checked, path).toContain(path);
      }
    });

    it("after a code, managing the factor works, and first enrolment is open", async () => {
      // First enrolment needed no unlock: there was no factor to protect.
      const { secret, cookie } = await discordAdmin();
      await verifyStaffSession(auth, t.db, now(), {
        viewer: (await viewer(cookie))!,
        code: await totpCode(auth, secret),
      });
      const minted = await post("/two-factor/generate-backup-codes", cookie);
      expect(minted.status).toBe(200);
      const { backupCodes } = (await minted.json()) as {
        backupCodes: string[];
      };
      expect(backupCodes.length).toBeGreaterThan(0);
      // And the sign-in challenge, which has no session, still works.
      later(5 * 60_000);
      const { secret: other } = await adminWithTotpFor("mod@example.test");
      expect(await signInWithTotp(auth, "mod@example.test", other)).toContain(
        "session_token",
      );
    });
  });

  /** A password moderator with TOTP, on a second address. */
  const adminWithTotpFor = async (email: string) => {
    const { cookie } = await signUpAs(auth, t.db, email, "moderator");
    return enableTotp(auth, cookie, { password: PASSWORD });
  };
});
