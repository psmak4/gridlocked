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

    const codes: (string | null)[] = [];
    for (let i = 0; i < 4; i++) {
      codes.push(
        await errorCode(() =>
          verifyStaffSession(auth, t.db, now(), { viewer: v, code: wrong }),
        ),
      );
    }
    expect(codes).toContain("rate_limited");
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
});
