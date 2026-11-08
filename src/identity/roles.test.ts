import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../../tests/helpers/test-db";
import {
  authPost,
  cookieHeader,
  PASSWORD,
  TEST_NOW,
  testAuth,
  type TestAuth,
} from "../../tests/helpers/auth";
import { errorCode, signUpAs, viewerFor } from "../../tests/helpers/staff";
import { seedUser } from "../../tests/helpers/users";
import { auditLog, authSessions, users } from "@/db/schema";
import { newId } from "@/lib/ids";
import type { StaffActor } from "@/staff/roster";
import { banUser, setRole, unbanUser, type Role } from "./roles";
import { SYSTEM_USER_ID } from "./system";

const HOUR = 3_600_000;
const ADA = "ada@example.test";

describe("roles and bans (DM 6.4)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let auth: TestAuth;
  let boss: string;
  let actor: StaffActor;
  const now = () => new Date();
  const roleOf = async (id: string) =>
    (await t.db.select().from(users).where(eq(users.id, id)))[0]!.role;
  const audits = (action: string) =>
    t.db.select().from(auditLog).where(eq(auditLog.action, action));
  const sessionsOf = (id: string) =>
    t.db.select().from(authSessions).where(eq(authSessions.userId, id));
  const signIn = (email = ADA) =>
    auth.handler(authPost("/sign-in/email", { email, password: PASSWORD }));

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: TEST_NOW });
    t = await createTestDb();
    auth = testAuth(t.db, { now });
    boss = await seedUser(t.db, { username: "boss", role: "admin" });
    actor = { kind: "admin", label: "psmak4", requestId: "r-1", userId: boss };
  });
  afterEach(async () => {
    vi.useRealTimers();
    await t.close();
  });

  it("a role change writes the audit in the same transaction", async () => {
    const { userId: ada } = await signUpAs(auth, t.db, ADA, "user");
    expect(await sessionsOf(ada)).toHaveLength(1);

    await setRole(t.db, now(), {
      targetUserId: ada,
      role: "moderator",
      reason: "Helps with race chat",
      actor,
    });
    expect(await roleOf(ada)).toBe("moderator");
    // The new role takes effect at the next sign-in.
    expect(await sessionsOf(ada)).toHaveLength(0);
    expect(await audits("user.role.update")).toMatchObject([
      {
        actorUserId: boss,
        actorLabel: "psmak4",
        actorKind: "admin",
        entityType: "user",
        entityId: ada,
        before: { role: "user" },
        after: { role: "moderator" },
        reason: "Helps with race chat",
        requestId: "r-1",
      },
    ]);

    // An audit that can't be written takes the change with it.
    await expect(
      setRole(t.db, now(), {
        targetUserId: ada,
        role: "admin",
        reason: "Promotion",
        actor: { ...actor, userId: newId() },
      }),
    ).rejects.toThrow();
    expect(await roleOf(ada)).toBe("moderator");
    expect(await audits("user.role.update")).toHaveLength(1);
  });

  it("needs a reason", async () => {
    const ada = await seedUser(t.db, { username: "ada" });
    await expect(
      setRole(t.db, now(), {
        targetUserId: ada,
        role: "admin",
        reason: "   ",
        actor,
      }),
    ).rejects.toThrow("a staff action needs a reason");
    expect(await roleOf(ada)).toBe("user");
    expect(await audits("user.role.update")).toHaveLength(0);
  });

  it("the last admin can't be demoted", async () => {
    const demote = (target: string) =>
      setRole(t.db, now(), {
        targetUserId: target,
        role: "user",
        reason: "Stepping down",
        actor,
      });
    expect(await errorCode(() => demote(boss))).toBe("last_admin");
    expect(await roleOf(boss)).toBe("admin");

    // A banned admin isn't an active one.
    const other = await seedUser(t.db, { username: "other", role: "admin" });
    await t.db.update(users).set({ banned: true }).where(eq(users.id, other));
    expect(await errorCode(() => demote(boss))).toBe("last_admin");
    // Nor can the last active admin be banned.
    expect(
      await errorCode(() =>
        banUser(t.db, now(), {
          targetUserId: boss,
          until: null,
          reason: "Oops",
          actor,
        }),
      ),
    ).toBe("last_admin");

    await t.db.update(users).set({ banned: false }).where(eq(users.id, other));
    await demote(boss);
    expect(await roleOf(boss)).toBe("user");
    expect(await errorCode(() => demote(other))).toBe("last_admin");
  });

  it("no one can be made system", async () => {
    const ada = await seedUser(t.db, { username: "ada" });
    expect(
      await errorCode(() =>
        setRole(t.db, now(), {
          targetUserId: ada,
          role: "system" as Role,
          reason: "Results bot",
          actor,
        }),
      ),
    ).toBe("role_reserved");
    expect(
      await errorCode(() =>
        setRole(t.db, now(), {
          targetUserId: SYSTEM_USER_ID,
          role: "user",
          reason: "Tidy up",
          actor,
        }),
      ),
    ).toBe("role_reserved");
    expect(
      await errorCode(() =>
        banUser(t.db, now(), {
          targetUserId: SYSTEM_USER_ID,
          until: null,
          reason: "Tidy up",
          actor,
        }),
      ),
    ).toBe("role_reserved");
    expect(await roleOf(ada)).toBe("user");
    expect(await roleOf(SYSTEM_USER_ID)).toBe("system");
    expect(await audits("user.role.update")).toHaveLength(0);
  });

  it("a banned user can't sign in", async () => {
    const { userId: ada } = await signUpAs(auth, t.db, ADA, "user");
    await banUser(t.db, now(), {
      targetUserId: ada,
      until: null,
      reason: "Spam",
      actor,
    });
    const refused = await signIn();
    expect(refused.status).toBe(403);
    expect(refused.headers.getSetCookie().join()).not.toContain(
      "session_token",
    );
    expect(await audits("user.ban")).toMatchObject([
      {
        actorUserId: boss,
        entityId: ada,
        before: { banned: false, banExpires: null },
        after: { banned: true, banExpires: null },
        reason: "Spam",
      },
    ]);

    await unbanUser(t.db, now(), {
      targetUserId: ada,
      reason: "Appeal upheld",
      actor,
    });
    expect((await signIn()).status).toBe(200);
    expect(await audits("user.unban")).toMatchObject([
      { entityId: ada, after: { banned: false }, reason: "Appeal upheld" },
    ]);
  });

  it("their sessions are gone at once", async () => {
    const { userId: ada, cookie } = await signUpAs(auth, t.db, ADA, "user");
    const other = cookieHeader(await signIn());
    expect(await viewerFor(t.db, cookie, now)).not.toBeNull();
    expect(await sessionsOf(ada)).toHaveLength(2);

    await banUser(t.db, now(), {
      targetUserId: ada,
      until: new Date(now().getTime() + 24 * HOUR),
      reason: "Cooling off",
      actor,
    });
    expect(await sessionsOf(ada)).toHaveLength(0);
    expect(await viewerFor(t.db, cookie, now)).toBeNull();
    expect(await viewerFor(t.db, other, now)).toBeNull();
  });

  it("a temporary ban ends on its own", async () => {
    const { userId: ada } = await signUpAs(auth, t.db, ADA, "user");
    const until = new Date(now().getTime() + 24 * HOUR);
    await banUser(t.db, now(), {
      targetUserId: ada,
      until,
      reason: "Cooling off",
      actor,
    });
    expect((await signIn()).status).toBe(403);

    vi.setSystemTime(new Date(until.getTime() - 60_000));
    expect((await signIn()).status).toBe(403);

    vi.setSystemTime(new Date(until.getTime() + 60_000));
    const back = await signIn();
    expect(back.status).toBe(200);
    const [row] = await t.db.select().from(users).where(eq(users.id, ada));
    expect(row).toMatchObject({ banned: false, banExpires: null });

    // An end in the past isn't a ban.
    expect(
      await errorCode(() =>
        banUser(t.db, now(), {
          targetUserId: ada,
          until: new Date(now().getTime() - HOUR),
          reason: "Late",
          actor,
        }),
      ),
    ).toBe("invalid_ban");
  });
});
