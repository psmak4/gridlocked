import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../tests/helpers/test-db";
import {
  cookieHeader,
  signUpRequest,
  TEST_NOW,
  testAuth,
  testAuthEnv,
} from "../../tests/helpers/auth";
import { authRateLimits, authSessions, profiles, users } from "@/db/schema";
import type { Db } from "@/db/types";
import { getViewer, type SessionDeps } from "@/server/session";
import {
  canPost,
  consumeRateLimit,
  IdentityError,
  requireComplete,
  requireViewer,
  requireWritable,
  type Viewer,
} from "./viewer";

const MINUTE = 60_000;

describe("getViewer and touchViewer", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let dbCalls: number;
  let clock: Date;
  let deps: SessionDeps;
  let cookie: string;

  const at = (offsetMs: number) => {
    clock = new Date(TEST_NOW.getTime() + offsetMs);
  };
  const request = (cookies = cookie) =>
    new Request("http://localhost:3000/", { headers: { cookie: cookies } });
  const adaId = async () =>
    (
      await t.db.select().from(users).where(eq(users.email, "ada@example.test"))
    )[0]!.id;
  const profileRow = async () =>
    (
      await t.db
        .select()
        .from(profiles)
        .where(eq(profiles.userId, await adaId()))
    )[0]!;

  beforeEach(async () => {
    t = await createTestDb();
    dbCalls = 0;
    clock = TEST_NOW;
    deps = {
      withDb: (fn) => {
        dbCalls++;
        return fn(t.db);
      },
      env: () => testAuthEnv(),
      now: async () => clock,
    };
    const signUp = await testAuth(t.db).handler(
      signUpRequest("ada@example.test"),
    );
    cookie = cookieHeader(signUp);
    // The sign-up hook made the profile; start every test from "never seen".
    await t.db
      .update(profiles)
      .set({ lastSeenAt: null, daysVisited: 0 })
      .where(eq(profiles.userId, await adaId()));
  });
  afterEach(async () => {
    await t.close();
  });

  it("no cookie means no viewer and no database call", async () => {
    expect(
      await getViewer(new Request("http://localhost:3000/"), deps),
    ).toBeNull();
    expect(await getViewer(request("theme=dark; other=1"), deps)).toBeNull();
    expect(dbCalls).toBe(0);
  });

  it("a stale cookie means one lookup and no viewer", async () => {
    const stale = "__Secure-better-auth.session_token=made-up.value";
    expect(await getViewer(request(stale), deps)).toBeNull();
    expect(dbCalls).toBe(1);
  });

  it("a good cookie gives the viewer", async () => {
    const viewer = await getViewer(request(), deps);
    expect(viewer).not.toBeNull();
    expect(viewer!.role).toBe("user");
    expect(viewer!.emailVerified).toBe(false);
    expect(viewer!.impersonatedBy).toBeNull();
    expect(viewer!.staffVerifiedAt).toBeNull();
    expect(viewer!.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(viewer!.complete).toBe(false);
    expect(dbCalls).toBe(1);
  });

  it("a lost profile is repaired on the next read", async () => {
    await t.db.delete(profiles).where(eq(profiles.userId, await adaId()));
    const viewer = await getViewer(request(), deps);
    expect(viewer?.profile.status).toBe("active");
    expect(await profileRow()).toBeDefined();
  });

  it("last_seen_at isn't written twice in 15 minutes", async () => {
    await getViewer(request(), deps);
    expect((await profileRow()).lastSeenAt).toEqual(TEST_NOW);

    at(10 * MINUTE);
    await getViewer(request(), deps);
    expect((await profileRow()).lastSeenAt).toEqual(TEST_NOW);

    at(16 * MINUTE);
    const viewer = await getViewer(request(), deps);
    expect((await profileRow()).lastSeenAt).toEqual(clock);
    expect(viewer?.profile.lastSeenAt).toEqual(clock);
  });

  it("days_visited rises once per UTC day", async () => {
    await getViewer(request(), deps);
    expect((await profileRow()).daysVisited).toBe(1);

    at(20 * MINUTE);
    await getViewer(request(), deps);
    at(3 * 60 * MINUTE);
    await getViewer(request(), deps);
    expect((await profileRow()).daysVisited).toBe(1);

    // 12:00 UTC plus 13 hours is 01:00 the next day.
    at(13 * 60 * MINUTE);
    await getViewer(request(), deps);
    expect((await profileRow()).daysVisited).toBe(2);
    // Crossing midnight writes at once, even inside the 15 minutes.
    at(13 * 60 * MINUTE + MINUTE);
    await getViewer(request(), deps);
    expect((await profileRow()).daysVisited).toBe(2);
  });

  it("an impersonated session records no visit", async () => {
    // An admin looking through Ada's account (Ruling 58, M2).
    const boss = await testAuth(t.db).handler(
      signUpRequest("boss@example.test"),
    );
    expect(boss.status).toBe(200);
    const [admin] = await t.db
      .select()
      .from(users)
      .where(eq(users.email, "boss@example.test"));
    await t.db
      .update(authSessions)
      .set({ impersonatedBy: admin!.id })
      .where(eq(authSessions.userId, await adaId()));

    const viewer = await getViewer(request(), deps);
    expect(viewer?.impersonatedBy).toBe(admin!.id);
    // Past the 15 minutes, inside the impersonation's hour.
    at(20 * MINUTE);
    expect((await getViewer(request(), deps))?.impersonatedBy).toBe(admin!.id);
    const row = await profileRow();
    expect(row.lastSeenAt).toBeNull();
    expect(row.daysVisited).toBe(0);
  });

  it("crossing UTC midnight inside 15 minutes still counts the new day", async () => {
    await t.db
      .update(profiles)
      .set({ lastSeenAt: new Date("2026-11-07T23:55:00Z"), daysVisited: 4 })
      .where(eq(profiles.userId, await adaId()));
    clock = new Date("2026-11-08T00:02:00Z");
    await getViewer(request(), deps);
    const row = await profileRow();
    expect(row.daysVisited).toBe(5);
    expect(row.lastSeenAt).toEqual(clock);
  });
});

