import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import { seedViewer } from "../../tests/helpers/community";
import { users } from "@/db/schema";
import type { Db } from "@/db/types";
import { scrubAccount } from "@/identity/delete";
import type { Viewer } from "@/identity/viewer";
import { runStaff } from "@/server/staff-fn";
import { SET_ROLE } from "@/server/staff-users";
import { findUsers, userDetail } from "./users";

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

const NOW = new Date("2026-03-07T12:00:00Z");

/** A staff viewer with two-step on and the session unlocked. */
async function staffViewer(
  db: TestDb["db"],
  role: "admin" | "moderator",
  username: string,
): Promise<Viewer> {
  return {
    ...(await seedViewer(db, { role, username })),
    twoFactorEnabled: true,
    staffVerifiedAt: NOW,
  };
}

// User lookup for staff (M8 Task 12): the search, the detail and who may do
// what.
describe("findUsers and userDetail (M8 Task 12)", () => {
  let t: TestDb;

  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.close();
  });

  it("findUsers matches a username prefix and never an email", async () => {
    await seedViewer(t.db, { username: "MaxFan" });
    await seedViewer(t.db, { username: "maxwell" });
    await seedViewer(t.db, { username: "Lando4" });
    await t.db
      .update(users)
      .set({ email: "lando@max.example" })
      .where(eq(users.username, "lando4"));

    expect((await findUsers(t.db, "max")).map((u) => u.username)).toEqual([
      "MaxFan",
      "maxwell",
    ]);
    expect(await findUsers(t.db, "lando@max.example")).toEqual([]);
    expect(await findUsers(t.db, "lando@")).toEqual([]);
    // "%" and "_" are letters here, not patterns.
    expect(await findUsers(t.db, "%")).toEqual([]);
    expect(await findUsers(t.db, "")).toEqual([]);
  });

  it("findUsers returns at most 20", async () => {
    for (let i = 0; i < 25; i++) {
      await seedViewer(t.db, { username: `grid${String(i).padStart(2, "0")}` });
    }
    expect(await findUsers(t.db, "grid")).toHaveLength(20);
  });

  it("a moderator's userDetail has no role, ban or impersonation actions", async () => {
    await seedViewer(t.db, { username: "Oscar", trustLevel: 1 });
    const asMod = await userDetail(t.db, NOW, {
      username: "oscar",
      viewerRole: "moderator",
    });
    expect(asMod).toMatchObject({ username: "Oscar", deleted: false });
    const groups = new Set(asMod!.actions.map((a) => a.group));
    expect(groups).toEqual(new Set(["trust", "restrictions"]));
    expect(asMod!.actions.map((a) => a.id)).not.toContain("set_role");
    expect(asMod!.actions.map((a) => a.id)).not.toContain("impersonate");

    const asAdmin = await userDetail(t.db, NOW, {
      username: "oscar",
      viewerRole: "admin",
    });
    expect(asAdmin!.actions.map((a) => a.id)).toEqual(
      expect.arrayContaining(["set_role", "ban", "impersonate"]),
    );
  });

  it("a moderator calling setRole through the server function is refused with forbidden", async () => {
    const mod = await staffViewer(t.db, "moderator", "mod");
    const target = await seedViewer(t.db, { username: "Target" });
    const result = await runStaff(
      SET_ROLE,
      mod,
      { userId: target.userId, role: "moderator", reason: "Helping out" },
      (fn) => fn(t.db as unknown as Db, NOW),
    );
    expect(result).toEqual({ ok: false, error: "forbidden" });
    const [row] = await t.db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, target.userId));
    expect(row!.role).toBe("user");
  });

  it("an admin's setRole through the server function changes the role", async () => {
    const admin = await staffViewer(t.db, "admin", "boss");
    const target = await seedViewer(t.db, { username: "Helper" });
    const result = await runStaff(
      SET_ROLE,
      admin,
      { userId: target.userId, role: "moderator", reason: "Helping out" },
      (fn) => fn(t.db as unknown as Db, NOW),
    );
    expect(result).toMatchObject({ ok: true });
    const detail = await userDetail(t.db, NOW, {
      username: "helper",
      viewerRole: "admin",
    });
    expect(detail!.role).toBe("moderator");
  });

  it("userDetail shows a deleted user's tombstone without a username", async () => {
    const gone = await seedViewer(t.db, { username: "Leaving" });
    await scrubAccount(t.db, NOW, {
      userId: gone.userId,
      actor: { kind: "user", userId: gone.userId, label: null },
    });
    const detail = await userDetail(t.db, NOW, {
      username: "leaving",
      viewerRole: "admin",
    });
    expect(detail).toMatchObject({
      userId: gone.userId,
      username: null,
      deleted: true,
    });
    expect(detail!.actions).toEqual([]);
    // The search finds only live names.
    expect(await findUsers(t.db, "leav")).toEqual([]);
  });

  it("userDetail is null for a name nobody has", async () => {
    expect(
      await userDetail(t.db, NOW, { username: "nobody", viewerRole: "admin" }),
    ).toBeNull();
  });
});
