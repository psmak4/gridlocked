import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../../tests/helpers/test-db";
import {
  authPost,
  PASSWORD,
  TEST_NOW,
  TEST_ORIGIN,
  testAuth,
  type TestAuth,
} from "../../tests/helpers/auth";
import {
  enableTotp,
  errorCode,
  signInWithTotp,
  signUpAs,
  totpCode,
  viewerFor,
} from "../../tests/helpers/staff";
import { auditLog, authSessions, users } from "@/db/schema";
import type { Db } from "@/db/types";
import { DISABLED_AUTH_PATHS } from "./auth";
import { startImpersonation, stopImpersonating } from "./impersonation";
import { banUser } from "./roles";
import { verifyStaffSession } from "./staff-access";
import { SYSTEM_USER_ID } from "./system";
import { requireWritable, type Viewer } from "./viewer";

const HOUR = 3_600_000;
/** What a session cookie becomes when the headers come back from a call. */
const cookieOf = (headers: Headers) =>
  headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .filter((c) => !c!.endsWith("="))
    .join("; ");
/** The same cookies less `dont_remember`, which a client can simply drop. */
const withoutDontRemember = (cookie: string) =>
  cookie
    .split("; ")
    .filter((c) => !c.includes("dont_remember"))
    .join("; ");

describe("impersonation (DM 6.4)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let auth: TestAuth;
  let boss: { userId: string; cookie: string; viewer: Viewer };
  let ada: string;
  const now = () => new Date();
  const viewer = (cookie: string) => viewerFor(t.db, cookie, now);
  const audits = (action: string) =>
    t.db.select().from(auditLog).where(eq(auditLog.action, action));

  /** A staff member who signed in with TOTP and unlocked the session. */
  const verifiedStaff = async (
    email: string,
    role: "admin" | "moderator",
    username: string,
  ) => {
    const { userId, cookie: first } = await signUpAs(auth, t.db, email, role, {
      username,
    });
    const { secret } = await enableTotp(auth, first, { password: PASSWORD });
    vi.setSystemTime(new Date(now().getTime() + 60_000));
    const cookie = await signInWithTotp(auth, email, secret);
    await verifyStaffSession(auth, t.db, now(), {
      viewer: (await viewer(cookie))!,
      code: await totpCode(auth, secret, new Date(now().getTime() + 30_000)),
    });
    return { userId, cookie, viewer: (await viewer(cookie))! };
  };

  const start = (as = boss, targetUserId = ada) =>
    startImpersonation(auth, t.db, now(), {
      viewer: as.viewer,
      targetUserId,
      reason: "Ada can't see her league",
      headers: new Headers({ cookie: as.cookie }),
    });

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: TEST_NOW });
    t = await createTestDb();
    auth = testAuth(t.db, { now });
    boss = await verifiedStaff("boss@example.test", "admin", "boss");
    ada = (
      await signUpAs(auth, t.db, "ada@example.test", "user", {
        username: "ada",
      })
    ).userId;
  });
  afterEach(async () => {
    vi.useRealTimers();
    await t.close();
  });

  it("only a verified admin can start", async () => {
    // An admin with TOTP whose session hasn't passed the two-step.
    const { userId, cookie: first } = await signUpAs(
      auth,
      t.db,
      "new@example.test",
      "admin",
    );
    const { cookie } = await enableTotp(auth, first, { password: PASSWORD });
    const locked = (await viewer(cookie))!;
    expect(locked.twoFactorEnabled).toBe(true);
    expect(
      await errorCode(() => start({ userId, cookie, viewer: locked })),
    ).toBe("staff_session_unverified");

    // A verified moderator is still not an admin.
    const mod = await verifiedStaff("mod@example.test", "moderator", "mod");
    expect(await errorCode(() => start(mod))).toBe("forbidden");

    // Nobody impersonates another admin, the system user or themselves.
    const other = await verifiedStaff("other@example.test", "admin", "other");
    expect(await errorCode(() => start(boss, other.userId))).toBe(
      "cannot_impersonate",
    );
    expect(await errorCode(() => start(boss, SYSTEM_USER_ID))).toBe(
      "cannot_impersonate",
    );
    expect(await errorCode(() => start(boss, boss.userId))).toBe(
      "cannot_impersonate",
    );
    expect(await audits("user.impersonate.start")).toHaveLength(0);

    const { headers } = await start();
    expect((await viewer(cookieOf(headers)))!.userId).toBe(ada);
  });

  it("start and stop are audited with both user ids", async () => {
    const { headers } = await start();
    const cookie = cookieOf(headers);
    const as = (await viewer(cookie))!;
    expect(as.impersonatedBy).toBe(boss.userId);
    expect(await audits("user.impersonate.start")).toMatchObject([
      {
        actorUserId: boss.userId,
        impersonatingUserId: ada,
        actorKind: "admin",
        entityType: "user",
        entityId: ada,
        reason: "Ada can't see her league",
        after: { sessionId: as.sessionId },
      },
    ]);

    await stopImpersonating(auth, t.db, now(), {
      viewer: as,
      headers: new Headers({ cookie }),
    });
    expect(await audits("user.impersonate.stop")).toMatchObject([
      {
        actorUserId: boss.userId,
        impersonatingUserId: ada,
        entityId: ada,
        after: { sessionId: as.sessionId },
      },
    ]);
  });

  it("a sign-out while impersonating is audited as a stop", async () => {
    const { headers } = await start();
    const cookie = cookieOf(headers);
    const response = await auth.handler(authPost("/sign-out", {}, { cookie }));
    expect(response.status).toBe(200);
    expect(await audits("user.impersonate.stop")).toMatchObject([
      {
        actorUserId: boss.userId,
        impersonatingUserId: ada,
        after: { via: "sign-out" },
      },
    ]);
  });

  it("it ends after one hour", async () => {
    const { headers } = await start();
    const cookie = cookieOf(headers);
    const as = (await viewer(cookie))!;
    const [row] = await t.db
      .select()
      .from(authSessions)
      .where(eq(authSessions.id, as.sessionId));
    expect(row!.expiresAt.getTime() - row!.createdAt.getTime()).toBe(HOUR);

    vi.setSystemTime(new Date(now().getTime() + HOUR - 60_000));
    expect(await viewer(cookie)).not.toBeNull();
    vi.setSystemTime(new Date(now().getTime() + 2 * 60_000));
    expect(await viewer(cookie)).toBeNull();
  });

  it("the hour holds on the server, even without the dont_remember cookie", async () => {
    const { headers } = await start();
    const cookie = withoutDontRemember(cookieOf(headers));
    expect(cookieOf(headers)).toContain("dont_remember");
    const getSession = () =>
      auth.handler(
        new Request(`${TEST_ORIGIN}/api/auth/get-session`, {
          headers: { cookie },
        }),
      );
    // A refresh can't push it past the hour.
    expect((await getSession()).status).toBe(200);
    const [row] = await t.db
      .select()
      .from(authSessions)
      .where(eq(authSessions.impersonatedBy, boss.userId));
    expect(
      row!.expiresAt.getTime() - row!.createdAt.getTime(),
    ).toBeLessThanOrEqual(HOUR);
    expect(await viewer(cookie)).not.toBeNull();

    vi.setSystemTime(new Date(row!.createdAt.getTime() + HOUR + 60_000));
    expect(await (await getSession()).json()).toBeNull();
    expect(await viewer(cookie)).toBeNull();
  });

  it("a page treats an impersonation older than an hour as signed out", async () => {
    const { headers } = await start();
    const cookie = withoutDontRemember(cookieOf(headers));
    const as = (await viewer(cookie))!;
    // As if a refresh had got through: the row says a week.
    await t.db
      .update(authSessions)
      .set({ expiresAt: new Date(now().getTime() + 7 * 24 * HOUR) })
      .where(eq(authSessions.id, as.sessionId));
    const late = new Date(now().getTime() + HOUR + 60_000);
    expect(await viewerFor(t.db, cookie, () => late)).toBeNull();
    // An admin's own session of the same age is fine.
    expect(await viewerFor(t.db, boss.cookie, () => late)).not.toBeNull();
  });

  it("a banned user can't be impersonated", async () => {
    await banUser(t.db, now(), {
      targetUserId: ada,
      until: null,
      reason: "Spam",
      actor: { kind: "admin", label: "boss", userId: boss.userId },
    });
    expect(await errorCode(() => start())).toBe("cannot_impersonate");
    expect(await audits("user.impersonate.start")).toHaveLength(0);
  });

  it("the viewer must be the session the headers carry", async () => {
    const other = await verifiedStaff("other@example.test", "admin", "other");
    expect(
      await errorCode(() =>
        startImpersonation(auth, t.db, now(), {
          viewer: boss.viewer,
          targetUserId: ada,
          reason: "Mixed up",
          headers: new Headers({ cookie: other.cookie }),
        }),
      ),
    ).toBe("unauthenticated");
    expect(await audits("user.impersonate.start")).toHaveLength(0);
  });

  it("a stop whose audit fails still restores the admin, and logs no values", async () => {
    const { headers } = await start();
    const cookie = cookieOf(headers);
    const as = (await viewer(cookie))!;
    const failing = new Proxy(t.db, {
      get(target, prop, receiver) {
        if (prop === "insert") {
          return (table: unknown) => {
            if (table === auditLog) throw new Error("audit down");
            return target.insert(table as typeof auditLog);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as unknown as Db;
    const logged: string[] = [];
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      });
    try {
      const { headers: back } = await stopImpersonating(auth, failing, now(), {
        viewer: as,
        headers: new Headers({ cookie }),
      });
      expect((await viewer(cookieOf(back)))!.userId).toBe(boss.userId);
    } finally {
      spy.mockRestore();
    }
    expect(logged).toHaveLength(1);
    expect(logged[0]).not.toContain(boss.userId);
    expect(logged[0]).not.toContain(ada);
    expect(logged[0]).not.toContain("example.test");
    expect(
      (await t.db.select().from(users).where(eq(users.id, ada)))[0],
    ).toBeTruthy();
  });

  it("every non-GET auth path is refused while impersonating", async () => {
    const { headers } = await start();
    const cookie = cookieOf(headers);
    const allowed = ["/sign-out", "/admin/stop-impersonating"];
    const checked: string[] = [];
    for (const endpoint of Object.values(auth.api)) {
      const path = (endpoint as { path?: string }).path;
      const option = (endpoint as { options?: { method?: unknown } }).options
        ?.method;
      if (!path || allowed.includes(path)) continue;
      const methods = (Array.isArray(option) ? option : [option]).flatMap(
        (m) => (m === "*" ? ["POST"] : typeof m === "string" ? [m] : []),
      );
      for (const method of methods.filter((m) => m !== "GET")) {
        const url = `${TEST_ORIGIN}/api/auth${path.replace(/:[^/]+/g, "x")}`;
        const response = await auth.handler(
          new Request(url, {
            method,
            headers: {
              cookie,
              origin: TEST_ORIGIN,
              "content-type": "application/json",
              "x-forwarded-for": `198.51.100.${checked.length % 250}`,
            },
            body: "{}",
          }),
        );
        // Closed over HTTP (404), or refused by the read-only rule (403).
        if (DISABLED_AUTH_PATHS.includes(path)) {
          expect(response.status, `${method} ${path}`).toBe(404);
        } else {
          expect(response.status, `${method} ${path}`).toBe(403);
          expect(await response.text(), path).toContain("IMPERSONATION");
        }
        checked.push(`${method} ${path}`);
      }
    }
    // The walk really covered the routes that matter.
    for (const path of [
      "/change-email",
      "/change-password",
      "/update-user",
      "/two-factor/disable",
      "/revoke-sessions",
      "/update-session",
    ]) {
      expect(
        checked.some((c) => c.endsWith(` ${path}`)),
        path,
      ).toBe(true);
    }
    // The session is still there and still the impersonation.
    expect((await viewer(cookie))!.impersonatedBy).toBe(boss.userId);
  });

  it("requireWritable refuses it", async () => {
    const { headers } = await start();
    const as = await viewer(cookieOf(headers));
    expect(as!.complete).toBe(true);
    expect(await errorCode(() => requireWritable(as))).toBe("read_only");
    // Nor can it start another impersonation.
    expect(
      await errorCode(() =>
        startImpersonation(auth, t.db, now(), {
          viewer: { ...as!, role: "admin" },
          targetUserId: ada,
          reason: "Again",
          headers: new Headers({ cookie: cookieOf(headers) }),
        }),
      ),
    ).toBe("read_only");
  });

  it("stop returns to the admin's own session", async () => {
    const { headers } = await start();
    const cookie = cookieOf(headers);
    const as = (await viewer(cookie))!;
    // The browser holds the impersonation cookie and the signed admin one.
    const { headers: back } = await stopImpersonating(auth, t.db, now(), {
      viewer: as,
      headers: new Headers({ cookie }),
    });
    const restored = (await viewer(cookieOf(back)))!;
    expect(restored.userId).toBe(boss.userId);
    expect(restored.sessionId).toBe(boss.viewer.sessionId);
    // Still unlocked: it's the same session.
    expect(restored.staffVerifiedAt).toEqual(boss.viewer.staffVerifiedAt);
    const left = await t.db
      .select()
      .from(authSessions)
      .where(eq(authSessions.id, as.sessionId));
    expect(left).toHaveLength(0);

    // Stopping needs an impersonated session.
    expect(
      await errorCode(() =>
        stopImpersonating(auth, t.db, now(), {
          viewer: restored,
          headers: new Headers({ cookie: cookieOf(back) }),
        }),
      ),
    ).toBe("not_impersonating");
  });
});