describe("the guards", () => {
  const base = {
    userId: "u",
    role: "user",
    banned: false,
    username: "ada",
    displayUsername: "Ada",
    emailVerified: true,
    twoFactorEnabled: false,
    sessionId: "s",
    impersonatedBy: null,
    staffVerifiedAt: null,
    profile: { status: "active" },
    complete: true,
  } as unknown as Viewer;
  const codeOf = (fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      expect(error).toBeInstanceOf(IdentityError);
      return (error as IdentityError).code;
    }
    return null;
  };

  it("requireViewer refuses nobody", () => {
    expect(codeOf(() => requireViewer(null))).toBe("unauthenticated");
    expect(requireViewer(base)).toBe(base);
  });

  it("requireComplete refuses an unfinished account", () => {
    expect(codeOf(() => requireComplete(null))).toBe("unauthenticated");
    expect(codeOf(() => requireComplete({ ...base, complete: false }))).toBe(
      "incomplete",
    );
    expect(requireComplete(base)).toBe(base);
  });

  it("requireWritable refuses an impersonated session", () => {
    expect(
      codeOf(() => requireWritable({ ...base, impersonatedBy: "a" })),
    ).toBe("read_only");
    expect(codeOf(() => requireWritable({ ...base, complete: false }))).toBe(
      "incomplete",
    );
    expect(requireWritable(base)).toBe(base);
  });

  it("canPost wants a verified, active, un-impersonated account", () => {
    expect(codeOf(() => canPost({ ...base, emailVerified: false }))).toBe(
      "unverified",
    );
    expect(
      codeOf(() =>
        canPost({
          ...base,
          profile: { status: "deleted" },
        } as unknown as Viewer),
      ),
    ).toBe("inactive");
    expect(codeOf(() => canPost({ ...base, impersonatedBy: "a" }))).toBe(
      "read_only",
    );
    expect(canPost(base)).toBe(base);
  });
});

describe("consumeRateLimit", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: Db;
  beforeEach(async () => {
    t = await createTestDb();
    db = t.db;
  });
  afterEach(async () => {
    await t.close();
  });

  it("refuses past the max and allows again after the window", async () => {
    const opts = { windowSeconds: 60, max: 3 };
    const key = "join:203.0.113.9";
    const results: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      results.push(
        await consumeRateLimit(
          db,
          new Date(TEST_NOW.getTime() + i * 1000),
          key,
          opts,
        ),
      );
    }
    expect(results).toEqual([true, true, true, false, false]);

    // Another key has its own allowance.
    expect(await consumeRateLimit(db, TEST_NOW, "join:other", opts)).toBe(true);

    // Still inside the window of the first request.
    expect(
      await consumeRateLimit(
        db,
        new Date(TEST_NOW.getTime() + 59_000),
        key,
        opts,
      ),
    ).toBe(false);
    // 60 seconds after the first request, the window has passed.
    expect(
      await consumeRateLimit(
        db,
        new Date(TEST_NOW.getTime() + 60_000),
        key,
        opts,
      ),
    ).toBe(true);
    const rows = await db
      .select()
      .from(authRateLimits)
      .where(eq(authRateLimits.key, key));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.count).toBe(1);
  });
});
