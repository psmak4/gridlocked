import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../tests/helpers/test-db";
import { seedUser } from "../../tests/helpers/users";
import { profiles } from "@/db/schema";
import type { Db } from "@/db/types";
import { writeAudit, type AuditEntry } from "./log";
import { auditPage } from "./read";

const NOW = new Date("2026-11-21T09:00:00.000Z");
const MINUTE = 60_000;

describe("auditPage (M8 Task 4)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: Db;
  let admin: string;
  let target: string;

  beforeEach(async () => {
    t = await createTestDb();
    db = t.db as unknown as Db;
    admin = await seedUser(db, { username: "preston", role: "admin" });
    target = await seedUser(db, { username: "late_braker" });
  });
  afterEach(async () => {
    await t.close();
  });

  const write = (at: number, over: Partial<AuditEntry> = {}) =>
    writeAudit(db, new Date(NOW.getTime() + at * MINUTE), {
      actorUserId: admin,
      actorKind: "admin",
      actorLabel: null,
      action: "user.role.update",
      entityType: "user",
      entityId: target,
      before: { role: "user" },
      after: { role: "moderator" },
      reason: "Helping out",
      requestId: null,
      ...over,
    });

  it("auditPage returns 50 newest first and a cursor", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 60; i++) ids.push(await write(i));
    const first = await auditPage(db, {});
    expect(first.rows).toHaveLength(50);
    expect(first.rows[0]!.id).toBe(ids[59]);
    expect(first.rows[49]!.id).toBe(ids[10]);
    expect(first.next).toBe(ids[10]);
    const rest = await auditPage(db, { before: first.next! });
    expect(rest.rows.map((r) => r.id)).toEqual(ids.slice(0, 10).reverse());
    expect(rest.next).toBeNull();
    expect(first.rows[0]).toMatchObject({
      when: new Date(NOW.getTime() + 59 * MINUTE).toISOString(),
      who: "preston",
      what: "Role change",
      on: "late_braker",
      reason: "Helping out",
    });
  });

  it("a deleted actor shows as deleted user; a job as Job; the workflow by its label", async () => {
    await write(0);
    await write(1, { actorUserId: null, actorKind: "job", reason: null });
    await write(2, { actorUserId: null, actorKind: "system", reason: null });
    await write(3, { actorUserId: null, actorLabel: "psmak4" });
    await write(4, { actorUserId: admin, actorLabel: "psmak4" });
    await db
      .update(profiles)
      .set({ status: "deleted" })
      .where(eq(profiles.userId, admin));
    const { rows } = await auditPage(db, {});
    expect(rows.map((r) => r.who)).toEqual([
      // A workflow run names its label even when it names a user too.
      "psmak4",
      "psmak4",
      "Job",
      "Job",
      "deleted user",
    ]);
  });

  it("change shows only changed fields as field: old → new", async () => {
    await write(0, {
      before: { role: "user", banned: false, banExpires: null },
      after: { role: "moderator", banned: false, banExpires: null },
    });
    await write(1, {
      action: "staff.session.verify",
      before: null,
      after: { method: "totp", sessionId: "s-1" },
    });
    await write(2, {
      action: "user.ban",
      before: { banned: false, banExpires: null },
      after: { banned: true, banExpires: "2026-12-01T00:00:00.000Z" },
    });
    const { rows } = await auditPage(db, {});
    expect(rows.map((r) => r.change)).toEqual([
      ["banned: false → true", "banExpires: none → 2026-12-01T00:00:00.000Z"],
      ["method: totp", "sessionId: s-1"],
      ["role: user → moderator"],
    ]);
  });

  it("filtering by group moderation returns only moderation actions", async () => {
    await write(0);
    await write(1, {
      action: "moderation.remove",
      entityType: "post",
      before: { status: "visible" },
      after: { status: "removed" },
    });
    await write(2, { action: "user.ban" });
    await write(3, { action: "staff.session.verify" });
    const moderation = await auditPage(db, { group: "moderation" });
    expect(moderation.rows.map((r) => r.what)).toEqual([
      "User banned",
      "Content removed",
    ]);
    const security = await auditPage(db, { group: "security" });
    expect(security.rows.map((r) => r.what)).toEqual([
      "Staff tools unlocked",
      "Role change",
    ]);
  });

  it("filtering by who: one staff member, or jobs", async () => {
    const other = await seedUser(db, {
      username: "mod_kate",
      role: "moderator",
    });
    await write(0);
    await write(1, { actorUserId: other, actorKind: "moderator" });
    await write(2, { actorUserId: null, actorKind: "job", reason: null });
    expect(
      (await auditPage(db, { who: other })).rows.map((r) => r.who),
    ).toEqual(["mod_kate"]);
    expect(
      (await auditPage(db, { who: "jobs" })).rows.map((r) => r.who),
    ).toEqual(["Job"]);
  });
});
